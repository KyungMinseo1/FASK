// DecisionRAG knowledge search for answers: Jev reads a table of contents (projects and topic
// concepts), opens the promising branches, scores their records, and compares the best few.
// BM25 hits join the leaf stage as extra candidates (a union, not a rerank). Any failure rejects
// and the caller falls back to plain BM25 `recallMemory`.
import type { Concept, Project, Question, Reference } from '../preload/personal'
import { questionHeading } from '../shared/questions'
import type { JevCall, JevQuestion } from './jev-api'
import { memoryItem, type RecallParams, type RecallResult } from './knowledge-extract'
import type { PersonalStore } from './personal-store'

export const BATCH_MAX = 50 // candidates per request: DecisionRAG Fig. 6, gains flatten past 50
export const BATCH_CHARS = 24000 // candidate JSON per request; stays inside the default 64k/32k per-question context
export const BRANCH_KEEP = 6 // branches opened after stage 1
export const BRANCH_FLOOR = 0.1 // minimum stage-1 probability (recall over precision)
export const BRANCH_CHILDREN = 40 // leaves opened per branch
export const LEAF_MAX = 200 // stage-2 candidates in total
export const LEAF_FLOOR = 0.3 // minimum stage-2 probability kept
export const LEAF_EXTRA_FLOOR = 0.5 // minimum probability appended after the final five
export const FINAL_CHOICES = 5
export const BM25_EXTRA = 20
export const MAX_PARALLEL = 4

type Kind = 'concept' | 'question'
interface Branch {
  type: 'project' | 'topic'
  name: string
  summary: string
  leaves: { kind: Kind; id: string }[]
}
interface Candidate {
  kind: Kind
  id: string
  branch: string
  record: Record<string, unknown>
}

export async function jevRecall(
  store: PersonalStore,
  p: RecallParams,
  call: JevCall,
  signal: AbortSignal
): Promise<RecallResult> {
  const empty: RecallResult = { context: [], references: [] }
  const text = p.text.trim()
  if (text.length < 2 || p.budgetChars <= 0) return empty
  const query = text.slice(0, 2000)

  // 1. Corpus, the same scope as the FTS search.
  const completed = (q: Question): Question['turns'][number] | undefined =>
    q.turns.filter((t) => t.status === 'completed').at(-1)
  const eligible = (q: Question): boolean => q.id !== p.questionId && (!!completed(q) || !!q.memo)
  const projects = store
    .list<Project>('project', p.profile)
    .filter((x) => (p.scope === 'project' ? x.id === p.projectId : x.workspaceId === p.workspaceId))
  const projectIds = new Set(projects.map((x) => x.id))
  const questions = store
    .list<Question>('question', p.profile)
    .filter((q) => projectIds.has(q.projectId) && eligible(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const allConcepts = store.list<Concept>('concept', p.profile)
  const conceptById = new Map(allConcepts.map((c) => [c.id, c]))
  let concepts: Concept[]
  if (p.scope === 'workspace') concepts = allConcepts.filter((c) => c.workspaceId === p.workspaceId)
  else {
    const ids = new Set<string>()
    // Linked concepts and their ancestors up to the topic; `ids` also guards parent cycles.
    for (const id of questions.flatMap((q) => q.conceptIds))
      for (
        let a = conceptById.get(id);
        a && !ids.has(a.id);
        a = a.parentId ? conceptById.get(a.parentId) : undefined
      )
        ids.add(a.id)
    concepts = allConcepts.filter((c) => ids.has(c.id))
  }
  const byName = (a: Concept, b: Concept): number => a.name.localeCompare(b.name)
  const children = new Map<string, Concept[]>()
  for (const c of concepts) {
    if (!c.parentId) continue
    const list = children.get(c.parentId)
    if (list) list.push(c)
    else children.set(c.parentId, [c])
  }
  const descendants = (id: string, seen = new Set<string>()): Concept[] =>
    (children.get(id) ?? []).flatMap((c) =>
      seen.has(c.id) ? [] : (seen.add(c.id), [c, ...descendants(c.id, seen)])
    )

  // 2. Branches: projects (workspace → project → question) and topics (topic → concept/detail →
  // linked questions).
  const branches: Branch[] = []
  for (const project of projects) {
    const qs = questions.filter((q) => q.projectId === project.id)
    if (!qs.length) continue
    branches.push({
      type: 'project',
      name: project.name,
      summary: [
        project.description.slice(0, 300),
        ...qs.slice(0, 5).map((q) => `- ${questionHeading(q).slice(0, 60)}`)
      ]
        .filter(Boolean)
        .join('\n'),
      leaves: qs.slice(0, BRANCH_CHILDREN).map((q) => ({ kind: 'question', id: q.id }))
    })
  }
  const inCorpus = new Set(concepts.map((c) => c.id))
  for (const topic of concepts.filter((c) => c.level === 'topic')) {
    const below = descendants(topic.id).sort(byName)
    const ids = new Set([topic.id, ...below.map((c) => c.id)])
    branches.push({
      type: 'topic',
      name: topic.name,
      summary: [
        topic.definition.slice(0, 300),
        ...(children.get(topic.id) ?? []).slice(0, 8).map((c) => `- ${c.name}`)
      ]
        .filter(Boolean)
        .join('\n'),
      leaves: [
        ...below.map((c) => ({ kind: 'concept' as const, id: c.id })),
        ...questions
          .filter((q) => q.conceptIds.some((id) => ids.has(id)))
          .map((q) => ({ kind: 'question' as const, id: q.id }))
      ].slice(0, BRANCH_CHILDREN)
    })
  }
  const topicOf = (c: Concept): Concept | undefined => {
    const seen = new Set<string>()
    let a: Concept | undefined = c
    while (a && a.level !== 'topic' && a.parentId && !seen.has(a.id)) {
      seen.add(a.id)
      a = inCorpus.has(a.parentId) ? conceptById.get(a.parentId) : undefined
    }
    return a?.level === 'topic' ? a : undefined
  }
  const loose = concepts.filter((c) => c.level !== 'topic' && !topicOf(c)).sort(byName)
  if (loose.length)
    branches.push({
      type: 'topic',
      name: '주제 없는 개념',
      summary: loose
        .slice(0, 8)
        .map((c) => `- ${c.name}`)
        .join('\n'),
      leaves: loose.slice(0, BRANCH_CHILDREN).map((c) => ({ kind: 'concept', id: c.id }))
    })
  const live = branches.filter((b) => b.leaves.length)

  const describe = (kind: Kind, id: string): Record<string, unknown> | undefined => {
    try {
      if (kind === 'concept') {
        const c = conceptById.get(id) ?? store.record<Concept>('concept', id, p.profile)
        return {
          kind,
          title: c.name,
          ...(c.aliases.length ? { aliases: c.aliases } : {}),
          ...(c.definition ? { definition: c.definition.slice(0, 400) } : {})
        }
      }
      const q = store.record<Question>('question', id, p.profile)
      if (!eligible(q)) return undefined
      const last = completed(q)
      return {
        kind,
        title: questionHeading(q).slice(0, 80),
        ...(last?.sent ? { question: last.sent.slice(0, 200) } : {}),
        ...(last?.answer ? { answer: last.answer.slice(0, 400) } : {}),
        ...(q.memo ? { memo: q.memo.slice(0, 200) } : {})
      }
    } catch {
      return undefined
    }
  }
  const extras: Candidate[] = []
  for (const hit of store.search(p.profile, query, {
    ...(p.scope === 'project' ? { projectId: p.projectId } : { workspaceId: p.workspaceId }),
    kinds: ['concept', 'question'],
    limit: BM25_EXTRA + 1
  })) {
    if (hit.id === p.questionId || extras.length >= BM25_EXTRA) continue
    const record = describe(hit.kind, hit.id)
    if (record) extras.push({ kind: hit.kind, id: hit.id, branch: 'keyword search', record })
  }
  if (!live.length && !extras.length) return empty

  // 3. Stage 1: pick branches from the table of contents.
  const union = new Set(live.flatMap((b) => b.leaves.map((l) => `${l.kind}:${l.id}`)))
  let picked: Branch[]
  if (live.length <= BRANCH_KEEP || union.size <= BATCH_MAX) picked = live
  else {
    const scored = (
      await mapLimit(
        batches(
          live.map((b) => ({ b, item: { type: b.type, name: b.name, summary: b.summary } })),
          (x) => ({ label: 'b00', ...x.item })
        ),
        MAX_PARALLEL,
        async (group) => {
          const items = group.map((x, i) => ({ label: `b${i + 1}`, ...x.item }))
          const res = await call(
            {
              state: { query, branches: items },
              questions: Object.fromEntries(
                items.map((x): [string, JevQuestion] => [
                  x.label,
                  {
                    type: 'noul',
                    instructions: `The branch labeled ${x.label} in branches probably contains past questions, answers, or concepts that help answer the query.`
                  }
                ])
              )
            },
            signal
          )
          return group.map((x, i) => ({ branch: x.b, score: noul(res.answers[`b${i + 1}`]) }))
        }
      )
    )
      .flat()
      .filter((x) => x.score >= BRANCH_FLOOR)
      .sort((a, b) => b.score - a.score)
    picked = scored.slice(0, BRANCH_KEEP).map((x) => x.branch)
  }

  // 4. Stage-2 candidates: picked branch leaves in branch order, then BM25 extras.
  const seen = new Set<string>()
  const leaves: Candidate[] = []
  for (const b of picked)
    for (const l of b.leaves) {
      const k = `${l.kind}:${l.id}`
      if (seen.has(k)) continue
      seen.add(k)
      const record = describe(l.kind, l.id)
      if (record) leaves.push({ ...l, branch: b.name, record })
    }
  const extra = extras.filter((c) => !seen.has(`${c.kind}:${c.id}`))
  const candidates = [...leaves.slice(0, Math.max(0, LEAF_MAX - extra.length)), ...extra].slice(
    0,
    LEAF_MAX
  )
  if (!candidates.length) return empty

  // 5. Stage 2: score each record.
  const scored = (
    await mapLimit(
      batches(candidates, (c) => ({ label: 'r00', branch: c.branch, ...c.record })),
      MAX_PARALLEL,
      async (group) => {
        const records = group.map((c, i) => ({ label: `r${i + 1}`, branch: c.branch, ...c.record }))
        const res = await call(
          {
            state: { query, records },
            questions: Object.fromEntries(
              records.map((r): [string, JevQuestion] => [
                r.label,
                {
                  type: 'noul',
                  instructions: `The record labeled ${r.label} in records contains knowledge that directly helps answer the query.`
                }
              ])
            )
          },
          signal
        )
        return group.map((c, i) => ({ c, score: noul(res.answers[`r${i + 1}`]) }))
      }
    )
  )
    .flat()
    .filter((x) => x.score >= LEAF_FLOOR)
    .sort((a, b) => b.score - a.score)

  // 6. Stage 3: compare the best few directly.
  let final = scored
  if (scored.length >= 2) {
    const top = scored.slice(0, FINAL_CHOICES)
    const records = top.map((x, i) => ({ label: `r${i + 1}`, branch: x.c.branch, ...x.c.record }))
    const res = await call(
      {
        state: { query, records },
        questions: {
          best: {
            type: 'choice',
            instructions: 'Which record helps most to answer the query?',
            criteria: Object.fromEntries(top.map((x, i) => [`r${i + 1}`, String(x.c.record.title)]))
          }
        }
      },
      signal
    )
    const answer = res.answers.best
    const probabilities = answer?.type === 'choice' ? answer.probabilities : {}
    const prob = (i: number): number => {
      const v = probabilities[`r${i + 1}`]
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    }
    const ranked = top
      .map((x, i) => ({ x, p: prob(i) }))
      .sort((a, b) => b.p - a.p)
      .map((r) => r.x)
    final = [...ranked, ...scored.slice(FINAL_CHOICES).filter((x) => x.score >= LEAF_EXTRA_FLOOR)]
  }

  // 7. The same items and budget rule as `recallMemory`.
  const context: unknown[] = []
  const references: Reference[] = []
  let used = 0
  for (const { c } of final) {
    const found = memoryItem(store, c.kind, c.id, p.profile)
    if (!found) continue
    const size = JSON.stringify(found.item).length
    if (used + size > p.budgetChars) continue
    used += size
    context.push(found.item)
    references.push({ kind: c.kind, id: c.id, name: found.name })
  }
  return { context, references }
}

function noul(answer: unknown): number {
  if (
    !answer ||
    typeof answer !== 'object' ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number'
  )
    throw new Error('Jev 응답 형식이 잘못되었습니다.')
  return answer.noul
}

/** Consecutive groups of at most BATCH_MAX items and BATCH_CHARS of item JSON (an oversized item goes alone). */
function batches<T>(items: T[], payload: (item: T) => unknown): T[][] {
  const groups: T[][] = []
  let group: T[] = [],
    chars = 0
  for (const item of items) {
    const size = JSON.stringify(payload(item)).length
    if (group.length && (group.length >= BATCH_MAX || chars + size > BATCH_CHARS)) {
      groups.push(group)
      group = []
      chars = 0
    }
    group.push(item)
    chars += size
  }
  if (group.length) groups.push(group)
  return groups
}

/** Runs `fn` over `items` with at most `limit` in flight; the first failure rejects the whole. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

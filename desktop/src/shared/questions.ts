// Pure question-model helpers shared by main, renderer, and mobile. No Node or DOM APIs.
import type { Question, TextAttachment, Turn, TurnState, TurnStatus } from '../preload/personal'

/** 1.0.x record: one question per follow-up, grouped only by conversationId. */
export interface LegacyQuestion {
  id: string
  projectId: string
  conversationId: string
  createdAt: string
  title?: string
  documents?: TextAttachment[]
  raw: string
  refined: string
  sent: string
  answer: string
  model: string
  actualModel: string
  status: TurnStatus
  complexity: 'simple' | 'complex' | 'unknown'
  routingReason: string
  conceptIds: string[]
  suggestions: string[]
  memo: string
  important: boolean
  attachment: string | null
  error: string
}

const STATUSES: readonly TurnStatus[] = ['saved', 'running', 'completed', 'failed', 'cancelled']
const COMPLEXITIES = ['simple', 'complex', 'unknown'] as const

export function lastTurn(q: Question): Turn {
  return q.turns[q.turns.length - 1]
}
/** True when `prev`'s running last turn is now completed in `next` (same turn id). */
export function answerJustCompleted(prev: Question | undefined, next: Question | undefined): boolean {
  if (!prev || !next) return false
  const before = lastTurn(prev)
  if (!before || before.status !== 'running') return false
  return next.turns.some((t) => t.id === before.id && t.status === 'completed')
}
export function questionStatus(q: Question): TurnStatus {
  return lastTurn(q).status
}
export function questionComplexity(q: Question): Turn['complexity'] {
  return q.turns.some((t) => t.complexity === 'complex') ? 'complex' : q.turns[0].complexity
}
export function questionHeading(q: Question): string {
  return q.title || q.turns[0].sent
}
export function questionSearchText(q: Question): string {
  return [
    q.title ?? '',
    ...q.turns.flatMap((t) => [
      t.raw,
      t.sent,
      t.answer,
      ...t.documents.flatMap((d) => [d.name, d.text])
    ]),
    q.memo
  ].join(' ')
}
export function questionImages(q: Question): string[] {
  return q.turns.flatMap((t) => (t.attachment ? [t.attachment] : []))
}
export function filterQuestions(questions: Question[], filter: string, query: string): Question[] {
  const needle = query.toLocaleLowerCase()
  return questions.filter(
    (q) =>
      (filter === 'all' ||
        (filter === 'important'
          ? q.important
          : filter === 'unfiled'
            ? !q.conceptIds.length
            : filter === 'failed'
              ? questionStatus(q) === 'failed'
              : questionComplexity(q) === filter)) &&
      questionSearchText(q).toLocaleLowerCase().includes(needle)
  )
}

export const QUESTIONS_PER_PAGE = 20
/** page를 1..pages로 보정하고 해당 페이지 항목을 돌려준다. 빈 목록도 pages는 1. */
export function pageSlice<T>(
  items: T[],
  page: number,
  size = QUESTIONS_PER_PAGE
): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  return { items: items.slice((current - 1) * size, current * size), page: current, pages }
}
/** 페이지 버튼 목록. pages ≤ 7이면 전부, 아니면 1, page-1..page+1, pages이며 번호가 건너뛰는 곳에 'gap'. */
export function pageWindow(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const nums = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b)
  const out: (number | 'gap')[] = []
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push('gap')
    out.push(n)
  })
  return out
}

export type LiveAnswer = { turnId: string; answer: string; revision: number }

export function applyDelta(
  live: LiveAnswer,
  e: { turnId: string; revision: number; delta: string }
): { live: LiveAnswer; resync: boolean } {
  const base = e.turnId === live.turnId ? live : { turnId: e.turnId, answer: '', revision: 0 }
  if (e.revision === base.revision + 1)
    return {
      live: { turnId: e.turnId, answer: base.answer + e.delta, revision: e.revision },
      resync: false
    }
  if (e.revision <= base.revision) return { live: base, resync: false }
  return { live: base, resync: true }
}
export function mergeLive(live: LiveAnswer, next: LiveAnswer, currentTurnId: string): LiveAnswer {
  if (next.turnId !== live.turnId) return next.turnId === currentTurnId ? next : live
  return next.revision > live.revision ? next : live
}
export function reconcileTurnState(
  live: LiveAnswer,
  state: TurnState,
  turnId: string,
  currentTurnId: string
): {
  live: LiveAnswer
  finished: {
    status: 'saved' | 'completed' | 'failed' | 'cancelled'
    error: string
    actualModel: string
  } | null
} {
  if (turnId !== currentTurnId) return { live, finished: null }
  const next = mergeLive(
    live,
    { turnId, answer: state.answer, revision: state.revision },
    currentTurnId
  )
  return {
    live: next,
    finished:
      state.status !== 'running' && state.revision >= next.revision
        ? { status: state.status, error: state.error, actualModel: state.actualModel }
        : null
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export function normalizeLegacyQuestion(r: unknown): LegacyQuestion {
  const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    typeof o.projectId !== 'string' ||
    typeof o.conversationId !== 'string'
  )
    throw new Error('레거시 질문 형식이 잘못되었습니다.')
  const parsed = typeof o.createdAt === 'string' ? Date.parse(o.createdAt) : NaN
  const raw = text(o.raw)
  const documents: TextAttachment[] = []
  let total = 0
  if (Array.isArray(o.documents))
    for (const d of o.documents) {
      if (!d || typeof d.name !== 'string' || typeof d.text !== 'string') continue
      if (documents.length >= 5) break
      const doc = { name: d.name.slice(0, 255), text: d.text.slice(0, 50000) }
      if (total + doc.text.length > 100000) break
      total += doc.text.length
      documents.push(doc)
    }
  const q: LegacyQuestion = {
    id: o.id,
    projectId: o.projectId,
    conversationId: o.conversationId,
    createdAt: Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : '1970-01-01T00:00:00.000Z',
    documents,
    raw,
    refined: text(o.refined),
    sent: text(o.sent) || raw || '(질문 내용 없음)',
    answer: text(o.answer),
    model: text(o.model),
    actualModel: text(o.actualModel),
    status: STATUSES.includes(o.status as TurnStatus) ? (o.status as TurnStatus) : 'failed',
    complexity: COMPLEXITIES.includes(o.complexity as Turn['complexity'])
      ? (o.complexity as Turn['complexity'])
      : 'unknown',
    routingReason: text(o.routingReason),
    conceptIds: strings(o.conceptIds),
    suggestions: strings(o.suggestions),
    memo: text(o.memo),
    important: o.important === true,
    attachment: typeof o.attachment === 'string' ? o.attachment : null,
    error: text(o.error)
  }
  if (typeof o.title === 'string' && o.title.length >= 1 && o.title.length <= 200)
    q.title = o.title
  return q
}

export function mergeLegacyQuestions(records: LegacyQuestion[]): Question[] {
  const groups = new Map<string, LegacyQuestion[]>()
  for (const record of records) {
    const r = normalizeLegacyQuestion(record)
    const key = r.projectId + '\u0000' + r.conversationId
    const group = groups.get(key)
    if (group) group.push(r)
    else groups.set(key, [r])
  }
  return [...groups.values()].map((group) => {
    // Array.prototype.sort is stable: equal timestamps keep input (rowid) order.
    const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const first = sorted[0]
    const question: Question = {
      id: first.id,
      projectId: first.projectId,
      createdAt: first.createdAt,
      turns: sorted.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        raw: r.raw,
        refined: r.refined,
        sent: r.sent,
        answer: r.answer,
        model: r.model,
        actualModel: r.actualModel,
        status: r.status,
        complexity: r.complexity,
        routingReason: r.routingReason,
        attachment: r.attachment,
        documents: r.documents ?? [],
        error: r.error,
        revision: 0
      })),
      conceptIds: [...new Set(sorted.flatMap((r) => r.conceptIds))],
      conceptTurns: {},
      // Existing data is not auto re-extracted; re-organizing it is the user-triggered tidy.
      extractedTurns: sorted.length,
      suggestions: [...new Set(sorted.flatMap((r) => r.suggestions))].slice(0, 10),
      memo: sorted
        .map((r) => r.memo)
        .filter(Boolean)
        .join('\n\n'),
      important: sorted.some((r) => r.important)
    }
    const title = sorted.find((r) => r.title)?.title
    if (title) question.title = title
    return question
  })
}

export function cleanTitle(input: string): string {
  let title = input.split(/\r?\n/).find((l) => l.trim()) ?? ''
  // Markers, labels, and quotes can wrap each other ("제목: …."), so peel until stable.
  for (let previous = ''; previous !== title; ) {
    previous = title
    title = title
      .replace(/^[#\-*\s]+/, '')
      .replace(/^(제목|title)\s*:\s*/i, '')
      .replace(/^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g, '')
      .replace(/[.。]+$/, '')
      .trim()
  }
  return title.replace(/\s+/g, ' ').slice(0, 60)
}

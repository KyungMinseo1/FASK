// Test-build demo hub (`apk:test` only): an in-memory PC with sample projects, concepts and
// answered questions, so every phone screen can be checked without pairing. Nothing persists.
import type {
  Concept,
  Question,
  Relation,
  Snapshot,
  StreamEvent,
  TidyChange,
  TidyJob,
  TidyRef,
  TidyResult,
  Turn,
  TurnState
} from '@desktop/preload/personal'
import type { HubClient } from './hub'
import type { Pairing } from './transport'

export const demoAvailable = (): boolean => import.meta.env.MODE === 'pairing-test'

/** Placeholder identity; never stored and never sent to a real transport. */
export const DEMO_PAIRING: Pairing = {
  addresses: ['demo.invalid'],
  port: 0,
  fingerprint: 'demo',
  token: 'demo'
}

const MODEL = 'demo-model'
const PROFILE = 'demo-profile'
const IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#f4f4fb"/>' +
      '<rect x="40" y="40" width="400" height="190" rx="12" fill="#fff" stroke="#c9c7ef"/>' +
      '<text x="70" y="110" font-size="28" font-family="serif">T(n) = 2T(n/2) + n</text>' +
      '<path d="M66 128 Q200 150 330 124" stroke="#6b5bd6" stroke-width="4" fill="none"/>' +
      '<text x="70" y="180" font-size="20" fill="#666">= O(n log n) ?</text></svg>'
  )

function turn(over: Partial<Turn> & Pick<Turn, 'id' | 'createdAt' | 'raw'>): Turn {
  return {
    refined: '',
    sent: over.refined || over.raw,
    answer: '',
    model: MODEL,
    actualModel: MODEL,
    status: 'completed',
    complexity: 'simple',
    routingReason: '',
    attachment: null,
    documents: [],
    error: '',
    revision: 1,
    ...over
  }
}

function seed(): { data: Snapshot; images: Map<string, string> } {
  const day = (n: number, h = 10): string =>
    new Date(Date.now() - n * 86_400_000 - (12 - h) * 3_600_000).toISOString()
  const concept = (
    id: string,
    name: string,
    parentId: string | null,
    level: Concept['level'],
    definition = '',
    aliases: string[] = []
  ): Concept => ({ id, workspaceId: 'w-sem', name, parentId, manual: false, aliases, definition, level })
  const concepts: Concept[] = [
    concept('c-sort', '정렬', null, 'topic', '원소를 정해진 순서로 나열하는 알고리즘'),
    concept('c-merge', '병합 정렬', 'c-sort', 'concept', '반으로 나눠 정렬한 뒤 합치는 분할 정복 정렬', ['merge sort']),
    concept('c-quick', '퀵 정렬', 'c-sort', 'concept', '피벗을 기준으로 나누는 정렬', ['quick sort']),
    concept('c-tree', '트리', null, 'topic'),
    { ...concept('c-heap', '힙', 'c-tree', 'concept', '부모가 자식보다 항상 작거나 큰 완전 이진 트리'), manual: true },
    concept('c-queue', '큐', null, 'concept', '먼저 들어온 원소가 먼저 나가는 자료구조', ['queue']),
    concept('c-sched', '스케줄링', null, 'topic'),
    concept('c-dead', '교착 상태', null, 'concept', '', ['deadlock'])
  ]
  const relations: Relation[] = [
    {
      id: 'r-merge-quick',
      workspaceId: 'w-sem',
      from: 'c-merge',
      to: 'c-quick',
      type: 'contrast',
      questionId: 'q-merge',
      turnIds: ['t-merge-2'],
      confidence: 0.9,
      approved: true,
      createdAt: day(0, 10),
      invalidatedAt: null
    },
    {
      id: 'r-sched-queue',
      workspaceId: 'w-sem',
      from: 'c-sched',
      to: 'c-queue',
      type: 'uses',
      questionId: 'q-rr',
      turnIds: ['t-rr-1'],
      confidence: 0.8,
      approved: true,
      createdAt: day(3),
      invalidatedAt: null
    },
    {
      id: 'r-queue-heap',
      workspaceId: 'w-sem',
      from: 'c-queue',
      to: 'c-heap',
      type: 'prerequisite',
      questionId: 'q-heap',
      turnIds: ['t-heap-1'],
      confidence: 0.5,
      approved: false,
      createdAt: day(1),
      invalidatedAt: null
    }
  ]
  const questions: Question[] = [
    {
      id: 'q-merge',
      projectId: 'p-ds',
      createdAt: day(0, 9),
      title: '병합 정렬 시간 복잡도',
      conceptIds: ['c-merge', 'c-quick'],
      conceptTurns: { 'c-merge': ['t-merge-1'], 'c-quick': ['t-merge-2'] },
      extractedTurns: 2,
      suggestions: ['분할 정복'],
      memo: '시험 범위. 점화식 풀이 다시 보기',
      important: true,
      turns: [
        turn({
          id: 't-merge-1',
          createdAt: day(0, 9),
          raw: '이 점화식이 왜 n log n 이 되는지 모르겠어요',
          refined: '병합 정렬 점화식 T(n) = 2T(n/2) + n 이 O(n log n)이 되는 이유는?',
          attachment: 'img-merge',
          answer:
            '## 핵심\n\n재귀 트리로 보면 됩니다.\n\n1. 각 단계에서 **합치는 비용의 합은 n**입니다.\n2. 배열을 반씩 나누므로 단계 수는 **log₂ n**입니다.\n\n따라서 전체 비용은 $n \\times \\log n$ 입니다.\n\n```text\nn            → n\nn/2 + n/2    → n\n... (log n 단계)\n```'
        }),
        turn({
          id: 't-merge-2',
          createdAt: day(0, 10),
          raw: '그럼 퀵 정렬은 왜 최악이 n² 인가요?',
          references: [
            { kind: 'concept', id: 'c-merge', name: '병합 정렬' },
            { kind: 'question', id: 'q-heap', name: '힙과 우선순위 큐 차이' }
          ],
          answer:
            '피벗이 매번 최솟값이나 최댓값이면 한쪽 부분 배열이 비어서 단계 수가 **n**이 됩니다. 각 단계 비용이 n이므로 최악은 $O(n^2)$ 입니다.\n\n- 무작위 피벗을 쓰면 기대 시간은 $O(n \\log n)$\n- 이미 정렬된 입력에서 첫 원소를 피벗으로 쓰면 최악이 됩니다.'
        })
      ]
    },
    {
      id: 'q-heap',
      projectId: 'p-ds',
      createdAt: day(1),
      title: '힙과 우선순위 큐 차이',
      conceptIds: ['c-heap', 'c-queue'],
      conceptTurns: { 'c-heap': ['t-heap-1'], 'c-queue': ['t-heap-1'] },
      conceptRoles: { 'c-heap': 'focus', 'c-queue': 'support' },
      conceptSources: { 'c-heap': 'model', 'c-queue': 'model' },
      extractedTurns: 1,
      suggestions: [],
      memo: '',
      important: false,
      turns: [
        turn({
          id: 't-heap-1',
          createdAt: day(1),
          raw: '힙이랑 우선순위 큐가 같은 건가요?',
          answer:
            '우선순위 큐는 **추상 자료형**이고, 힙은 그것을 구현하는 **자료구조** 중 하나입니다.\n\n| 연산 | 이진 힙 |\n| --- | --- |\n| 삽입 | O(log n) |\n| 최솟값 꺼내기 | O(log n) |\n| 최솟값 확인 | O(1) |'
        })
      ]
    },
    {
      id: 'q-saved',
      projectId: 'p-ds',
      createdAt: day(2),
      title: '나중에 물어볼 질문',
      conceptIds: [],
      conceptTurns: {},
      extractedTurns: 0,
      suggestions: ['트리'],
      memo: '',
      important: false,
      turns: [
        turn({
          id: 't-saved-1',
          createdAt: day(2),
          raw: 'AVL 트리 회전 4가지 경우 정리',
          status: 'saved',
          revision: 0
        })
      ]
    },
    {
      id: 'q-rr',
      projectId: 'p-os',
      createdAt: day(3),
      title: '라운드 로빈 타임 퀀텀',
      conceptIds: ['c-sched', 'c-queue'],
      conceptTurns: { 'c-sched': ['t-rr-1'], 'c-queue': ['t-rr-1'] },
      conceptRoles: { 'c-sched': 'focus', 'c-queue': 'support' },
      conceptSources: { 'c-sched': 'model', 'c-queue': 'model' },
      extractedTurns: 1,
      suggestions: [],
      memo: '',
      important: false,
      turns: [
        turn({
          id: 't-rr-1',
          createdAt: day(3),
          raw: '타임 퀀텀이 너무 크면 어떻게 되나요?',
          answer: '타임 퀀텀이 충분히 크면 라운드 로빈은 사실상 **FCFS**와 같아집니다. 반대로 너무 작으면 문맥 교환 비용이 커집니다.'
        }),
        turn({
          id: 't-rr-2',
          createdAt: day(3, 11),
          raw: '적당한 값은 어떻게 정하나요?',
          status: 'failed',
          error: '데모: AI 응답 시간이 초과되었습니다.',
          answer: ''
        })
      ]
    }
  ]
  return {
    images: new Map([['img-merge', IMAGE]]),
    data: {
      profiles: [{ id: PROFILE, name: '데모 학생' }],
      activeProfileId: PROFILE,
      workspaces: [
        { id: 'w-sem', profileId: PROFILE, name: '2학기' },
        { id: 'w-self', profileId: PROFILE, name: '개인 공부' }
      ],
      projects: [
        { id: 'p-ds', workspaceId: 'w-sem', name: '자료구조', description: '정렬, 트리, 그래프' },
        { id: 'p-os', workspaceId: 'w-sem', name: '운영체제', description: '' },
        { id: 'p-la', workspaceId: 'w-self', name: '선형대수 스터디', description: '' }
      ],
      concepts,
      relations,
      questions,
      settings: {
        endpoint: 'demo',
        hasKey: true,
        model: MODEL,
        fastModel: MODEL,
        deepModel: MODEL,
        models: [MODEL],
        routing: 'manual',
        refine: true,
        organize: true,
        memoryScope: 'project',
        memoryTokens: 1500,
        extractDelaySec: 120,
        organizeModel: '',
        promptLanguage: 'ko',
        retention: 'balanced',
        autoTitle: true,
        regions: []
      },
      storageBytes: 1_250_000
    }
  }
}

const ANSWER =
  '데모 답변입니다. 실제 연결에서는 PC의 FASK가 이 질문에 답변합니다.\n\n' +
  '- 답변은 이렇게 **스트리밍**됩니다.\n- 이어서 질문하면 같은 대화에 기록됩니다.\n\n' +
  '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$'

export function createDemoHub(): HubClient {
  const { data, images } = seed()
  const streams = new Set<(e: StreamEvent) => void>()
  const changes = new Set<() => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  const changed = (): void => changes.forEach((cb) => cb())
  let seq = 0
  const id = (prefix: string): string => `${prefix}-${++seq}-${Date.now().toString(36)}`
  const question = (qid: string): Question => {
    const q = data.questions.find((x) => x.id === qid)
    if (!q) throw new Error('질문을 찾을 수 없습니다.')
    return q
  }
  const findTurn = (turnOrRequest: string): { q: Question; turn: Turn } | undefined => {
    for (const q of data.questions)
      for (const turn of q.turns) if (turn.id === turnOrRequest) return { q, turn }
    return undefined
  }
  const requests = new Map<string, string>()
  const stop = (turnId: string): void => {
    timers.get(turnId)?.forEach(clearTimeout)
    timers.delete(turnId)
  }
  const workspaceOf = (projectId: string): string =>
    data.projects.find((p) => p.id === projectId)?.workspaceId ?? ''
  const removeConcepts = (ids: Set<string>): void => {
    data.concepts = data.concepts.filter((c) => !ids.has(c.id))
    data.relations = data.relations.filter((r) => !ids.has(r.from) && !ids.has(r.to))
    for (const q of data.questions) {
      q.conceptIds = q.conceptIds.filter((c) => !ids.has(c))
      for (const c of ids) {
        delete q.conceptTurns[c]
        delete q.conceptRoles?.[c]
        delete q.conceptSources?.[c]
      }
    }
  }
  const removeProjects = (ids: Set<string>): void => {
    data.projects = data.projects.filter((p) => !ids.has(p.id))
    for (const q of data.questions) if (ids.has(q.projectId)) q.turns.forEach((x) => stop(x.id))
    data.questions = data.questions.filter((q) => !ids.has(q.projectId))
  }
  // Demo tidy: parentless concepts are the candidates; the preview proposes fixed changes for the
  // seeded ones, and applying marks the rest as reviewed (like the PC's tidy). Nothing is re-judged.
  const orphans = (workspaceId: string): Concept[] =>
    data.concepts.filter((c) => c.workspaceId === workspaceId && c.level !== 'topic' && !c.parentId && !c.tidyReviewed)
  let job: (TidyJob & { workspaceId: string }) | null = null
  let lastApplied: string | null = null

  return {
    snapshot: async () => structuredClone(data),
    create: async (kind, name, parentId) => {
      const newId = id(kind)
      if (kind === 'profile') data.profiles.push({ id: newId, name })
      else if (kind === 'workspace')
        data.workspaces.push({ id: newId, profileId: data.activeProfileId, name })
      else if (kind === 'project')
        data.projects.push({ id: newId, workspaceId: parentId ?? data.workspaces[0]?.id ?? '', name, description: '' })
      else {
        const workspaceId = workspaceOf(parentId ?? '')
        const same = data.concepts.find(
          (c) => c.workspaceId === workspaceId && (c.name === name || c.aliases.includes(name))
        )
        if (same) return same.id
        data.concepts.push({
          id: newId,
          workspaceId,
          name,
          parentId: null,
          manual: true,
          aliases: [],
          definition: '',
          level: 'concept'
        })
      }
      changed()
      return newId
    },
    rename: async (kind, target, name) => {
      const list =
        kind === 'profile'
          ? data.profiles
          : kind === 'workspace'
            ? data.workspaces
            : kind === 'project'
              ? data.projects
              : kind === 'concept'
                ? data.concepts
                : null
      if (list) {
        const item = list.find((x) => x.id === target)
        if (item) item.name = name
      } else question(target).title = name
      changed()
    },
    remove: async (kind, target) => {
      if (kind === 'question') {
        question(target).turns.forEach((x) => stop(x.id))
        data.questions = data.questions.filter((q) => q.id !== target)
      } else if (kind === 'concept') {
        const ids = new Set([target])
        for (let grew = true; grew; ) {
          grew = false
          for (const c of data.concepts)
            if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) grew = !!ids.add(c.id)
        }
        removeConcepts(ids)
      } else if (kind === 'project') removeProjects(new Set([target]))
      else if (kind === 'workspace') {
        removeProjects(new Set(data.projects.filter((p) => p.workspaceId === target).map((p) => p.id)))
        removeConcepts(new Set(data.concepts.filter((c) => c.workspaceId === target).map((c) => c.id)))
        data.workspaces = data.workspaces.filter((w) => w.id !== target)
      } else throw new Error('데모에서는 프로필을 삭제할 수 없습니다.')
      changed()
    },
    moveQuestion: async (qid, projectId) => {
      const q = question(qid)
      if (workspaceOf(q.projectId) === workspaceOf(projectId)) q.projectId = projectId
      else {
        Object.assign(q, { projectId, conceptIds: [], conceptTurns: {}, suggestions: [] })
        delete q.conceptRoles
        delete q.conceptSources
        delete q.tidyStay
      }
      changed()
    },
    updateQuestion: async (qid, patch) => {
      const q = question(qid)
      const before = new Set(q.conceptIds)
      Object.assign(q, patch)
      // Like the PC store: links the user adds are user focus tags; dropped links lose their entries.
      const roles = { ...q.conceptRoles },
        sources = { ...q.conceptSources }
      for (const c of Object.keys(roles)) if (!q.conceptIds.includes(c)) delete roles[c]
      for (const c of Object.keys(sources)) if (!q.conceptIds.includes(c)) delete sources[c]
      for (const c of q.conceptIds)
        if (!before.has(c)) {
          roles[c] = 'focus'
          sources[c] = 'user'
        }
      q.conceptRoles = roles
      q.conceptSources = sources
      changed()
    },
    editConcept: async (cid, name, parentId) => {
      const c = data.concepts.find((x) => x.id === cid)
      if (c) Object.assign(c, { name, parentId })
      changed()
    },
    mergeConcept: async (source, target) => {
      for (const c of data.concepts) if (c.parentId === source) c.parentId = target
      for (const r of data.relations) {
        if (r.from === source) r.from = target
        if (r.to === source) r.to = target
      }
      data.relations = data.relations.filter((r) => r.from !== r.to)
      for (const q of data.questions) {
        if (q.conceptIds.includes(source)) {
          const both = q.conceptIds.includes(target)
          q.conceptIds = [...new Set(q.conceptIds.map((c) => (c === source ? target : c)))]
          // Focus (or no entry, which counts as focus) wins; 'user' beats 'model' beats unknown.
          const roleA = q.conceptRoles?.[source],
            roleB = both ? q.conceptRoles?.[target] : undefined
          const hadRole = roleA !== undefined || roleB !== undefined
          const role = (both && roleB !== 'support') || roleA !== 'support' ? 'focus' : 'support'
          const srcA = q.conceptSources?.[source],
            srcB = both ? q.conceptSources?.[target] : undefined
          const src = srcA === 'user' || srcB === 'user' ? 'user' : (srcA ?? srcB)
          if (q.conceptRoles) delete q.conceptRoles[source]
          if (q.conceptSources) delete q.conceptSources[source]
          if (hadRole) q.conceptRoles = { ...q.conceptRoles, [target]: role }
          if (src) q.conceptSources = { ...q.conceptSources, [target]: src }
        }
        const turns = q.conceptTurns[source]
        if (turns) {
          q.conceptTurns[target] = [...new Set([...(q.conceptTurns[target] ?? []), ...turns])]
          delete q.conceptTurns[source]
        }
      }
      data.concepts = data.concepts.filter((c) => c.id !== source)
      changed()
    },
    editConceptInfo: async (cid, patch) => {
      const c = data.concepts.find((x) => x.id === cid)
      if (c) Object.assign(c, patch)
      changed()
    },
    setRelation: async (rid, action) => {
      const r = data.relations.find((x) => x.id === rid)
      if (r && action === 'approve') r.approved = true
      else if (r) r.invalidatedAt = new Date().toISOString()
      changed()
    },
    focusQuestion: async () => {},
    tidyPlan: async (workspaceId) => {
      const open = orphans(workspaceId)
      const n = open.length
      return {
        candidates: n,
        retag: 0,
        estimatedTokens: n * 400,
        items: open.map((c) => ({ kind: 'orphan' as const, concept: { id: c.id, name: c.name } }))
      }
    },
    tidyStart: async (workspaceId) => {
      if (job?.workspaceId === workspaceId && job.state === 'running') {
        const { workspaceId: _, ...view } = job
        return structuredClone(view)
      }
      const current: TidyJob & { workspaceId: string } = {
        id: id('tidy'),
        workspaceId,
        state: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        progress: { done: 0, total: 0 },
        proposal: null,
        error: ''
      }
      job = current
      changed()
      setTimeout(() => {
        if (job !== current) return
        const open = orphans(workspaceId)
        const ref = (c: Concept): TidyRef => ({ id: c.id, name: c.name })
        const queue = open.find((c) => c.id === 'c-queue'),
          dead = open.find((c) => c.id === 'c-dead'),
          sched = data.concepts.find((c) => c.id === 'c-sched')
        const changes: TidyChange[] = []
        if (queue)
          changes.push({
            kind: 'newParent',
            name: '자료구조',
            level: 'topic',
            parent: null,
            children: [{ concept: ref(queue), from: null, levelFrom: queue.level, levelTo: 'concept' }]
          })
        if (dead && sched)
          changes.push({ kind: 'move', concept: ref(dead), from: null, to: ref(sched), levelFrom: dead.level, levelTo: 'concept' })
        Object.assign(current, { state: 'ready', finishedAt: Date.now(), proposal: { id: current.id, changes, retag: 0 } })
        changed()
      }, 900)
      const { workspaceId: __, ...view } = current
      return structuredClone(view)
    },
    tidyStatus: async (workspaceId) => {
      if (job?.workspaceId !== workspaceId) return { access: 'owner', job: null, lastApplied }
      const { workspaceId: _, ...view } = job
      return { access: 'owner', job: structuredClone(view), lastApplied }
    },
    tidyClear: async (workspaceId, jobId) => {
      if (job?.workspaceId === workspaceId && job.id === jobId && job.state === 'failed') {
        job = null
        changed()
      }
    },
    tidyManagerRequest: async () => {},
    tidyApply: async (workspaceId, proposalId, accepted, dismissed) => {
      if (job?.workspaceId !== workspaceId || job.proposal?.id !== proposalId)
        throw new Error('정리 제안이 만료되었습니다. 정리 제안을 다시 확인해 주세요.')
      const proposed = job.proposal.changes
      lastApplied = job.id
      job = null
      const result: TidyResult = {
        merged: 0,
        folded: 0,
        demoted: 0,
        renamed: 0,
        promoted: 0,
        parents: 0,
        moved: 0,
        unrelated: 0,
        retagged: 0,
        movedQuestions: 0,
        skipped: []
      }
      const find = (r: TidyRef): Concept | undefined => data.concepts.find((c) => c.id === r.id)
      proposed.forEach((change, i) => {
        if (!accepted.includes(i)) return
        if (change.kind === 'newParent') {
          const parentId = id('concept')
          const level = change.level
          data.concepts.push({ id: parentId, workspaceId, name: change.name, parentId: null, manual: false, aliases: [], definition: '', level })
          result.parents++
          for (const p of change.children) Object.assign(find(p.concept) ?? {}, { parentId, level: p.levelTo })
          result.moved += change.children.length
        } else if (change.kind === 'move' && find(change.concept) && find(change.to)) {
          Object.assign(find(change.concept) ?? {}, { parentId: change.to.id, level: change.levelTo })
          result.moved++
        } else result.skipped.push(i)
      })
      // Skipped changes (neither accepted nor dismissed) leave their subjects to be offered again.
      const skip = new Set<string>()
      proposed.forEach((change, i) => {
        if (accepted.includes(i) || dismissed.includes(i)) return
        if (change.kind === 'newParent') {
          for (const p of change.children) if (p.concept.id) skip.add(p.concept.id)
        } else if (change.kind === 'move' && change.concept.id) skip.add(change.concept.id)
      })
      for (const c of orphans(workspaceId)) if (!skip.has(c.id)) c.tidyReviewed = `|${c.level}|`
      changed()
      return result
    },
    ask: async (input) => {
      const known = requests.get(input.requestId)
      if (known) {
        const found = findTurn(known)
        if (found) return { questionId: found.q.id, turnId: found.turn.id }
      }
      let q = input.questionId ? question(input.questionId) : undefined
      if (!q) {
        q = {
          id: id('question'),
          projectId: input.projectId,
          createdAt: new Date().toISOString(),
          title: (input.refined || input.raw).trim().slice(0, 40) || '이미지 질문',
          turns: [],
          conceptIds: [],
          conceptTurns: {},
          extractedTurns: 0,
          suggestions: [],
          memo: '',
          important: false
        }
        data.questions.unshift(q)
      }
      let attachment: string | null = null
      if (input.image) {
        attachment = id('img')
        images.set(attachment, input.image)
      }
      const t: Turn = turn({
        id: id('turn'),
        createdAt: new Date().toISOString(),
        raw: input.raw,
        refined: input.refined ?? '',
        model: input.model,
        actualModel: input.model,
        status: input.saveOnly ? 'saved' : 'running',
        attachment,
        documents: input.documents ?? [],
        revision: 0
      })
      q.turns.push(t)
      requests.set(input.requestId, t.id)
      const base = { requestId: input.requestId, questionId: q.id, turnId: t.id }
      if (!input.saveOnly) {
        const chunks = ANSWER.match(/[^]{1,10}/g) ?? []
        timers.set(
          t.id,
          chunks.map((delta, i) =>
            setTimeout(() => {
              t.answer += delta
              t.revision++
              streams.forEach((cb) => cb({ ...base, revision: t.revision, delta }))
              if (i < chunks.length - 1) return
              timers.delete(t.id)
              t.status = 'completed'
              t.revision++
              streams.forEach((cb) => cb({ ...base, revision: t.revision, done: true }))
              changed()
            }, 400 + i * 70)
          )
        )
      }
      changed()
      return { questionId: q.id, turnId: t.id }
    },
    cancel: async (target) => {
      const found = findTurn(requests.get(target) ?? target)
      if (!found || found.turn.status !== 'running') return
      stop(found.turn.id)
      found.turn.status = 'cancelled'
      found.turn.revision++
      streams.forEach((cb) =>
        cb({ requestId: target, questionId: found.q.id, turnId: found.turn.id, revision: found.turn.revision, done: true })
      )
      changed()
    },
    turnState: async (qid, turnId): Promise<TurnState> => {
      const t = question(qid).turns.find((x) => x.id === turnId)
      if (!t) throw new Error('대화 항목을 찾을 수 없습니다.')
      return { answer: t.answer, revision: t.revision, status: t.status, error: t.error, actualModel: t.actualModel }
    },
    refine: async (raw) => {
      await new Promise((r) => setTimeout(r, 500))
      const text = raw.split('\n첨부파일:')[0].trim()
      return text ? `${text.replace(/[?？.\s]+$/, '')}에 대해 개념과 예시를 들어 설명해 주세요.` : '첨부한 화면의 내용을 설명해 주세요.'
    },
    attachment: async (aid) => images.get(aid) ?? null,
    clearAttachment: async (qid, turnId) => {
      const t = question(qid).turns.find((x) => x.id === turnId)
      if (t) t.attachment = null
      changed()
    },
    onStream: (cb) => {
      streams.add(cb)
      return () => void streams.delete(cb)
    },
    onChanged: (cb) => {
      changes.add(cb)
      return () => void changes.delete(cb)
    },
    address: () => DEMO_PAIRING.addresses[0],
    reconnect: () => changed(),
    close: () => {
      for (const list of timers.values()) list.forEach(clearTimeout)
      timers.clear()
      streams.clear()
      changes.clear()
    }
  }
}

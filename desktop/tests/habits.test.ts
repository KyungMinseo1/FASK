import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PersonalStore } from '../src/main/personal-store'
import { KnowledgeExtractor, type Chat } from '../src/main/knowledge-extract'
import { HabitDetector } from '../src/main/habit-detect'
import {
  HABIT_PROMPT_CHARS,
  applyDetected,
  backupHabits,
  decideHabit,
  habitFile,
  habitPrompt,
  importHabitFile,
  listHabits,
  normalizeWhen,
  recallHabits,
  saveHabit,
  toLines,
  type HabitRef
} from '../src/main/habits'
import { parseHabits, type ExtractedHabit } from '../src/main/knowledge-response'
import { validateBackup } from '../src/main/personal-backup'
import { prompt } from '../src/main/prompts'
import { defaultAvatar } from '../src/shared/avatar'
import type { Concept, Habit, Project, Question, Turn, TurnAuthor, Workspace } from '../src/preload/personal'

function hTurn(id: string, raw: string, answer: string, author?: Partial<TurnAuthor>): Turn {
  return {
    id,
    createdAt: new Date().toISOString(),
    raw,
    refined: '',
    sent: raw,
    answer,
    model: '',
    actualModel: '',
    status: 'completed',
    complexity: 'simple',
    routingReason: '',
    attachment: null,
    documents: [],
    error: '',
    revision: 0,
    ...(author
      ? { author: { profileId: 'p', name: '이름', avatar: defaultAvatar('p'), device: 'pc', ...author } }
      : {})
  }
}

function question(id: string, projectId: string, turns: Turn[]): Question {
  return {
    id,
    projectId,
    createdAt: turns[0].createdAt,
    turns,
    conceptIds: [],
    conceptTurns: {},
    extractedTurns: 0,
    suggestions: [],
    memo: '',
    important: false
  }
}

function setup(organize: boolean): {
  dir: string
  store: PersonalStore
  project: Project
  put: (id: string, turns: Turn[]) => Question
} {
  const dir = mkdtempSync(join(tmpdir(), 'fask-habit-'))
  const store = new PersonalStore(dir)
  store.saveSettings({ ...store.settings(), organize, answerHabits: true, extractDelaySec: 0, model: 'm' })
  const project = store.list<Project>('project')[0]
  const put = (id: string, turns: Turn[]): Question => {
    const q = question(id, project.id, turns)
    store.put('question', store.active, q)
    return q
  }
  return { dir, store, project, put }
}

/** A profile left over from a multi-profile database (hidden until merged). */
function legacyProfile(store: PersonalStore, name: string): string {
  const id = randomUUID()
  store.put('profile', '*', { id, name })
  return id
}

const LONG = '고유값은 선형 변환에서 방향이 바뀌지 않는 벡터의 배율이다. 특성방정식으로 구한다.'

type Call = { instruction: string; input: Record<string, unknown> }

/** Runs one extraction with a fake model; returns the calls it received. */
async function extractWith(store: PersonalStore, questionId: string, reply: string): Promise<Call[]> {
  const calls: Call[] = []
  const chat: Chat = async (_profile, _executor, instruction, input) => {
    calls.push({ instruction, input: JSON.parse(input) })
    return reply
  }
  const extractor = new KnowledgeExtractor(store, chat, () => {})
  await extractor.run(store.active, questionId)
  await extractor.idle()
  extractor.close()
  return calls
}

type Reply = string | ((input: Record<string, unknown>) => string)

/** A habit detector with a fake model; `calls` collects what the model received. */
function makeDetector(
  store: PersonalStore,
  reply: Reply,
  remote?: { question: Question; owner: string }
): { detector: HabitDetector; calls: Call[] } {
  const calls: Call[] = []
  const detector = new HabitDetector({
    store,
    chat: async (instruction, input) => {
      const parsed = JSON.parse(input) as Record<string, unknown>
      calls.push({ instruction, input: parsed })
      return typeof reply === 'string' ? reply : reply(parsed)
    },
    remoteQuestion: (id) => (remote && remote.question.id === id ? remote : undefined),
    changed: () => {}
  })
  return { detector, calls }
}

/**
 * Runs habit detection now with a fake model: the local batch, or one remote question; returns the
 * calls it received.
 */
async function detectWith(store: PersonalStore, reply: Reply, remote?: { question: Question; owner: string }): Promise<Call[]> {
  const { detector, calls } = makeDetector(store, reply, remote)
  if (remote) {
    detector.schedule(remote.question.id, 60_000)
    detector.runNow(remote.question.id)
  } else detector.scanLocal()
  await detector.idle()
  detector.close()
  return calls
}

/** Refs of a call that sent `turns` of one question as turn numbers 0..n-1. */
const refsOf = (questionId: string, turns: Turn[], project: { owner: string; id: string }): Map<number, HabitRef> =>
  new Map(turns.map((t, i) => [i, { questionId, turnId: t.id, project }]))

type Sent = { turn: number; conversation: number; question: string; previousAnswer?: string }
const sentOf = (call: Call): Sent[] => call.input.feedback as Sent[]
const habitIdsOf = (call: Call): string[] => (call.input.habits as { id: string }[]).map((h) => h.id)

const item = (patch: Partial<ExtractedHabit>): ExtractedHabit => ({
  rule: '표로 정리',
  when: '',
  scope: 'profile',
  overrides: null,
  scopeClear: true,
  explicit: false,
  same: null,
  replaces: null,
  turns: [1],
  ...patch
})

/** Writes a habit directly; defaults to an active profile habit. */
function habit(store: PersonalStore, patch: Partial<Habit>): Habit {
  const now = new Date().toISOString()
  const h: Habit = {
    id: randomUUID(),
    rule: '규칙',
    when: '',
    scope: 'profile',
    projectOwner: null,
    projectId: null,
    overrides: null,
    status: 'active',
    origin: 'manual',
    sources: [],
    count: 1,
    replaces: null,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    invalidatedAt: null,
    ...patch
  }
  store.put('habit', store.active, h)
  return h
}

test('habits: every own request reaches the model', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '왜 이렇게 되는 거야?', LONG)])
    const calls = await detectWith(store, '{}')
    assert.equal(calls.length, 1)
    assert.deepEqual(
      sentOf(calls[0]).map((f) => f.turn),
      [0, 1]
    )
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 2)
    assert.equal(store.list<Habit>('habit').length, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: explicit feedback turns a habit on unconfirmed', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '앞으로 항상 표로 정리해줘', '| a | b |')])
    const calls = await detectWith(
      store,
      '{"habits":[{"rule":"표로 정리","when":"","scope":"profile","overrides":null,"scopeClear":true,"explicit":true,"same":null,"replaces":null,"turns":[1]}]}'
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instruction, prompt('ko', 'habits'))
    const feedback = sentOf(calls[0])
    assert.deepEqual(
      feedback.map((f) => f.turn),
      [0, 1]
    )
    assert.equal(feedback[1].previousAnswer, LONG)
    assert.equal(feedback[1].conversation, 0)
    const [h] = store.list<Habit>('habit')
    assert.equal(h.status, 'active')
    assert.equal(h.origin, 'explicit')
    assert.equal(h.reviewedAt, null)
    assert.deepEqual(h.sources, [{ questionId: 'q1', turnIds: ['t1'] }])
    const q = store.record<Question>('question', 'q1')
    assert.equal(q.extractedTurns, 0)
    assert.equal(q.habitTurns, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: a typo in the lasting request still turns the habit on (the model judges explicit)', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', '아프로 표로 정리해줘', LONG)])
    await detectWith(
      store,
      '{"habits":[{"rule":"표로 정리","when":"","scope":"profile","overrides":null,"scopeClear":true,"explicit":true,"same":null,"replaces":null,"turns":[0]}]}'
    )
    const [h] = store.list<Habit>('habit')
    assert.equal(h.status, 'active')
    assert.equal(h.origin, 'explicit')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit split: the host learns only from turns no linked PC asked', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [
      hTurn('t0', '고유값이 뭐야?', LONG),
      hTurn('t1', '말고 표로 다시 보여줘', LONG),
      hTurn('t2', '앞으로 항상 짧게 답해줘', LONG, { peer: 'px', profileId: 'linked' })
    ])
    const calls = await detectWith(
      store,
      '{"habits":[{"rule":"표로 정리","when":"","scope":"profile","overrides":null,"scopeClear":true,"explicit":false,"same":null,"replaces":null,"turns":[1]}]}'
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instruction, prompt('ko', 'habits'))
    assert.deepEqual(
      sentOf(calls[0]).map((f) => f.turn),
      [0, 1]
    )
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 3)
    assert.equal(store.list<Habit>('habit').length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("habit split: a linked PC learns from its own turns in another PC's question", async () => {
  const { dir, store, put } = setup(false)
  try {
    const local = put('q1', [hTurn('t0', '앞으로 항상 표로 정리해줘', LONG)])
    const remote = question('qr', 'remote-project', [
      hTurn('r0', '여기서는 앞으로 표로 정리해줘', LONG, { profileId: store.active }),
      hTurn('r1', '앞으로 항상 짧게 답해줘', LONG, { profileId: 'someone-else' })
    ])
    const calls = await detectWith(
      store,
      '{"habits":[{"rule":"표로 정리","when":"","scope":"project","overrides":null,"scopeClear":true,"explicit":true,"same":null,"replaces":null,"turns":[0]}]}',
      { question: remote, owner: 'host-a' }
    )
    assert.equal(calls.length, 1)
    assert.deepEqual(
      sentOf(calls[0]).map((f) => f.turn),
      [0]
    )
    assert.equal(store.habitMark('qr'), 2)
    assert.deepEqual(store.record<Question>('question', 'q1'), local, 'local question untouched')
    const [h] = store.list<Habit>('habit')
    assert.equal(h.scope, 'project')
    assert.equal(h.projectOwner, 'host-a')
    assert.equal(h.projectId, 'remote-project')
    assert.equal(h.status, 'active')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit split: concept extraction sends only the extraction instruction', async () => {
  const { dir, store, put } = setup(true)
  try {
    put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '말고 표로 다시 보여줘', LONG)])
    const calls = await extractWith(
      store,
      'q1',
      JSON.stringify({
        concepts: [{ name: '고유값', level: 'concept', role: 'focus', parent: null, turns: [0], confidence: 0.9 }],
        relations: []
      })
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instruction, prompt('ko', 'extract'))
    assert.ok(!('feedback' in calls[0].input))
    assert.ok(store.list<Concept>('concept').some((c) => c.name === '고유값'))
    const q = store.record<Question>('question', 'q1')
    assert.equal(q.extractedTurns, 2)
    assert.equal(q.habitTurns, undefined, 'extraction leaves the habit watermark alone')
    assert.equal(store.list<Habit>('habit').length, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: a candidate turns on in its 3rd conversation; a rejected one stays off', () => {
  const { dir, store, project } = setup(false)
  try {
    const here = { owner: store.active, id: project.id }
    const conv = (id: string): Map<number, HabitRef> =>
      refsOf(id, [hTurn(`${id}-0`, 'q', 'a'), hTurn(`${id}-1`, '표로 정리해줘', 'b')], here)
    applyDetected(store, store.active, [item({})], conv('q1'))
    const [c] = store.list<Habit>('habit')
    assert.equal(c.count, 1)
    assert.equal(c.status, 'proposed')
    applyDetected(store, store.active, [item({ rule: '다른 표현', same: c.id, turns: [0] })], conv('q1'))
    const sameConversation = store.record<Habit>('habit', c.id)
    assert.equal(sameConversation.count, 1, 'another request of the same conversation adds no count')
    assert.deepEqual(sameConversation.sources, [{ questionId: 'q1', turnIds: ['q1-1', 'q1-0'] }])
    applyDetected(store, store.active, [item({ same: c.id, turns: [0] })], conv('q1'))
    assert.deepEqual(store.record<Habit>('habit', c.id), sameConversation, 'a re-checked request writes nothing')
    applyDetected(store, store.active, [item({ same: c.id })], conv('q2'))
    assert.equal(store.record<Habit>('habit', c.id).count, 2)
    assert.equal(store.record<Habit>('habit', c.id).status, 'proposed')
    applyDetected(store, store.active, [item({ same: c.id })], conv('q3'))
    const on = store.record<Habit>('habit', c.id)
    assert.equal(on.count, 3)
    assert.equal(on.status, 'active')
    assert.equal(on.origin, 'detected')
    assert.equal(on.reviewedAt, null)
    assert.equal(on.rule, '표로 정리', 'the remembered wording stays')
    const off = habit(store, { rule: '짧게 답하기', status: 'rejected', origin: 'detected', count: 1 })
    for (const id of ['r1', 'r2', 'r3']) applyDetected(store, store.active, [item({ same: off.id })], conv(id))
    const rejected = store.record<Habit>('habit', off.id)
    assert.equal(rejected.count, 4)
    assert.equal(rejected.status, 'rejected')
    assert.equal(store.list<Habit>('habit').length, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: a full candidate pool drops the one seen in the fewest conversations, oldest first', () => {
  const { dir, store, project } = setup(false)
  try {
    const at = (i: number): string => new Date(Date.now() - 100_000 + i * 1000).toISOString()
    const candidate = { status: 'proposed' as const, origin: 'detected' as const, reviewedAt: null }
    const kept = habit(store, { ...candidate, rule: '두 번 본 후보', count: 2, updatedAt: at(0) })
    const ones = Array.from({ length: 29 }, (_, i) =>
      habit(store, { ...candidate, rule: `후보 ${i}`, count: 1, updatedAt: at(i + 1) })
    )
    const turns = [hTurn('t0', 'q', 'a'), hTurn('t1', '짧게 답해줘', 'b')]
    applyDetected(store, store.active, [item({ rule: '새 후보' })], refsOf('q1', turns, { owner: store.active, id: project.id }))
    const proposed = store.list<Habit>('habit').filter((h) => h.status === 'proposed')
    assert.equal(proposed.length, 30)
    const ids = proposed.map((h) => h.id)
    assert.ok(ids.includes(kept.id))
    assert.ok(!ids.includes(ones[0].id))
    assert.ok(ids.includes(ones[1].id))
    assert.ok(proposed.some((h) => h.rule === '새 후보'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit batch: 8 pending requests across questions run at once, fewer wait', async () => {
  const { dir, store, put } = setup(false)
  store.saveSettings({ ...store.settings(), extractDelaySec: 60 })
  const { detector, calls } = makeDetector(store, '{}')
  try {
    const turns = (q: string, n: number): Turn[] => Array.from({ length: n }, (_, i) => hTurn(`${q}-${i}`, `요청 ${q} ${i}`, LONG))
    put('q1', turns('q1', 3))
    put('q2', turns('q2', 2))
    put('q3', turns('q3', 2))
    detector.completed()
    await detector.idle()
    assert.equal(calls.length, 0)
    put('q3', turns('q3', 3))
    detector.completed()
    await detector.idle()
    assert.equal(calls.length, 1)
    const sent = sentOf(calls[0])
    assert.equal(sent.length, 8)
    assert.deepEqual([...new Set(sent.map((f) => f.conversation))].sort(), [0, 1, 2])
    for (const [id, n] of [
      ['q1', 3],
      ['q2', 2],
      ['q3', 3]
    ] as const)
      assert.equal(store.record<Question>('question', id).habitTurns, n, id)
  } finally {
    detector.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit batch: a lone explicit request turns on after the quiet delay', async () => {
  const { dir, store, put } = setup(false)
  const { detector, calls } = makeDetector(
    store,
    '{"habits":[{"rule":"영어 번역은 굵은 글씨 없이 쓴다","when":"번역, 영어, translation","scope":"profile","overrides":null,"scopeClear":true,"explicit":true,"same":null,"replaces":null,"turns":[0]}]}'
  )
  try {
    put('q1', [hTurn('t0', '앞으로 영어 번역은 굵은 글씨 없이 작성해줘', LONG)])
    detector.completed()
    // extractDelaySec is 0: the batch timer was queued first with the same delay, so it fires before this one.
    await sleep(0)
    await detector.idle()
    assert.equal(calls.length, 1)
    const [h] = store.list<Habit>('habit')
    assert.equal(h.status, 'active')
    assert.equal(h.origin, 'explicit')
  } finally {
    detector.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit batch: startup flushes the backlog 8 requests per call', async () => {
  const { dir, store, put } = setup(false)
  try {
    put(
      'q1',
      Array.from({ length: 10 }, (_, i) => hTurn(`t${i}`, `요청 ${i}`, LONG))
    )
    const calls = await detectWith(store, '{}')
    assert.deepEqual(
      calls.map((c) => sentOf(c).length),
      [8, 2]
    )
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 10)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("habit batch: a call holds one project's requests and sees only that project's habits", async () => {
  const { dir, store, project, put } = setup(false)
  try {
    const B = store.create('project', 'B 프로젝트', store.create('workspace', 'B 워크스페이스'))
    put('qa', [hTurn('a0', 'A 요청 0', LONG), hTurn('a1', 'A 요청 1', LONG)])
    store.put('question', store.active, question('qb', B, [hTurn('b0', 'B 요청 0', LONG), hTurn('b1', 'B 요청 1', LONG)]))
    const me = store.active
    const hA = habit(store, { rule: 'A 규칙', scope: 'project', projectOwner: me, projectId: project.id })
    const hB = habit(store, { rule: 'B 규칙', scope: 'project', projectOwner: me, projectId: B })
    const hG = habit(store, { rule: '전체 규칙' })
    const calls = await detectWith(store, (input) =>
      (input.habits as { id: string }[]).some((h) => h.id === hB.id)
        ? '{"habits":[{"rule":"여기서는 표로","when":"","scope":"project","overrides":null,"scopeClear":true,"explicit":true,"same":null,"replaces":null,"turns":[1]}]}'
        : '{}'
    )
    assert.equal(calls.length, 2)
    for (const call of calls) {
      const prefixes = new Set(sentOf(call).map((f) => f.question[0]))
      assert.equal(prefixes.size, 1, 'one project per call')
      const ids = habitIdsOf(call)
      assert.ok(ids.includes(hG.id))
      assert.deepEqual(
        ids.filter((id) => id === hA.id || id === hB.id),
        prefixes.has('A') ? [hA.id] : [hB.id]
      )
    }
    const created = store.list<Habit>('habit').find((h) => h.rule === '여기서는 표로')
    assert.ok(created)
    assert.equal(created.projectOwner, me)
    assert.equal(created.projectId, B)
    assert.deepEqual(created.sources, [{ questionId: 'qb', turnIds: ['b1'] }])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit batch: one call counts a wish from two conversations as two', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', 'latex로 바꿔줘', LONG)])
    put('q2', [hTurn('u0', '이 풀이 latex 변환 부탁해', LONG)])
    const calls = await detectWith(
      store,
      '{"habits":[{"rule":"수식은 LaTeX 원문으로","when":"수식, LaTeX, math","scope":"profile","overrides":null,"scopeClear":true,"explicit":false,"same":null,"replaces":null,"turns":[0,1]}]}'
    )
    assert.equal(calls.length, 1)
    const [h] = store.list<Habit>('habit')
    assert.equal(h.count, 2)
    assert.equal(h.status, 'proposed')
    assert.deepEqual(h.sources.map((s) => s.questionId).sort(), ['q1', 'q2'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit batch: every active, every candidate and the rejected habits are sent', async () => {
  const { dir, store, put } = setup(false)
  try {
    const ids = [
      ...Array.from({ length: 40 }, (_, i) => habit(store, { rule: `사용 ${i}` }).id),
      ...Array.from(
        { length: 30 },
        (_, i) => habit(store, { rule: `후보 ${i}`, status: 'proposed', origin: 'detected', reviewedAt: null }).id
      ),
      ...Array.from({ length: 5 }, (_, i) => habit(store, { rule: `꺼짐 ${i}`, status: 'rejected' }).id)
    ]
    put('q1', [hTurn('t0', '요청', LONG)])
    const calls = await detectWith(store, '{}')
    assert.equal(calls.length, 1)
    assert.deepEqual(habitIdsOf(calls[0]).sort(), ids.sort())
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit batch: a long request keeps its head and its tail', async () => {
  const { dir, store, put } = setup(false)
  try {
    const long = `${'가'.repeat(592)}굵은 글씨 없이`
    const exact = '나'.repeat(500)
    put('q1', [hTurn('t0', long, LONG), hTurn('t1', exact, LONG)])
    const calls = await detectWith(store, '{}')
    const [first, second] = sentOf(calls[0])
    assert.equal(long.length, 600)
    assert.equal(first.question.length, 503)
    assert.ok(first.question.startsWith(long.slice(0, 250)))
    assert.ok(first.question.includes(' … '))
    assert.ok(first.question.endsWith('굵은 글씨 없이'))
    assert.equal(second.question, exact)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: a replacing habit supersedes the old one only once turned on', () => {
  const { dir, store, project } = setup(false)
  try {
    const a = habit(store, { rule: '표로 정리' })
    const b = habit(store, { rule: '목록으로 정리', status: 'proposed', origin: 'detected', reviewedAt: null, replaces: a.id })
    const text = { profile: store.active, project: { owner: store.active, id: project.id }, text: '정리해줘' }
    assert.ok(recallHabits(store, text).some((h) => h.id === a.id), 'a proposal does not supersede yet')
    decideHabit(store, store.active, b.id, 'active')
    assert.ok(store.record<Habit>('habit', a.id).invalidatedAt)
    assert.deepEqual(recallHabits(store, text).map((h) => h.id), [b.id])
    assert.ok(store.record<Habit>('habit', b.id).reviewedAt)
    assert.throws(() => decideHabit(store, store.active, a.id, 'active'), /습관을 찾을 수 없습니다/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recallHabits: everything in scope when it fits, keyword matches first when it does not', () => {
  const { dir, store, project } = setup(false)
  try {
    const here = { owner: store.active, id: project.id }
    const always = habit(store, { rule: '답은 3줄 요약 먼저' })
    const math = habit(store, { rule: '수식은 코드블록에 LaTeX 원문도', when: '수식, 공식, LaTeX' })
    const code = habit(store, { rule: '코드는 주석 포함', when: '코드, 프로그래밍' })
    habit(store, { rule: '꺼진 규칙', status: 'rejected' })
    habit(store, { rule: '다른 프로젝트 규칙', scope: 'project', projectOwner: store.active, projectId: randomUUID() })
    for (const text of ['공식 정리해줘', '안녕'])
      assert.deepEqual(
        new Set(recallHabits(store, { profile: store.active, project: here, text }).map((h) => h.id)),
        new Set([always.id, math.id, code.id]),
        text
      )
    // Fillers that outrank by count; together they overflow the budget.
    for (let i = 0; i < 6; i++) habit(store, { rule: `${i}${'가'.repeat(280)}`, when: '역사, 문학', count: 10 })
    for (const text of ['공식 정리해줘', '수식을 바꿔줘']) {
      const ids = recallHabits(store, { profile: store.active, project: here, text }).map((h) => h.id)
      const sent = store.list<Habit>('habit').filter((h) => ids.includes(h.id))
      assert.ok(sent.reduce((n, h) => n + h.rule.length + h.when.length + 4, 0) <= HABIT_PROMPT_CHARS)
      assert.equal(ids[0], always.id, text)
      assert.equal(ids[1], math.id, text)
      const codeAt = ids.indexOf(code.id)
      assert.ok(codeAt < 0 || codeAt > 1, text)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit scope: a project habit wins over a profile habit only through overrides', () => {
  const { dir, store } = setup(false)
  try {
    const P = randomUUID()
    const Q = randomUUID()
    const G = habit(store, { rule: '목록으로 정리' })
    const other = habit(store, { rule: '답은 3줄 요약 먼저' })
    const turns = [hTurn('t0', 'q', 'a'), hTurn('t1', '여기서는 앞으로 표로 정리해줘', 'b')]
    applyDetected(
      store,
      store.active,
      [item({ rule: '이 프로젝트는 표로 정리', scope: 'project', overrides: G.id, scopeClear: true, explicit: true })],
      refsOf('q1', turns, { owner: 'host-a', id: P })
    )
    const ph = store.list<Habit>('habit').find((h) => h.scope === 'project')
    assert.ok(ph)
    assert.equal(ph.status, 'active')
    assert.equal(ph.projectOwner, 'host-a')
    assert.equal(ph.projectId, P)
    assert.equal(ph.overrides, G.id)
    const g = store.record<Habit>('habit', G.id)
    assert.equal(g.status, 'active')
    assert.equal(g.invalidatedAt, null)
    const recall = (owner: string, id: string): string[] =>
      recallHabits(store, { profile: store.active, project: { owner, id }, text: '' }).map((h) => h.id)
    const there = recall('host-a', P)
    assert.equal(there[0], ph.id)
    assert.ok(!there.includes(G.id))
    assert.ok(there.includes(other.id))
    for (const [owner, id] of [
      ['host-b', P],
      ['host-a', Q]
    ]) {
      const ids = recall(owner, id)
      assert.ok(ids.includes(G.id), `${owner}/${id}`)
      assert.ok(!ids.includes(ph.id), `${owner}/${id}`)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit scope: a shared category alone never fills overrides', () => {
  const { dir, store, project } = setup(false)
  try {
    const global = habit(store, { rule: '설명을 자세하게 한다' })
    const exists = (owner: string, id: string): boolean => owner === store.active && id === project.id
    const saved = saveHabit(
      store,
      store.active,
      {
        rule: '예시를 자세하게 보여준다',
        when: '',
        scope: 'project',
        projectOwner: store.active,
        projectId: project.id,
        overrides: null
      },
      exists
    )
    assert.equal(store.record<Habit>('habit', saved).overrides, null)
    const turns = [hTurn('t0', 'q', 'a'), hTurn('t1', '여기서는 앞으로 예시를 자세히 들어줘', 'b')]
    applyDetected(
      store,
      store.active,
      [item({ rule: '예시를 자세하게 들어준다', scope: 'project', explicit: true })],
      refsOf('q1', turns, { owner: 'host-b', id: 'pb' })
    )
    const detected = store.list<Habit>('habit').find((h) => h.projectOwner === 'host-b')
    assert.ok(detected)
    assert.equal(detected.overrides, null)
    const ids = recallHabits(store, {
      profile: store.active,
      project: { owner: store.active, id: project.id },
      text: ''
    }).map((h) => h.id)
    assert.ok(ids.includes(saved) && ids.includes(global.id))
    const list = listHabits(store, store.active, [{ owner: store.active, id: project.id, name: project.name }])
    assert.deepEqual(list.projects, [{ owner: store.active, id: project.id, name: project.name }])
    assert.deepEqual(list.overrideCandidates[saved], [global.id])
    assert.deepEqual(Object.keys(list.overrideCandidates).sort(), [saved, detected.id].sort())
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit scope: an unclear-scope conflict waits as a proposal and changes nothing', () => {
  const { dir, store, project } = setup(false)
  try {
    for (let i = 0; i < 5; i++) habit(store, { rule: `제안 ${i}`, status: 'proposed', origin: 'detected', reviewedAt: null })
    const H = habit(store, { rule: '짧게 답한다' })
    const turns = [hTurn('t0', 'q', 'a'), hTurn('t1', '앞으로는 자세하게 설명해 줘', 'b')]
    applyDetected(
      store,
      store.active,
      [item({ rule: '자세하게 설명한다', scopeClear: false, explicit: true, replaces: H.id })],
      refsOf('q1', turns, { owner: store.active, id: project.id })
    )
    const fresh = store.list<Habit>('habit').find((h) => h.rule === '자세하게 설명한다')
    assert.ok(fresh, 'added despite the proposal cap')
    assert.equal(fresh.status, 'proposed')
    assert.equal(fresh.replaces, H.id)
    assert.equal(fresh.overrides, null)
    const h = store.record<Habit>('habit', H.id)
    assert.equal(h.status, 'active')
    assert.equal(h.invalidatedAt, null)
    decideHabit(store, store.active, fresh.id, 'active')
    assert.ok(store.record<Habit>('habit', H.id).invalidatedAt)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habitPrompt puts project rules first under their own heading', () => {
  const lines = [
    { rule: '답은 3줄 요약 먼저', when: '', project: false },
    { rule: '표로 정리', when: '비교, table', project: true }
  ]
  const ko = habitPrompt(lines, 'ko')
  assert.ok(ko.startsWith('이 프로젝트 전용 규칙'))
  assert.equal(
    ko,
    '이 프로젝트 전용 규칙 (아래 규칙과 부딪히면 이 규칙을 따른다):\n- 표로 정리 [비교, table]\n모든 프로젝트 규칙:\n- 답은 3줄 요약 먼저'
  )
  assert.ok(habitPrompt(lines, 'en').startsWith('Rules for this project only'))
  assert.equal(habitPrompt([lines[0]], 'ko'), '- 답은 3줄 요약 먼저')
  assert.deepEqual(
    toLines([{ rule: 'r', when: 'w', scope: 'project' } as Habit]),
    [{ rule: 'r', when: 'w', project: true }]
  )
})

test('normalizeWhen drops 1-character and duplicate keywords', () => {
  assert.equal(normalizeWhen('표, 수식 , 수식, LaTeX/math'), '수식, LaTeX, math')
  assert.equal(normalizeWhen(''), '')
})

test('saveHabit validates and refuses a duplicate of the same scope', () => {
  const { dir, store, project } = setup(false)
  try {
    const exists = (owner: string, id: string): boolean => owner === store.active && id === project.id
    const base = { when: '', scope: 'profile' as const, projectOwner: null, projectId: null, overrides: null }
    const id = saveHabit(store, store.active, { ...base, rule: ' 답은 3줄 요약 먼저 ', projectId: 'x' }, exists)
    const h = store.record<Habit>('habit', id)
    assert.equal(h.rule, '답은 3줄 요약 먼저')
    assert.equal(h.projectId, null)
    assert.equal(h.status, 'active')
    assert.throws(() => saveHabit(store, store.active, { ...base, rule: '답은 3줄 요약 먼저' }, exists), /같은 습관/)
    assert.throws(() => saveHabit(store, store.active, { ...base, rule: 'x', when: '표' }, exists), /습관 내용/)
    const inProject = { ...base, scope: 'project' as const, projectOwner: store.active, projectId: project.id }
    assert.throws(
      () => saveHabit(store, store.active, { ...inProject, rule: 'x', projectId: 'missing' }, exists),
      /습관 내용/
    )
    assert.throws(() => saveHabit(store, store.active, { ...base, rule: 'y', overrides: id }, exists), /습관 내용/)
    assert.throws(
      () => saveHabit(store, store.active, { ...inProject, rule: 'y', overrides: 'unknown' }, exists),
      /습관 내용/
    )
    const p = saveHabit(store, store.active, { ...inProject, rule: 'y', overrides: id }, exists)
    assert.equal(store.record<Habit>('habit', p).overrides, id)
    // The overridden habit becoming a project habit clears the override pointing at it.
    saveHabit(store, store.active, { ...inProject, id, rule: '답은 3줄 요약 먼저' }, exists)
    assert.equal(store.record<Habit>('habit', p).overrides, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: deleting questions, workspaces and moving questions keep references consistent', () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', 'a', 'b')])
    put('q2', [hTurn('u0', 'a', 'b')])
    const kept = habit(store, { sources: [{ questionId: 'q1', turnIds: ['t0'] }, { questionId: 'q2', turnIds: ['u0'] }] })
    store.remove('question', 'q1')
    assert.deepEqual(store.record<Habit>('habit', kept.id).sources, [{ questionId: 'q2', turnIds: ['u0'] }])
    const other = store.create('workspace', '다른 워크스페이스')
    const otherProject = store.create('project', '다른 프로젝트', other)
    const scoped = habit(store, { rule: '여기서는 표로', scope: 'project', projectOwner: store.active, projectId: otherProject })
    const remote = habit(store, { rule: '저기서는 표로', scope: 'project', projectOwner: 'host-a', projectId: otherProject })
    store.put('question', store.active, { ...store.record<Question>('question', 'q2'), habitTurns: 1, extractedTurns: 1 })
    store.moveQuestion('q2', otherProject)
    const moved = store.record<Question>('question', 'q2')
    assert.equal(moved.habitTurns, 1)
    assert.equal(moved.extractedTurns, 0)
    assert.equal(store.workspaceOf(moved.projectId), other)
    store.remove('workspace', other)
    const left = store.list<Habit>('habit').map((h) => h.id)
    assert.ok(!left.includes(scoped.id))
    assert.ok(left.includes(remote.id), "another PC's project habit stays")
    assert.ok(left.includes(kept.id))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup habits: dropped or repaired without failing the restore', () => {
  const { dir, store, project, put } = setup(false)
  try {
    const q = put('q1', [hTurn('t0', 'a', 'b')])
    assert.deepEqual(backupHabits(undefined, new Set(), [], null), [])
    assert.equal(backupHabits('x', new Set(), [], null), null)
    const me = store.active
    const gone = habit(store, { rule: '사라진 프로젝트', scope: 'project', projectOwner: me, projectId: randomUUID() })
    const local = habit(store, {
      rule: '남는 습관',
      replaces: gone.id,
      sources: [
        { questionId: 'q1', turnIds: ['t0', 'missing'] },
        { questionId: 'nope', turnIds: ['x'] }
      ]
    })
    const scoped = habit(store, {
      rule: '프로젝트 습관',
      scope: 'project',
      projectOwner: me,
      projectId: project.id,
      overrides: local.id
    })
    const remote = habit(store, {
      rule: '다른 PC 프로젝트 습관',
      scope: 'project',
      projectOwner: 'host-a',
      projectId: randomUUID(),
      overrides: gone.id
    })
    const habits = backupHabits(store.list<Habit>('habit'), new Set([project.id]), [q], me)
    assert.ok(habits)
    assert.deepEqual(habits.map((h) => h.id).sort(), [local.id, scoped.id, remote.id].sort())
    const restored = habits.find((h) => h.id === local.id)
    assert.equal(restored?.replaces, null)
    assert.deepEqual(restored?.sources, [{ questionId: 'q1', turnIds: ['t0'] }])
    assert.equal(habits.find((h) => h.id === scoped.id)?.overrides, local.id)
    assert.equal(habits.find((h) => h.id === remote.id)?.overrides, null)
    // A pre-v7 workspace habit becomes a profile habit.
    const old = { ...habit(store, { rule: '옛 워크스페이스 습관' }), scope: 'workspace', workspaceId: project.workspaceId }
    const [converted] = backupHabits([old], new Set(), [], null) ?? []
    assert.equal(converted.scope, 'profile')
    assert.equal(converted.projectId, null)
    assert.equal(converted.projectOwner, null)
    assert.ok(!('workspaceId' in converted))
    const snapshot = store.snapshot()
    assert.deepEqual(validateBackup({ version: 3, snapshot, images: {} }).habits, [])
    assert.throws(() => validateBackup({ version: 3, snapshot, images: {}, habits: 'x' }), /백업/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration 6 starts habit detection after the existing turns, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-habit-'))
  try {
    let store = new PersonalStore(dir)
    const project = store.list<Project>('project')[0]
    const turns = [hTurn('t0', 'a', 'b'), hTurn('t1', 'a', 'b'), hTurn('t2', 'a', 'b')]
    store.put('question', store.active, question('q1', project.id, turns))
    store.db.exec(
      "DELETE FROM schema_migrations WHERE version=6; UPDATE records SET data=json_remove(data,'$.habitTurns') WHERE kind='question'"
    )
    store.close()
    store = new PersonalStore(dir)
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 3)
    store.put('question', store.active, { ...store.record<Question>('question', 'q1'), habitTurns: 1 })
    store.close()
    store = new PersonalStore(dir)
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 1, 'runs once')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration 8 re-checks every question for habits, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-habit-'))
  try {
    let store = new PersonalStore(dir)
    const project = store.list<Project>('project')[0]
    const turns = [hTurn('t0', 'a', 'b'), hTurn('t1', 'a', 'b'), hTurn('t2', 'a', 'b')]
    store.put('question', store.active, { ...question('q1', project.id, turns), habitTurns: 3 })
    store.setHabitMark('x', 2)
    store.db.exec('DELETE FROM schema_migrations WHERE version=8')
    store.close()
    store = new PersonalStore(dir)
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 0)
    assert.equal(store.habitMark('x'), 0)
    store.put('question', store.active, { ...store.record<Question>('question', 'q1'), habitTurns: 2 })
    store.close()
    store = new PersonalStore(dir)
    assert.equal(store.record<Question>('question', 'q1').habitTurns, 2, 'runs once')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration 7 turns workspace habits into profile habits after a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-habit-'))
  try {
    let store = new PersonalStore(dir)
    const workspaceId = store.list<Project>('project')[0].workspaceId
    const id = randomUUID()
    const now = new Date().toISOString()
    store.put('habit', store.active, {
      id,
      rule: '여기서는 표로',
      when: '',
      scope: 'workspace',
      workspaceId,
      status: 'active',
      origin: 'manual',
      sources: [],
      count: 1,
      replaces: null,
      reviewedAt: now,
      createdAt: now,
      updatedAt: now,
      invalidatedAt: null
    })
    store.db.exec('DELETE FROM schema_migrations WHERE version=7')
    store.close()
    store = new PersonalStore(dir)
    const h = store.record<Habit>('habit', id)
    assert.equal(h.scope, 'profile')
    assert.equal(h.projectOwner, null)
    assert.equal(h.projectId, null)
    assert.equal(h.overrides, null)
    assert.ok(!('workspaceId' in h))
    assert.ok(existsSync(join(dir, 'fask-pre-habit-scope.sqlite')))
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habit file: round trip into another profile skips duplicates and unknown projects', () => {
  const { dir, store, project } = setup(false)
  try {
    const p1 = store.active
    habit(store, { rule: '답은 3줄 요약 먼저' })
    habit(store, { rule: '비교는 표로', when: '비교, 차이, compare' })
    habit(store, { rule: '이 과목은 영어 용어 병기', scope: 'project', projectOwner: p1, projectId: project.id })
    habit(store, { rule: '다른 PC 프로젝트 습관', scope: 'project', projectOwner: 'host-a', projectId: randomUUID() })
    habit(store, { rule: '제안만', status: 'proposed' })
    const file = habitFile(store, p1)
    assert.equal((JSON.parse(file) as { habits: unknown[] }).habits.length, 3, "another PC's project habit stays")
    const p2 = legacyProfile(store, '둘째')
    const ws2 = randomUUID()
    store.put<Workspace>('workspace', p2, { id: ws2, name: '워크스페이스', profileId: p2 })
    store.put<Project>('project', p2, { id: randomUUID(), workspaceId: ws2, name: ` ${project.name.toUpperCase()} `, description: '' })
    assert.deepEqual(importHabitFile(store, p2, file), { added: 3, skipped: 0 })
    assert.deepEqual(importHabitFile(store, p2, file), { added: 0, skipped: 3 })
    const imported = store.list<Habit>('habit', p2)
    assert.ok(imported.every((h) => h.origin === 'imported' && h.status === 'active'))
    assert.equal(imported.find((h) => h.rule === '비교는 표로')?.when, '비교, 차이, compare')
    const scoped = imported.find((h) => h.scope === 'project')
    assert.equal(scoped?.projectOwner, p2)
    const p3 = legacyProfile(store, '셋째')
    assert.deepEqual(importHabitFile(store, p3, file), { added: 2, skipped: 1 })
    assert.throws(() => importHabitFile(store, p3, '{"format":"x","version":1,"habits":[]}'), /습관 파일 형식/)
    assert.throws(() => importHabitFile(store, p3, 'not json'), /습관 파일 형식/)
    const older = JSON.stringify({
      format: 'fask-habits',
      version: 1,
      habits: [{ rule: '옛 파일 습관', when: '', workspace: '아무거나' }]
    })
    assert.deepEqual(importHabitFile(store, p3, older), { added: 1, skipped: 0 })
    const fromOld = store.list<Habit>('habit', p3).find((h) => h.rule === '옛 파일 습관')
    assert.equal(fromOld?.scope, 'profile')
    assert.equal(fromOld?.projectId, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseHabits drops items naming unknown ids, conflicting links, bad scopes, or unsent turns', () => {
  const known = new Set(['a', 'b'])
  const turns = new Set([1, 3])
  const base = {
    rule: '표로',
    when: '',
    scope: 'profile',
    overrides: null,
    scopeClear: true,
    explicit: false,
    same: null,
    replaces: null,
    turns: [1]
  }
  const parsed = parseHabits(
    JSON.stringify({
      habits: [
        base,
        { ...base, same: 'a', replaces: 'b' },
        { ...base, same: 'zzz' },
        { ...base, turns: [2] },
        { ...base, turns: [] },
        { ...base, scope: 'workspace' },
        { ...base, overrides: 'a' },
        { ...base, scope: 'project', overrides: 'a', replaces: 'b' },
        { ...base, scope: 'project', overrides: 'zzz' },
        { ...base, replaces: 'b', turns: [3, 1] },
        { ...base, scope: 'project', overrides: 'a', scopeClear: 'x' }
      ]
    }),
    known,
    turns
  )
  assert.equal(parsed.length, 3)
  assert.deepEqual(parsed[1], { ...base, replaces: 'b', turns: [3, 1] })
  assert.deepEqual(parsed[2], { ...base, scope: 'project', overrides: 'a', scopeClear: true })
  assert.deepEqual(parseHabits('no json', known, turns), [])
})

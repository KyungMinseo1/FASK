import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PersonalStore } from '../src/main/personal-store'
import { KnowledgeExtractor, type Chat } from '../src/main/knowledge-extract'
import {
  HABIT_PROMPT_CHARS,
  applyDetected,
  backupHabits,
  decideHabit,
  habitFile,
  importHabitFile,
  isHabitFeedback,
  normalizeWhen,
  recallHabits,
  saveHabit
} from '../src/main/habits'
import { parseHabits, type ExtractedHabit } from '../src/main/knowledge-response'
import { validateBackup } from '../src/main/personal-backup'
import { prompt } from '../src/main/prompts'
import type { Concept, Habit, Project, Question, Turn, Workspace } from '../src/preload/personal'

function hTurn(id: string, raw: string, answer: string): Turn {
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
    revision: 0
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
    const q: Question = {
      id,
      projectId: project.id,
      createdAt: turns[0].createdAt,
      turns,
      conceptIds: [],
      conceptTurns: {},
      extractedTurns: 0,
      suggestions: [],
      memo: '',
      important: false
    }
    store.put('question', store.active, q)
    return q
  }
  return { dir, store, project, put }
}

const LONG = '고유값은 선형 변환에서 방향이 바뀌지 않는 벡터의 배율이다. 특성방정식으로 구한다.'

/** Runs one extraction with a fake model; returns the calls it received. */
async function extractWith(
  store: PersonalStore,
  questionId: string,
  reply: string
): Promise<{ instruction: string; input: Record<string, unknown> }[]> {
  const calls: { instruction: string; input: Record<string, unknown> }[] = []
  const chat: Chat = async (_profile, _model, instruction, input) => {
    calls.push({ instruction, input: JSON.parse(input) })
    return reply
  }
  const extractor = new KnowledgeExtractor(store, chat, () => {})
  await extractor.run(store.active, questionId)
  await extractor.idle()
  extractor.close()
  return calls
}

const item = (patch: Partial<ExtractedHabit>): ExtractedHabit => ({
  rule: '표로 정리',
  when: '',
  scope: 'profile',
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
    workspaceId: null,
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

const NOT_FEEDBACK = [
  '왜 이렇게 되는 거야?',
  '이 코드 복사해서 실행하면 오류가 나',
  '행렬식은 어떻게 구해?',
  '다시 말해 고유값이 뭐야?',
  '수식 (3)의 의미는?',
  '항상 0보다 큰 이유는?',
  'copy constructor가 뭐야?'
]
const FEEDBACK = [
  '복사하기 힘들어, 수식은 코드블록으로 줘',
  '앞으로 항상 표로 정리해줘',
  '말고 짧게 다시',
  'from now on, always answer in a table'
]

test('habit gate: a format word plus an explicit or corrective word', () => {
  for (const text of NOT_FEEDBACK) assert.equal(isHabitFeedback(text), false, text)
  for (const text of FEEDBACK) assert.equal(isHabitFeedback(text), true, text)
})

test('habits: an ordinary follow-up never reaches the model for habits', async () => {
  const off = setup(false)
  try {
    off.put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '왜 이렇게 되는 거야?', LONG)])
    const calls = await extractWith(off.store, 'q1', '{}')
    assert.equal(calls.length, 0)
    assert.equal(off.store.record<Question>('question', 'q1').habitTurns, 2)
  } finally {
    off.store.close()
    rmSync(off.dir, { recursive: true, force: true })
  }
  const on = setup(true)
  try {
    on.put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '왜 이렇게 되는 거야?', LONG)])
    const calls = await extractWith(on.store, 'q1', '{"concepts":[],"relations":[]}')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instruction, prompt('ko', 'extract'))
    assert.ok(!('feedback' in calls[0].input))
  } finally {
    on.store.close()
    rmSync(on.dir, { recursive: true, force: true })
  }
})

test('habits: with concept extraction off, explicit feedback turns a habit on unconfirmed', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '앞으로 항상 표로 정리해줘', '| a | b |')])
    const calls = await extractWith(
      store,
      'q1',
      '{"habits":[{"rule":"표로 정리","when":"","scope":"profile","explicit":true,"same":null,"replaces":null,"turns":[1]}]}'
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instruction, prompt('ko', 'habits'))
    const feedback = calls[0].input.feedback as { turn: number; previousAnswer?: string }[]
    assert.equal(feedback[0].turn, 1)
    assert.equal(feedback[0].previousAnswer, LONG)
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

test('habits: explicit is trusted only when the user wrote an explicit word', async () => {
  const { dir, store, put } = setup(false)
  try {
    put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '말고 표로 다시 보여줘', '| a |')])
    await extractWith(
      store,
      'q1',
      '{"habits":[{"rule":"표로 정리","when":"","scope":"profile","explicit":true,"same":null,"replaces":null,"turns":[1]}]}'
    )
    const [h] = store.list<Habit>('habit')
    assert.equal(h.status, 'proposed')
    assert.equal(h.origin, 'detected')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: concepts and habits ride on one extraction call', async () => {
  const { dir, store, put } = setup(true)
  try {
    put('q1', [hTurn('t0', '고유값이 뭐야?', LONG), hTurn('t1', '말고 표로 다시 보여줘', LONG)])
    const calls = await extractWith(
      store,
      'q1',
      JSON.stringify({
        concepts: [{ name: '고유값', level: 'concept', role: 'focus', parent: null, turns: [0], confidence: 0.9 }],
        relations: [],
        habits: [{ rule: '표로 정리', when: '비교, 표, table', scope: 'profile', explicit: false, same: null, replaces: null, turns: [1] }]
      })
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instruction, `${prompt('ko', 'extract')}\n\n${prompt('ko', 'habits')}`)
    assert.ok(Array.isArray(calls[0].input.turns) && Array.isArray(calls[0].input.feedback))
    assert.ok(store.list<Concept>('concept').some((c) => c.name === '고유값'))
    const [h] = store.list<Habit>('habit')
    assert.equal(h.status, 'proposed')
    assert.equal(h.when, '비교, table')
    const q = store.record<Question>('question', 'q1')
    assert.equal(q.extractedTurns, 2)
    assert.equal(q.habitTurns, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: repeated feedback counts but never turns a habit on by itself', () => {
  const { dir, store, project } = setup(false)
  try {
    const turns = [hTurn('t0', 'q', 'a'), hTurn('t1', '말고 표로 다시', 'b')]
    const ctx = { questionId: 'q1', workspaceId: project.workspaceId, turns }
    applyDetected(store, store.active, [item({})], ctx)
    const [proposed] = store.list<Habit>('habit')
    for (let i = 0; i < 3; i++) applyDetected(store, store.active, [item({ rule: '다른 표현', same: proposed.id })], ctx)
    const after = store.record<Habit>('habit', proposed.id)
    assert.equal(after.count, 4)
    assert.equal(after.status, 'proposed')
    assert.equal(after.rule, '표로 정리', 'the remembered wording stays')
    decideHabit(store, store.active, proposed.id, 'rejected')
    applyDetected(store, store.active, [item({ same: proposed.id })], ctx)
    const rejected = store.record<Habit>('habit', proposed.id)
    assert.equal(rejected.count, 5)
    assert.equal(rejected.status, 'rejected')
    assert.equal(store.list<Habit>('habit').length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: new proposals stop at the cap; explicit requests still add', () => {
  const { dir, store, project } = setup(false)
  try {
    for (let i = 0; i < 5; i++) habit(store, { rule: `제안 ${i}`, status: 'proposed', origin: 'detected', reviewedAt: null })
    const turns = [hTurn('t0', 'q', 'a'), hTurn('t1', '앞으로 항상 짧게 답해줘', 'b')]
    const ctx = { questionId: 'q1', workspaceId: project.workspaceId, turns }
    applyDetected(store, store.active, [item({ rule: '새 제안' })], ctx)
    assert.equal(store.list<Habit>('habit').length, 5)
    applyDetected(store, store.active, [item({ rule: '짧게 답하기', explicit: true })], ctx)
    assert.equal(store.list<Habit>('habit').length, 6)
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
    const text = { profile: store.active, workspaceId: project.workspaceId, text: '정리해줘' }
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
    const ws = project.workspaceId
    const always = habit(store, { rule: '답은 3줄 요약 먼저' })
    const math = habit(store, { rule: '수식은 코드블록에 LaTeX 원문도', when: '수식, 공식, LaTeX' })
    const code = habit(store, { rule: '코드는 주석 포함', when: '코드, 프로그래밍' })
    habit(store, { rule: '꺼진 규칙', status: 'rejected' })
    habit(store, { rule: '다른 워크스페이스 규칙', scope: 'workspace', workspaceId: randomUUID() })
    for (const text of ['공식 정리해줘', '안녕'])
      assert.deepEqual(
        new Set(recallHabits(store, { profile: store.active, workspaceId: ws, text }).map((h) => h.id)),
        new Set([always.id, math.id, code.id]),
        text
      )
    // Fillers that outrank by count; together they overflow the budget.
    for (let i = 0; i < 6; i++) habit(store, { rule: `${i}${'가'.repeat(280)}`, when: '역사, 문학', count: 10 })
    for (const text of ['공식 정리해줘', '수식을 바꿔줘']) {
      const ids = recallHabits(store, { profile: store.active, workspaceId: ws, text }).map((h) => h.id)
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

test('normalizeWhen drops 1-character and duplicate keywords', () => {
  assert.equal(normalizeWhen('표, 수식 , 수식, LaTeX/math'), '수식, LaTeX, math')
  assert.equal(normalizeWhen(''), '')
})

test('saveHabit validates and refuses a duplicate of the same scope', () => {
  const { dir, store } = setup(false)
  try {
    const id = saveHabit(store, store.active, { rule: ' 답은 3줄 요약 먼저 ', when: '', scope: 'profile', workspaceId: 'x' })
    const h = store.record<Habit>('habit', id)
    assert.equal(h.rule, '답은 3줄 요약 먼저')
    assert.equal(h.workspaceId, null)
    assert.equal(h.status, 'active')
    assert.throws(() => saveHabit(store, store.active, { rule: '답은 3줄 요약 먼저', when: '', scope: 'profile', workspaceId: null }), /같은 습관/)
    assert.throws(() => saveHabit(store, store.active, { rule: 'x', when: '표', scope: 'profile', workspaceId: null }), /습관 내용/)
    assert.throws(() => saveHabit(store, store.active, { rule: 'x', when: '', scope: 'workspace', workspaceId: 'missing' }), /습관 내용/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: deleting questions, workspaces and moving questions keep references consistent', () => {
  const { dir, store, project, put } = setup(false)
  try {
    put('q1', [hTurn('t0', 'a', 'b')])
    put('q2', [hTurn('u0', 'a', 'b')])
    const kept = habit(store, { sources: [{ questionId: 'q1', turnIds: ['t0'] }, { questionId: 'q2', turnIds: ['u0'] }] })
    store.remove('question', 'q1')
    assert.deepEqual(store.record<Habit>('habit', kept.id).sources, [{ questionId: 'q2', turnIds: ['u0'] }])
    const other = store.create('workspace', '다른 워크스페이스')
    const otherProject = store.create('project', '다른 프로젝트', other)
    const scoped = habit(store, { rule: '여기서는 표로', scope: 'workspace', workspaceId: other })
    store.put('question', store.active, { ...store.record<Question>('question', 'q2'), habitTurns: 1, extractedTurns: 1 })
    store.moveQuestion('q2', otherProject)
    const moved = store.record<Question>('question', 'q2')
    assert.equal(moved.habitTurns, 1)
    assert.equal(moved.extractedTurns, 0)
    assert.equal(store.workspaceOf(moved.projectId), other)
    store.remove('workspace', other)
    assert.ok(!store.list<Habit>('habit').some((h) => h.id === scoped.id))
    assert.ok(store.list<Habit>('habit').some((h) => h.id === kept.id))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup habits: dropped or repaired without failing the restore', () => {
  const { dir, store, project, put } = setup(false)
  try {
    put('q1', [hTurn('t0', 'a', 'b')])
    assert.deepEqual(backupHabits(undefined, new Set(), []), [])
    assert.equal(backupHabits('x', new Set(), []), null)
    const gone = habit(store, { rule: '사라진 워크스페이스', scope: 'workspace', workspaceId: randomUUID() })
    const local = habit(store, {
      rule: '남는 습관',
      replaces: gone.id,
      sources: [
        { questionId: 'q1', turnIds: ['t0', 'missing'] },
        { questionId: 'nope', turnIds: ['x'] }
      ]
    })
    const scoped = habit(store, { rule: '워크스페이스 습관', scope: 'workspace', workspaceId: project.workspaceId })
    const snapshot = store.snapshot()
    const { habits } = validateBackup({ version: 3, snapshot, images: {}, habits: store.list<Habit>('habit') })
    assert.deepEqual(habits.map((h) => h.id).sort(), [local.id, scoped.id].sort())
    const restored = habits.find((h) => h.id === local.id)
    assert.equal(restored?.replaces, null)
    assert.deepEqual(restored?.sources, [{ questionId: 'q1', turnIds: ['t0'] }])
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
    store.put('question', store.active, {
      id: 'q1',
      projectId: project.id,
      createdAt: turns[0].createdAt,
      turns,
      conceptIds: [],
      conceptTurns: {},
      extractedTurns: 0,
      suggestions: [],
      memo: '',
      important: false
    })
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

test('habit file: round trip into another profile skips duplicates and unknown workspaces', () => {
  const { dir, store, project } = setup(false)
  try {
    const p1 = store.active
    const wsName = store.record<Workspace>('workspace', project.workspaceId).name
    habit(store, { rule: '답은 3줄 요약 먼저' })
    habit(store, { rule: '비교는 표로', when: '비교, 차이, compare' })
    habit(store, { rule: '이 과목은 영어 용어 병기', scope: 'workspace', workspaceId: project.workspaceId })
    habit(store, { rule: '제안만', status: 'proposed' })
    const file = habitFile(store, p1)
    const p2 = store.create('profile', '둘째')
    store.put<Workspace>('workspace', p2, { id: randomUUID(), name: ` ${wsName.toUpperCase()} `, profileId: p2 })
    assert.deepEqual(importHabitFile(store, p2, file), { added: 3, skipped: 0 })
    assert.deepEqual(importHabitFile(store, p2, file), { added: 0, skipped: 3 })
    const imported = store.list<Habit>('habit', p2)
    assert.ok(imported.every((h) => h.origin === 'imported' && h.status === 'active'))
    assert.equal(imported.find((h) => h.rule === '비교는 표로')?.when, '비교, 차이, compare')
    const p3 = store.create('profile', '셋째')
    assert.deepEqual(importHabitFile(store, p3, file), { added: 2, skipped: 1 })
    assert.throws(() => importHabitFile(store, p3, '{"format":"x","version":1,"habits":[]}'), /습관 파일 형식/)
    assert.throws(() => importHabitFile(store, p3, 'not json'), /습관 파일 형식/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseHabits drops items naming unknown ids, both same and replaces, or unsent turns', () => {
  const known = new Set(['a', 'b'])
  const turns = new Set([1, 3])
  const base = { rule: '표로', when: '', scope: 'profile', explicit: false, same: null, replaces: null, turns: [1] }
  const parsed = parseHabits(
    JSON.stringify({
      habits: [
        base,
        { ...base, same: 'a', replaces: 'b' },
        { ...base, same: 'zzz' },
        { ...base, turns: [2] },
        { ...base, turns: [] },
        { ...base, replaces: 'b', turns: [3, 1] }
      ]
    }),
    known,
    turns
  )
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[1], { ...base, replaces: 'b', turns: [3, 1] })
  assert.deepEqual(parseHabits('no json', known, turns), [])
})

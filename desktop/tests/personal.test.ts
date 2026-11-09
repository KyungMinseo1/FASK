import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, TLSSocket } from 'node:tls'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { createHubCertificate, PersonalHub, type HubCaller, type HubLimits, type HubTls } from '../src/main/personal-hub'
import { HubRelay, RELAY_WINDOW, RelayStream, normalizeRelayUrl, relayRoom } from '../src/main/personal-relay'
import { DatabaseSync } from 'node:sqlite'
import { PersonalStore } from '../src/main/personal-store'
import { normalizeEndpoint, localModels, streamChat } from '../src/main/local-api'
import type { PeerStatus, Project, Question, Snapshot, Turn, TurnState } from '../src/preload/personal'
import { PairingHost } from '../src/main/peer-pairing'
import { dial, pairWithHost, PeerConnection, type PeerLink } from '../src/main/personal-peers'
import { checkPeerCall, checkPeerManager, RemoteRouter } from '../src/main/personal-routing'
import { pairConfig, pairRelayKey, runPairClient, type PairPayload, type PairPost } from '../src/shared/pair-code'
import { OpaqueClient } from '@cloudflare/opaque-ts'
import { validateBackup } from '../src/main/personal-backup'
import { readAttachment } from '../src/renderer/src/personal/attachments'
import { previewSource } from '../src/renderer/src/personal/preview-source'
import {
  RELATION_LABELS,
  linkableConcepts,
  projectConcepts,
  relationHighlight
} from '../src/renderer/src/personal/questionTree'
import { egoLayout, pillBorder } from '../src/renderer/src/personal/egoGraph'
import './knowledge.test'
import './knowledge-store.test'
import './mindmap-layout.test'
import './capture.test'
import {
  answerJustCompleted,
  applyDelta,
  cleanTitle,
  mergeLegacyQuestions,
  mergeLive,
  normalizeLegacyQuestion,
  pageSlice,
  pageWindow,
  reconcileTurnState
} from '../src/shared/questions'

test('answerJustCompleted fires only for the same turn going running → completed', () => {
  const q = (id: string, status: Turn['status']): Question =>
    ({ id: 'q1', turns: [{ id, status }] }) as unknown as Question
  assert.equal(answerJustCompleted(q('t1', 'running'), q('t1', 'completed')), true)
  assert.equal(answerJustCompleted(q('t1', 'completed'), q('t1', 'completed')), false)
  assert.equal(answerJustCompleted(q('t1', 'running'), q('t2', 'completed')), false)
  assert.equal(answerJustCompleted(undefined, q('t1', 'completed')), false)
})

test('previewSource trims long answers and keeps fences and $$ blocks balanced', () => {
  const short = 'short answer'
  assert.equal(previewSource(short), short)
  const long = Array.from({ length: 130 }, (_, i) => `line ${i} of a long answer`).join('\n')
  assert.ok(long.length >= 3000)
  const cut = previewSource(long)
  assert.ok(cut.length <= 700 && cut.length >= 600, String(cut.length))
  const balanced = (s: string): boolean =>
    (s.match(/^```/gm) ?? []).length % 2 === 0 && (s.match(/\$\$/g) ?? []).length % 2 === 0
  const fence = 'a'.repeat(550) + '\n```ts\n' + 'const x = 1\n'.repeat(200) + '```\nafter'
  const fenced = previewSource(fence)
  assert.ok(balanced(fenced) && !fenced.includes('```'))
  const math = 'b'.repeat(550) + '\n$$\n' + 'x^2 + y^2\n'.repeat(200) + '$$\nafter'
  const mathCut = previewSource(math)
  assert.ok(balanced(mathCut) && !mathCut.includes('$$'))
})

test('pageSlice clamps pages and pageWindow inserts gaps', () => {
  const items = Array.from({ length: 45 }, (_, i) => i)
  const third = pageSlice(items, 3, 20)
  assert.equal(third.items.length, 5)
  assert.equal(third.pages, 3)
  assert.equal(pageSlice(items, 9, 20).page, 3)
  assert.equal(pageSlice(items, 0, 20).page, 1)
  assert.equal(pageSlice(items, NaN, 20).page, 1)
  assert.deepEqual(pageSlice([], 1, 20), { items: [], page: 1, pages: 1 })
  assert.deepEqual(pageWindow(5, 10), [1, 'gap', 4, 5, 6, 'gap', 10])
  assert.deepEqual(pageWindow(2, 5), [1, 2, 3, 4, 5])
  assert.deepEqual(pageWindow(1, 10), [1, 2, 'gap', 10])
})

const NO_PAIR = {
  ke1: async (): Promise<unknown> => {
    throw new Error('no pairing')
  },
  ke3: async (): Promise<unknown> => {
    throw new Error('no pairing')
  }
}
const tokenAuth =
  (token: string) =>
  (bearer: string): HubCaller | null =>
    bearer === token ? { kind: 'mobile' } : null

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn',
    createdAt: new Date().toISOString(),
    raw: '질문',
    refined: '',
    sent: '질문',
    answer: '',
    model: '',
    actualModel: '',
    status: 'completed',
    complexity: 'simple',
    routingReason: '',
    attachment: null,
    documents: [],
    error: '',
    revision: 0,
    ...overrides
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

test('rename preserves prompts; deletion cascades with shared images and concept children intact', () => {
  const path = mkdtempSync(join(tmpdir(), 'fask-delete-'))
  const store = new PersonalStore(path)
  try {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    const concept = store.create('concept', '부모', project.id)
    const child = store.create('concept', '자식', project.id)
    store.editConceptInfo(child, { level: 'detail' })
    store.editConcept(child, '자식', concept)
    const image = store.saveImage('data:image/png;base64,YWJj')
    const q: Question = {
      ...question('delete-q', project.id, [
        turn({ id: 'delete-t', raw: '원래 질문', sent: '전송 질문', answer: '답변', attachment: image })
      ]),
      conceptIds: [concept, child]
    }
    store.put('question', profile, q)
    store.db
      .prepare('INSERT INTO runs(id,question_id,created_at,status,model) VALUES(?,?,?,?,?)')
      .run('run', q.id, q.createdAt, 'completed', '')
    store.rename('profile', profile, '새 이름')
    store.rename('question', q.id, '기록 제목')
    assert.equal(store.record<Question>('question', q.id).title, '기록 제목')
    assert.equal(store.record<Question>('question', q.id).turns[0].sent, '전송 질문')
    store.remove('concept', concept)
    assert.deepEqual(store.record<Question>('question', q.id).conceptIds, [child])
    assert.equal(store.snapshot().concepts.find((c) => c.id === child)?.parentId, null)
    const otherProfile = store.create('profile', '다른 사용자')
    store.switchProfile(otherProfile)
    const other = store.list<Project>('project')[0]
    store.put('question', otherProfile, { ...q, id: 'shared', projectId: other.id, conceptIds: [] })
    assert.throws(() => store.remove('question', q.id), /프로필/)
    store.switchProfile(profile)
    store.remove('project', project.id)
    assert.equal(store.snapshot().questions.length, 0)
    // Concepts belong to the workspace and outlive the project.
    assert.equal(store.snapshot().concepts.length, 1)
    assert.equal(store.db.prepare('SELECT id FROM runs WHERE id=?').get('run'), undefined)
    assert.ok(store.image(image), 'other profile still references shared image')
    store.remove('workspace', project.workspaceId)
    assert.equal(store.snapshot().workspaces.length, 0)
    assert.equal(store.snapshot().concepts.length, 0)
    store.remove('profile', otherProfile)
    assert.equal(store.image(image), null)
    store.remove('profile', profile)
    assert.notEqual(store.active, profile)
    assert.equal(store.snapshot().profiles.length, 1)
    assert.equal(store.snapshot().projects.length, 1)
    const last = store.snapshot().projects[0]
    store.put('question', store.active, {
      ...q,
      id: 'last',
      projectId: last.id,
      conceptIds: [],
      turns: [turn({ id: 'last-t' })]
    })
    store.remove('question', 'last')
    assert.equal(store.snapshot().questions.length, 0)
    assert.equal(store.snapshot().projects.length, 1)
  } finally {
    store.close()
    rmSync(path, { recursive: true, force: true })
  }
})

test('records survive restart; restart recovery bumps revision; profile and project scope prevent cross-links', () => {
  const path = mkdtempSync(join(tmpdir(), 'fask-store-'))
  let store = new PersonalStore(path)
  try {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    store.rename('project', project.id, '이름 바꾼 프로젝트')
    store.rename('workspace', project.workspaceId, '이름 바꾼 워크스페이스')
    const concept = store.create('concept', '투명 창', project.id)
    const q: Question = {
      ...question('question-1', project.id, [
        turn({
          id: 'turn-1',
          answer: '부분 답변',
          model: 'fake',
          status: 'running',
          routingReason: 'test',
          revision: 3
        })
      ]),
      conceptIds: [concept]
    }
    store.put('question', profile, q)
    const other = store.create('project', '다른 프로젝트', project.workspaceId)
    const sameWorkspace = store.create('concept', '다른 개념', other)
    store.updateQuestion(q.id, { conceptIds: [concept, sameWorkspace] })
    const elsewhere = store.create('workspace', '다른 워크스페이스')
    const foreign = store.create('concept', '먼 개념', store.create('project', '먼 프로젝트', elsewhere))
    assert.throws(() => store.updateQuestion(q.id, { conceptIds: [foreign] }), /워크스페이스/)
    store.updateQuestion(q.id, { conceptIds: [concept] })
    const child = store.create('concept', '창 입력', project.id)
    store.editConceptInfo(child, { level: 'detail' })
    store.editConcept(child, '창 입력', concept)
    assert.throws(() => store.editConcept(concept, '투명 창', child), /하위/)
    assert.throws(() => store.mergeConcept(concept, child), /하위/)
    store.close()
    store = new PersonalStore(path)
    assert.equal(store.record<Project>('project', project.id).name, '이름 바꾼 프로젝트')
    assert.equal(store.snapshot().workspaces[0].name, '이름 바꾼 워크스페이스')
    assert.equal(store.snapshot().questions[0].turns[0].status, 'failed')
    assert.equal(store.snapshot().questions[0].turns[0].revision, 4)
    assert.equal(store.snapshot().questions[0].turns[0].answer, '부분 답변')
    const secondProfile = store.create('profile', '다른 사용자')
    store.switchProfile(secondProfile)
    assert.equal(store.snapshot().questions.length, 0)
    assert.throws(() => store.record('question', q.id), /프로필/)
    assert.throws(() => store.rename('project', project.id, '다른 사용자 변경'), /프로필/)
    store.switchProfile(profile)
    store.updateQuestion(q.id, { memo: '중요한 결정' })
    assert.equal(store.record<Question>('question', q.id).memo, '중요한 결정')
  } finally {
    store.close()
    rmSync(path, { recursive: true, force: true })
  }
})
test('text attachments preserve Unicode; binary and overlarge text are rejected', async () => {
  assert.deepEqual(
    await readAttachment(new File(['내용과 수식 설명'], 'notes.md', { type: 'text/markdown' })),
    { document: { name: 'notes.md', text: '내용과 수식 설명' } }
  )
  await assert.rejects(
    readAttachment(new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' })),
    /지원하지 않습니다/
  )
  await assert.rejects(readAttachment(new File(['a'.repeat(50001)], 'large.txt')), /50,000자/)
  await assert.rejects(readAttachment(new File(['a\0b'], 'binary.txt')), /텍스트 파일/)
})
test('deduplicated attachment is retained while another turn refers to it', () => {
  const path = mkdtempSync(join(tmpdir(), 'fask-images-')),
    store = new PersonalStore(path)
  try {
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const id = store.saveImage(image)
    assert.equal(store.saveImage(image), id)
    for (const qid of ['one', 'two'])
      store.put('question', store.active, question(qid, 'p', [turn({ id: `t-${qid}`, attachment: id })]))
    store.removeAttachment('one', 't-one')
    assert.equal(store.record<Question>('question', 'one').turns[0].attachment, null)
    assert.equal(store.image(id), image)
    store.removeAttachment('two', 't-two')
    assert.equal(store.image(id), null)
    assert.throws(() => store.removeAttachment('two', 'missing'), /대화 항목/)
    assert.throws(() => store.image('../outside.png'), /잘못된/)
  } finally {
    store.close()
    rmSync(path, { recursive: true, force: true })
  }
})
test('display copies are served when present and deleted with the original', () => {
  const path = mkdtempSync(join(tmpdir(), 'fask-display-')),
    store = new PersonalStore(path)
  try {
    const id = store.saveImage(`data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`)
    assert.match(store.displayImage(id) ?? '', /^data:image\/jpeg;base64,/)
    assert.equal(store.displayPath(id), `${store.imagePath(id)}.webp`)
    writeFileSync(store.displayPath(id), 'webp bytes')
    assert.equal(
      store.displayImage(id),
      `data:image/webp;base64,${Buffer.from('webp bytes').toString('base64')}`
    )
    assert.match(store.image(id) ?? '', /^data:image\/jpeg;base64,/)
    store.deleteImage(id)
    assert.equal(existsSync(store.imagePath(id)), false)
    assert.equal(existsSync(store.displayPath(id)), false)
    assert.equal(store.displayImage(id), null)
    store.deleteImage(id)
  } finally {
    store.close()
    rmSync(path, { recursive: true, force: true })
  }
})
test('endpoint normalization rejects remote hosts and avoids duplicate v1 paths', () => {
  assert.equal(
    normalizeEndpoint('http://localhost:8317/v1/v1/chat/completions/'),
    'http://localhost:8317/v1'
  )
  assert.equal(normalizeEndpoint('http://[::1]:8317'), 'http://[::1]:8317/v1')
  assert.throws(() => normalizeEndpoint('https://example.com/v1'), /로컬/)
  assert.throws(() => normalizeEndpoint('http://key@localhost:8317'), /경로/)
})
test('backup validation rejects cyclic concepts and cross-workspace references before restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-backup-')),
    store = new PersonalStore(dir)
  try {
    const project = store.list<Project>('project')[0]
    const a = store.create('concept', '부모', project.id),
      b = store.create('concept', '자식', project.id)
    const backup = { version: 3, snapshot: store.snapshot(), images: {} }
    assert.equal(validateBackup(backup).version, 3)
    backup.snapshot.concepts.find((c) => c.id === a)!.parentId = b
    backup.snapshot.concepts.find((c) => c.id === b)!.parentId = a
    assert.throws(() => validateBackup(backup), /백업/)
    backup.snapshot.concepts.find((c) => c.id === a)!.parentId = 'missing'
    assert.throws(() => validateBackup(backup), /백업/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('backup validation accepts tag roles, sources and tidy marks and rejects malformed ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-backup-roles-')),
    store = new PersonalStore(dir)
  try {
    const project = store.list<Project>('project')[0]
    const a = store.create('concept', '엔트로피', project.id),
      b = store.create('concept', '로그', project.id)
    const snapshot = store.snapshot()
    const q: Question = {
      ...question('q-roles', project.id, [turn({ id: 't-roles' })]),
      conceptIds: [a, b],
      conceptRoles: { [a]: 'focus', [b]: 'support' },
      conceptSources: { [a]: 'user' },
      tidyStay: project.workspaceId
    }
    snapshot.questions.push(q)
    snapshot.relations.push({
      id: 'r-roles',
      workspaceId: project.workspaceId,
      from: a,
      to: b,
      type: 'uses',
      questionId: q.id,
      turnIds: ['t-roles'],
      confidence: 0.9,
      approved: true,
      createdAt: new Date().toISOString(),
      invalidatedAt: null,
      evidence: '엔트로피는 로그로 정의된다.',
      tidyKept: true
    })
    Object.assign(snapshot.concepts.find((c) => c.id === a)!, { tidyKept: 'key', tidyNamed: '엔트로피' })
    snapshot.workspaces.find((w) => w.id === project.workspaceId)!.tidyCandidates = ['정보량']
    // validateBackup repairs its input in place, so every call gets its own copy.
    const check = (s: Snapshot): Snapshot => validateBackup({ version: 3, snapshot: s, images: {} }).snapshot
    const restored = check(structuredClone(snapshot))
    assert.deepEqual(restored.questions.find((x) => x.id === q.id)?.conceptRoles, { [a]: 'focus', [b]: 'support' })
    assert.equal(restored.relations.find((r) => r.id === 'r-roles')?.evidence, '엔트로피는 로그로 정의된다.')
    const cases: [string, (s: Snapshot, sq: Question) => void][] = [
      ['role key not linked', (_, sq) => (sq.conceptRoles = { missing: 'focus' })],
      ['unknown role', (_, sq) => (sq.conceptRoles = { [a]: 'main' as never })],
      ['unknown source', (_, sq) => (sq.conceptSources = { [a]: 'ai' as never })],
      ['array map', (_, sq) => (sq.conceptSources = [] as never)],
      ['tidyStay not a string', (_, sq) => (sq.tidyStay = 1 as never)],
      ['evidence not a string', (s) => (s.relations.find((r) => r.id === 'r-roles')!.evidence = 1 as never)],
      ['relation tidyKept', (s) => (s.relations.find((r) => r.id === 'r-roles')!.tidyKept = 'yes' as never)],
      ['concept tidyKept', (s) => (s.concepts.find((c) => c.id === a)!.tidyKept = 1 as never)],
      ['tidyCandidates', (s) => (s.workspaces.find((w) => w.id === project.workspaceId)!.tidyCandidates = [1] as never)]
    ]
    for (const [why, mutate] of cases) {
      const s = structuredClone(snapshot)
      mutate(s, s.questions.find((x) => x.id === q.id)!)
      assert.throws(() => check(s), /백업/, why)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('legacy rows keep valid tag roles/sources and merge them focus-first, user-first', () => {
  const row = (id: string, extra: object): unknown => ({
    id,
    projectId: 'p',
    conversationId: 'c',
    createdAt: id === 'a' ? '2024-01-01T00:00:00.000Z' : '2024-01-02T00:00:00.000Z',
    conceptIds: ['x', 'y'],
    ...extra
  })
  const first = normalizeLegacyQuestion(
    row('a', { conceptRoles: { x: 'support', y: 'support', z: 'focus' }, conceptSources: { x: 'model', y: 'bad' } })
  )
  assert.deepEqual(first.conceptRoles, { x: 'support', y: 'support' })
  assert.deepEqual(first.conceptSources, { x: 'model' })
  const [merged] = mergeLegacyQuestions([
    first,
    normalizeLegacyQuestion(row('b', { conceptRoles: { x: 'focus' }, conceptSources: { x: 'user', y: 'model' } }))
  ])
  assert.deepEqual(merged.conceptRoles, { x: 'focus', y: 'support' })
  assert.deepEqual(merged.conceptSources, { x: 'user', y: 'model' })
})

// Builds a 1.0.9 database by hand: schema 1 only, runs without turn_id, legacy question rows.
function legacyDatabase(dir: string, badProjectId = false): void {
  const db = new DatabaseSync(join(dir, 'fask.sqlite'))
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES(1);
    CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX records_scope ON records(profile,kind);
    CREATE TABLE preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY, question_id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');`)
  const put = (kind: string, profile: string, value: { id: string }): void => {
    db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(
      value.id,
      kind,
      profile,
      JSON.stringify(value)
    )
  }
  put('profile', '*', { id: 'P', name: '기본 프로필' })
  db.prepare('INSERT INTO preferences VALUES(?,?)').run('active', 'P')
  put('workspace', 'P', { id: 'W', profileId: 'P', name: 'w' })
  put('project', 'P', { id: 'PR', workspaceId: 'W', name: 'p', description: '' } as { id: string })
  for (const id of ['X', 'Y'])
    put('concept', 'P', { id, projectId: 'PR', name: id, parentId: null, manual: true } as {
      id: string
    })
  const legacy = (id: string, createdAt: string, extra: object): object => ({
    id,
    projectId: 'PR',
    conversationId: 'conv',
    createdAt,
    raw: id,
    refined: '',
    sent: id,
    answer: `${id} 답변`,
    model: '',
    actualModel: '',
    status: 'completed',
    complexity: 'simple',
    routingReason: '',
    conceptIds: [],
    suggestions: [],
    memo: '',
    important: false,
    attachment: null,
    error: '',
    ...extra
  })
  put('question', 'P', legacy('A', '2026-01-01T10:00:00.000Z', {
    memo: 'a',
    conceptIds: ['X'],
    ...(badProjectId ? { projectId: 1 } : {})
  }) as { id: string })
  put('question', 'P', legacy('B', '2026-01-01T10:05:00.000Z', {
    title: 'T',
    memo: 'b',
    conceptIds: ['Y'],
    important: true
  }) as { id: string })
  put('question', 'P', legacy('C', '2026-01-01T11:00:00.000Z', {
    conversationId: 'other'
  }) as { id: string })
  db.prepare('INSERT INTO runs(id,question_id,created_at,status,model) VALUES(?,?,?,?,?)').run(
    'r1',
    'B',
    '2026-01-01T10:05:00.000Z',
    'completed',
    ''
  )
  db.close()
}
test('legacy follow-up records merge into one question on upgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-migrate-'))
  legacyDatabase(dir)
  let store = new PersonalStore(dir)
  try {
    const questions = store.snapshot().questions
    assert.equal(questions.length, 2)
    const merged = questions.find((q) => q.id === 'A')!
    assert.deepEqual(
      merged.turns.map((t) => t.id),
      ['A', 'B']
    )
    assert.equal(merged.title, 'T')
    assert.equal(merged.memo, 'a\n\nb')
    assert.deepEqual(merged.conceptIds, ['X', 'Y'])
    assert.equal(merged.important, true)
    assert.deepEqual(store.findRun('r1'), {
      questionId: 'A',
      turnId: 'B',
      profile: 'P',
      requestHash: ''
    })
    const backupPath = join(dir, 'fask-pre-1.1.0.sqlite')
    assert.ok(existsSync(backupPath))
    const backup = new DatabaseSync(backupPath)
    assert.equal(
      backup.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='question'").get()?.n,
      3
    )
    backup.close()
    store.close()
    store = new PersonalStore(dir)
    assert.equal(store.snapshot().questions.length, 2)
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=2').get()?.n,
      1
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('migration failure rolls back and keeps legacy data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-migrate-fail-'))
  legacyDatabase(dir, true)
  try {
    assert.throws(() => new PersonalStore(dir), /레거시 질문 형식/)
    const db = new DatabaseSync(join(dir, 'fask.sqlite'))
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='question'").get()?.n,
      3
    )
    assert.ok(
      !db
        .prepare('PRAGMA table_info(runs)')
        .all()
        .some((c) => c.name === 'turn_id')
    )
    assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version=2').get(), undefined)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('normalizeLegacyQuestion fills missing fields of early 1.0.x records', () => {
  const q = normalizeLegacyQuestion({
    id: 'x',
    projectId: 'p',
    conversationId: 'c',
    createdAt: '2026-01-01T00:00:00Z'
  })
  assert.equal(q.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(q.raw, '')
  assert.equal(q.sent, '(질문 내용 없음)')
  assert.equal(q.status, 'failed')
  assert.equal(q.complexity, 'unknown')
  assert.deepEqual(q.conceptIds, [])
  assert.equal(q.important, false)
  assert.equal(q.attachment, null)
  assert.deepEqual(q.documents, [])
  assert.throws(() => normalizeLegacyQuestion({ id: 'x', projectId: 1 }), /레거시/)
})
test('backup v1 conversations import as one question', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-backup-v1-')),
    store = new PersonalStore(dir)
  try {
    const project = store.list<Project>('project')[0]
    const legacy = (id: string, createdAt: string): object => ({
      id,
      projectId: project.id,
      conversationId: 'conv',
      createdAt,
      raw: id,
      refined: '',
      sent: id,
      answer: '',
      model: '',
      actualModel: '',
      status: 'completed',
      complexity: 'simple',
      routingReason: '',
      conceptIds: [],
      suggestions: [],
      memo: '',
      important: false,
      attachment: null,
      error: ''
    })
    const backup = validateBackup({
      version: 1,
      snapshot: {
        ...store.snapshot(),
        questions: [
          legacy('second', '2026-01-01T10:05:00.000Z'),
          legacy('first', '2026-01-01T10:00:00.000Z')
        ]
      },
      images: {}
    })
    assert.equal(backup.version, 3)
    assert.equal(backup.snapshot.questions.length, 1)
    assert.deepEqual(
      backup.snapshot.questions[0].turns.map((t) => t.id),
      ['first', 'second']
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('cleanTitle keeps one plain line of at most 60 characters', () => {
  assert.equal(cleanTitle('"제목: 투명 오버레이 입력 처리."\n둘째 줄'), '투명 오버레이 입력 처리')
  assert.equal(cleanTitle('# Title: X'), 'X')
  assert.equal(cleanTitle('가'.repeat(80)).length, 60)
  assert.equal(cleanTitle('  \n '), '')
})
test('recordAsk commits question and run atomically; replays identical requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-record-')),
    store = new PersonalStore(dir)
  try {
    const project = store.list<Project>('project')[0]
    const input = {
      requestId: 'r-atomic',
      requestHash: 'h1',
      profile: store.active,
      projectId: project.id,
      turn: turn({ id: 'atomic-turn', status: 'running' }),
      saveOnly: false
    }
    store.db.exec(
      "CREATE TEMP TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected'); END;"
    )
    assert.throws(() => store.recordAsk(input), /injected/)
    assert.equal(store.snapshot().questions.length, 0)
    assert.equal(store.findRun('r-atomic'), undefined)
    store.db.exec('DROP TRIGGER fail_run')
    const first = store.recordAsk(input)
    assert.equal(first.replay, false)
    assert.equal(store.snapshot().questions.length, 1)
    assert.equal(store.snapshot().questions[0].turns.length, 1)
    const again = store.recordAsk(input)
    assert.deepEqual(again, { questionId: first.questionId, turnId: first.turnId, replay: true })
    assert.equal(store.snapshot().questions[0].turns.length, 1)
    assert.throws(
      () => store.recordAsk({ ...input, requestHash: 'h2' }),
      /같은 요청 ID로 다른 내용을 보낼 수 없습니다/
    )
    assert.equal(store.snapshot().questions[0].turns.length, 1)
    // One running turn per question, including save-only follow-ups.
    const followUp = {
      ...input,
      requestId: 'r-follow',
      questionId: first.questionId,
      turn: turn({ id: 'follow-turn' })
    }
    assert.throws(() => store.recordAsk(followUp), /이전 답변이 끝난 뒤/)
    assert.throws(() => store.recordAsk({ ...followUp, saveOnly: true }), /이전 답변이 끝난 뒤/)
    store.updateTurn(first.questionId, first.turnId, { status: 'completed', revision: 1 })
    assert.equal(store.recordAsk(followUp).replay, false)
    assert.deepEqual(
      store.record<Question>('question', first.questionId).turns.map((t) => t.id),
      ['atomic-turn', 'follow-turn']
    )
    assert.throws(
      () => store.recordAsk({ ...followUp, requestId: 'r-x', projectId: 'elsewhere' }),
      /대화를 찾을 수 없습니다/
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('moveQuestion keeps links within a workspace and clears them across workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-move-')),
    store = new PersonalStore(dir)
  try {
    const project = store.list<Project>('project')[0]
    const base = { requestHash: 'h', profile: store.active, projectId: project.id, saveOnly: true }
    const { questionId } = store.recordAsk({
      ...base,
      requestId: 'm1',
      turn: turn({ id: 'move-1' })
    })
    store.recordAsk({ ...base, requestId: 'm2', questionId, turn: turn({ id: 'move-2' }) })
    const concept = store.create('concept', '개념', project.id)
    store.updateQuestion(questionId, {
      conceptIds: [concept],
      conceptTurns: { [concept]: ['move-2'] },
      suggestions: ['제안']
    })
    const sibling = store.create('project', '같은 워크스페이스', project.workspaceId)
    store.moveQuestion(questionId, sibling)
    const kept = store.record<Question>('question', questionId)
    assert.deepEqual(kept.conceptIds, [concept])
    assert.deepEqual(kept.conceptTurns, { [concept]: ['move-2'] })
    assert.deepEqual(kept.suggestions, ['제안'])
    store.put('question', store.active, { ...kept, extractedTurns: 2 })
    const workspace = store.create('workspace', '다른 워크스페이스')
    const target = store.create('project', '다른 프로젝트', workspace)
    store.moveQuestion(questionId, target)
    const moved = store.record<Question>('question', questionId)
    assert.equal(moved.projectId, target)
    assert.deepEqual(
      moved.turns.map((t) => t.id),
      ['move-1', 'move-2']
    )
    assert.deepEqual(moved.conceptIds, [])
    assert.deepEqual(moved.suggestions, [])
    assert.deepEqual(moved.conceptTurns, {})
    assert.equal(moved.extractedTurns, 0)
    assert.throws(() => store.moveQuestion(questionId, 'missing-project'))
    assert.equal(store.record<Question>('question', questionId).projectId, target)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('applyDelta and mergeLive order revisions and detect gaps', () => {
  let live = { turnId: 't', answer: '', revision: 0 }
  for (const [revision, delta] of [
    [1, 'a'],
    [2, 'b'],
    [3, 'c']
  ] as const)
    live = applyDelta(live, { turnId: 't', revision, delta }).live
  assert.deepEqual(live, { turnId: 't', answer: 'abc', revision: 3 })
  assert.deepEqual(applyDelta(live, { turnId: 't', revision: 2, delta: 'b' }), {
    live,
    resync: false
  })
  assert.deepEqual(applyDelta(live, { turnId: 't', revision: 5, delta: 'e' }), {
    live,
    resync: true
  })
  assert.deepEqual(applyDelta(live, { turnId: 'u', revision: 1, delta: 'x' }), {
    live: { turnId: 'u', answer: 'x', revision: 1 },
    resync: false
  })
  const older = { turnId: 't', answer: 'ab', revision: 2 }
  assert.equal(mergeLive(live, older, 't'), live)
  const newer = { turnId: 't', answer: 'abcd', revision: 4 }
  assert.equal(mergeLive(live, newer, 't'), newer)
  const other = { turnId: 'u', answer: 'z', revision: 9 }
  assert.equal(mergeLive(live, other, 't'), live)
  assert.equal(mergeLive(live, other, 'u'), other)
})
test('reconcileTurnState recovers a lost done and ignores stale states', () => {
  const live = { turnId: 't', answer: 'abc', revision: 4 }
  const state = (status: Turn['status'], revision: number, answer: string): TurnState => ({
    status,
    revision,
    answer,
    error: '',
    actualModel: 'm'
  })
  const done = reconcileTurnState(live, state('completed', 6, 'abcdef'), 't', 't')
  assert.equal(done.live.answer, 'abcdef')
  assert.equal(done.finished?.status, 'completed')
  const running = reconcileTurnState(live, state('running', 5, 'abcd'), 't', 't')
  assert.equal(running.live.answer, 'abcd')
  assert.equal(running.finished, null)
  const stale = reconcileTurnState(live, state('failed', 3, 'ab'), 't', 't')
  assert.equal(stale.live, live)
  assert.equal(stale.finished, null)
  const elsewhere = reconcileTurnState(live, state('completed', 9, 'zzz'), 'u', 't')
  assert.equal(elsewhere.live, live)
  assert.equal(elsewhere.finished, null)
})
test('mobile hub serves TLS with pinned cert, header-only auth, origin and method allowlist', async () => {
  const tls = await createHubCertificate()
  const hub = new PersonalHub(
    async (_caller, name, args) => ({ name, args }),
    new Set(['snapshot']),
    '1.1.0',
    NO_PAIR
  )
  const results = await hub.start(['127.0.0.1'], 0, tokenAuth('tok'), tls)
  try {
    assert.equal(results.length, 1)
    assert.equal(results[0].address, '127.0.0.1')
    assert.equal(results[0].error, '')
    assert.ok(results[0].port > 0)
    const port = results[0].port
    const auth = { Authorization: 'Bearer tok' }
    const call = (
      path: string,
      options: { method?: string; headers?: Record<string, string | number>; body?: string } = {}
    ): Promise<{ status: number; body: string; fingerprint: string; acao: string }> =>
      new Promise((resolve, reject) => {
        let fingerprint = ''
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method: options.method ?? 'GET',
            headers: options.headers,
            rejectUnauthorized: false,
            agent: false
          },
          (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                fingerprint,
                acao: String(res.headers['access-control-allow-origin'] ?? '')
              })
            )
          }
        )
        req.on('socket', (socket) => {
          if (socket instanceof TLSSocket)
            socket.once('secureConnect', () => {
              fingerprint = createHash('sha256')
                .update(socket.getPeerCertificate().raw)
                .digest('base64url')
            })
        })
        req.on('error', reject)
        if (options.body) req.write(options.body)
        req.end()
      })
    const health = await call('/health', { headers: auth })
    assert.equal(health.status, 200)
    assert.deepEqual(JSON.parse(health.body), { app: 'fask', version: '1.1.0' })
    assert.equal(health.fingerprint, tls.fingerprint)
    assert.equal((await call('/health')).status, 401)
    assert.equal((await call('/health?token=tok')).status, 401)
    assert.equal((await call('/events?token=tok')).status, 401)
    assert.equal((await call('/health', { headers: { ...auth, Origin: 'http://evil.test' } })).status, 403)
    const preflight = await call('/rpc/snapshot', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' }
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.acao, 'http://localhost:5173')
    assert.equal(
      (await call('/rpc/ask', { method: 'POST', headers: auth, body: '{"args":[]}' })).status,
      404
    )
    const rpc = await call('/rpc/snapshot', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: '{"args":[1]}'
    })
    assert.equal(rpc.status, 200)
    assert.deepEqual(JSON.parse(rpc.body), { result: { name: 'snapshot', args: [1] } })
    const tooLarge = await call('/rpc/snapshot', {
      method: 'POST',
      headers: { ...auth, 'Content-Length': 40 * 1024 * 1024 + 1 },
      body: '{'
    }).catch((e: Error) => ({ status: -1, body: e.message }))
    assert.equal(tooLarge.status, 413)
    const received = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/events',
          headers: auth,
          rejectUnauthorized: false,
          agent: false
        },
        (res) => {
          let text = ''
          res.on('data', (c) => {
            text += c
            if (text.includes(': connected')) hub.broadcast('stream', { turnId: 'x' })
            if (text.includes('"turnId":"x"')) {
              req.destroy()
              resolve(text)
            }
          })
        }
      )
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)))
      req.end()
    })
    assert.match(received, /event: stream\ndata: \{"turnId":"x"\}/)
    const elsewhere = new PersonalHub(async () => null, new Set(), '1.1.0', NO_PAIR)
    const missing = await elsewhere.start(['203.0.113.7'], 0, tokenAuth('tok'), tls)
    assert.match(missing[0].error, /현재 네트워크에 없는 주소입니다/)
    assert.equal(elsewhere.running, false)
    await elsewhere.stop()
  } finally {
    await hub.stop()
  }
})
test('local proxy model auth, split SSE, Unicode, incomplete response, errors, and cancellation', async () => {
  let seenAuth = '',
    mode = 'normal'
  const server = createServer((req, res) => {
    seenAuth = String(req.headers.authorization)
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'fast' }, { id: 'deep' }] }))
      return
    }
    if (mode === 'unauthorized') {
      res.writeHead(401)
      res.end()
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    if (mode === 'wait') {
      res.write(': ping\n\n')
      return
    }
    const first = Buffer.from(
      'data: {"model":"actual","choices":[{"delta":{"content":"안녕"}}]}\r\n\r\n'
    )
    res.write(first.subarray(0, 66))
    setTimeout(() => {
      res.write(first.subarray(66))
      res.end(
        mode === 'broken'
          ? ''
          : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      )
    }, 5)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number },
    endpoint = `http://127.0.0.1:${address.port}/v1`
  try {
    assert.deepEqual(await localModels(endpoint, 'local-secret'), ['deep', 'fast'])
    assert.equal(seenAuth, 'Bearer local-secret')
    let output = '',
      actual = ''
    await streamChat(
      endpoint,
      'local-secret',
      'fast',
      [{ role: 'user', content: '안녕' }],
      new AbortController().signal,
      (t, m) => {
        output += t
        actual = m || ''
      }
    )
    assert.equal(output, '안녕')
    assert.equal(actual, 'actual')
    mode = 'broken'
    await assert.rejects(
      streamChat(endpoint, '', 'fast', [], new AbortController().signal, () => {}),
      /완료 신호/
    )
    mode = 'unauthorized'
    await assert.rejects(
      streamChat(endpoint, '', 'fast', [], new AbortController().signal, () => {}),
      /접속 키/
    )
    mode = 'wait'
    const abort = new AbortController()
    const pending = streamChat(endpoint, '', 'fast', [], abort.signal, () => {})
    setTimeout(() => abort.abort(), 25)
    await assert.rejects(pending)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// ── Relay ── a fake relay with the real wire protocol, minus window policing and rate limits.
interface FakeRelay {
  url: string
  host: () => WebSocket | null
  maxFrame: { up: number; down: number }
  /** Close codes the relay saw from PC-side data sockets. */
  dataCloses: number[]
  close: () => Promise<void>
}
async function fakeRelay(): Promise<FakeRelay> {
  const server = createServer()
  // workerd negotiates permessage-deflate whenever a client offers it; so does this relay.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  let host: WebSocket | null = null
  const pending = new Map<string, WebSocket>()
  const maxFrame = { up: 0, down: 0 }
  const dataCloses: number[] = []
  const forwardClose = (code: number): number => (code >= 3000 || code === 1000 || code === 1009 ? code : 1000)
  const pipe = (from: WebSocket, to: WebSocket, dir: 'up' | 'down'): void => {
    from.on('message', (msg: Buffer, isBinary) => {
      maxFrame[dir] = Math.max(maxFrame[dir], msg.length)
      if (to.readyState === WebSocket.OPEN) to.send(msg, { binary: isBinary })
    })
    from.on('close', (code) => {
      if (dir === 'down') dataCloses.push(code)
      if (to.readyState === WebSocket.OPEN) to.close(forwardClose(code))
    })
  }
  const reject = (socket: Duplex, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  }
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? ''
    if (url === '/v1/host')
      wss.handleUpgrade(req, socket, head, (ws) => {
        host = ws
        ws.on('close', () => {
          if (host === ws) host = null
        })
      })
    else if (url.startsWith('/v1/connect/')) {
      const current = host
      if (!current || current.readyState !== WebSocket.OPEN) return reject(socket, '503 Service Unavailable')
      wss.handleUpgrade(req, socket, head, (client) => {
        const id = randomBytes(16).toString('base64url')
        pending.set(id, client)
        current.send(JSON.stringify({ type: 'open', id }))
      })
    } else if (url.startsWith('/v1/accept/')) {
      const id = url.slice('/v1/accept/'.length)
      const client = pending.get(id)
      if (!client) return reject(socket, '404 Not Found')
      pending.delete(id)
      wss.handleUpgrade(req, socket, head, (data) => {
        client.send('ready')
        pipe(client, data, 'up')
        pipe(data, client, 'down')
      })
    } else reject(socket, '404 Not Found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}`,
    host: () => host,
    maxFrame,
    dataCloses,
    close: async () => {
      for (const ws of wss.clients) ws.terminate()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
const RELAY_LIMITS: HubLimits = {
  relayHandshakeMs: 300,
  relayAuthMs: 300,
  relayMaxStreams: 32,
  relayMaxUnauthenticated: 8
}
const RELAY_KEY = randomBytes(32).toString('base64url')
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
/** Phone side: connect through the relay and wrap the socket once the relay says `ready`. */
function phoneStream(relay: FakeRelay): Promise<{ ws: WebSocket; stream: RelayStream }> {
  const ws = new WebSocket(`${relay.url}/v1/connect/${relayRoom(RELAY_KEY)}`)
  return new Promise((resolve, reject) => {
    ws.once('error', reject)
    ws.once('close', (code) => reject(new Error(`relay closed ${code} before ready`)))
    ws.once('message', (msg, isBinary) => {
      if (isBinary || String(msg) !== 'ready') return reject(new Error('expected ready'))
      ws.on('error', () => {})
      resolve({ ws, stream: new RelayStream(ws) })
    })
  })
}
async function phoneTls(relay: FakeRelay): Promise<{ ws: WebSocket; stream: RelayStream; tls: TLSSocket }> {
  const { ws, stream } = await phoneStream(relay)
  const tls = tlsConnect({ socket: stream, rejectUnauthorized: false })
  tls.on('error', () => {})
  await once(tls, 'secureConnect')
  return { ws, stream, tls }
}
function relayHttp(
  tls: TLSSocket,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { createConnection: () => tls, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() })
        )
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}
async function relayedHub(
  limits: HubLimits = RELAY_LIMITS
): Promise<{ hub: PersonalHub; relay: FakeRelay; hubRelay: HubRelay; tls: HubTls }> {
  const tls = await createHubCertificate()
  const hub = new PersonalHub(async (_caller, _name, args) => args[0], new Set(['snapshot']), '1.1.0', NO_PAIR, limits)
  await hub.start([], 0, tokenAuth('tok'), tls)
  const relay = await fakeRelay()
  const hubRelay = new HubRelay((stream) => hub.inject(stream))
  hubRelay.start(relay.url, RELAY_KEY)
  await until(() => hubRelay.state === 'online', 3000, 'relay registration')
  return { hub, relay, hubRelay, tls }
}
const AUTH = { Authorization: 'Bearer tok' }

test('relay url normalization keeps only a bare wss origin or loopback ws', () => {
  assert.equal(normalizeRelayUrl(' wss://relay.example.workers.dev/ '), 'wss://relay.example.workers.dev')
  assert.equal(normalizeRelayUrl('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787')
  for (const bad of ['ws://example.com', 'https://x.dev', 'wss://x.dev/path', 'wss://x.dev/?a=1', 'wss://u:p@x.dev', 'x'])
    assert.equal(normalizeRelayUrl(bad), null, bad)
  assert.equal(relayRoom(RELAY_KEY), createHash('sha256').update(RELAY_KEY).digest('base64url'))
})

test('relay serves pinned TLS', async () => {
  const { hub, relay, hubRelay, tls } = await relayedHub()
  try {
    const phone = await phoneTls(relay)
    const fingerprint = createHash('sha256').update(phone.tls.getPeerCertificate().raw).digest('base64url')
    assert.equal(fingerprint, tls.fingerprint)
    const health = await relayHttp(phone.tls, '/health', { headers: { ...AUTH, Connection: 'keep-alive' } })
    assert.equal(health.status, 200)
    assert.equal(JSON.parse(health.body).app, 'fask')
    const big = randomBytes(6 * 1024 * 1024).toString('base64')
    const rpc = await relayHttp(phone.tls, '/rpc/snapshot', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [big] })
    })
    assert.equal(rpc.status, 200)
    assert.equal(JSON.parse(rpc.body).result, big)
    assert.ok(relay.maxFrame.up > 0 && relay.maxFrame.up <= 16385, `up ${relay.maxFrame.up}`)
    assert.ok(relay.maxFrame.down > 0 && relay.maxFrame.down <= 16385, `down ${relay.maxFrame.down}`)
  } finally {
    hubRelay.stop()
    await hub.stop()
    await relay.close()
  }
})

test('relay unauthenticated connections are bounded', async () => {
  const { hub, relay, hubRelay } = await relayedHub()
  try {
    // (a) No ClientHello: the handshake timeout drops the stream.
    const silent = await phoneStream(relay)
    await within(once(silent.ws, 'close'), 1000, 'handshake timeout close')
    // (b) TLS done but no request: the auth deadline drops it.
    const idle = await phoneTls(relay)
    await within(once(idle.ws, 'close'), 1000, 'auth deadline close')
    // (c) A request without the token gets one 401 and the connection closes.
    const anonymous = await phoneTls(relay)
    const closed = once(anonymous.ws, 'close')
    const denied = await relayHttp(anonymous.tls, '/health', { headers: { Connection: 'keep-alive' } })
    assert.equal(denied.status, 401)
    assert.equal(denied.headers.connection, 'close')
    await within(closed, 1000, '401 close')
    // (e) Authenticated and idle: keep-alive timeout closes it.
    const authed = await phoneTls(relay)
    const authedClosed = once(authed.ws, 'close')
    const started = Date.now()
    assert.equal((await relayHttp(authed.tls, '/health', { headers: { ...AUTH, Connection: 'keep-alive' } })).status, 200)
    await within(authedClosed, 7000, 'keep-alive close')
    assert.ok(Date.now() - started > 1000, 'authenticated connection outlived the auth deadline')
    // (f) An authenticated event stream stays open past the auth deadline.
    const events = await phoneTls(relay)
    let eventsClosed = false
    events.ws.once('close', () => (eventsClosed = true))
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ createConnection: () => events.tls, path: '/events', headers: AUTH }, (res) => {
        res.once('data', (c: Buffer) => resolve(String(c)))
      })
      req.on('error', reject)
      req.end()
    })
    assert.match(body, /: connected/)
    // Real time on purpose: the hub's auth deadline is a wall-clock timer on a live socket.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(eventsClosed, false)
  } finally {
    hubRelay.stop()
    await hub.stop()
    await relay.close()
  }
  // (d) With a long auth deadline, 8 unauthenticated streams fill the cap; the 9th is dropped at once.
  const capped = await relayedHub({ ...RELAY_LIMITS, relayAuthMs: 10000 })
  try {
    const held = await Promise.all(Array.from({ length: 8 }, () => phoneTls(capped.relay)))
    const ninth = await phoneStream(capped.relay)
    await within(once(ninth.ws, 'close'), 1000, 'over-cap close')
    for (const h of held) assert.equal(h.ws.readyState, WebSocket.OPEN)
  } finally {
    capped.hubRelay.stop()
    await capped.hub.stop()
    await capped.relay.close()
  }
})

test('RelayStream backpressure', async () => {
  const relay = await fakeRelay()
  const pcSide: RelayStream[] = []
  const pcSockets: WebSocket[] = []
  const host = new WebSocket(`${relay.url}/v1/host`)
  await once(host, 'open')
  host.on('message', (msg) => {
    const ws = new WebSocket(`${relay.url}/v1/accept/${JSON.parse(String(msg)).id}`)
    ws.once('open', () => {
      pcSockets.push(ws)
      const stream = new RelayStream(ws)
      stream.on('error', () => {})
      pcSide.push(stream)
    })
  })
  try {
    const phone = await phoneStream(relay)
    await until(() => pcSide.length === 1, 2000, 'accept')
    const [pc] = pcSide
    const up = randomBytes(16 * 1024 * 1024)
    const down = randomBytes(16 * 1024 * 1024)
    const write = async (stream: RelayStream, data: Buffer): Promise<void> => {
      for (let offset = 0; offset < data.length; offset += 65536)
        if (!stream.write(data.subarray(offset, offset + 65536))) await once(stream, 'drain')
    }
    /** Consumes 64 KiB per 20 ms, well below what the sender can produce. */
    const slowRead = async (stream: RelayStream, length: number): Promise<Buffer> => {
      const chunks: Buffer[] = []
      let got = 0
      while (got < length) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const n = Math.min(65536, stream.readableLength)
        const chunk: Buffer | null = n ? stream.read(n) : (stream.read(0), null)
        if (chunk) {
          chunks.push(chunk)
          got += chunk.length
        }
      }
      return Buffer.concat(chunks)
    }
    const violations: string[] = []
    const sampler = setInterval(() => {
      for (const [name, sender, ws, receiver] of [
        ['up', phone.stream, phone.ws, pc],
        ['down', pc, pcSockets[0], phone.stream]
      ] as const) {
        if (sender.unacked > RELAY_WINDOW) violations.push(`${name} unacked ${sender.unacked}`)
        if (ws.bufferedAmount > RELAY_WINDOW + 16385) violations.push(`${name} buffered ${ws.bufferedAmount}`)
        if (receiver.readableLength > RELAY_WINDOW + 16384) violations.push(`${name} readable ${receiver.readableLength}`)
      }
    }, 5)
    const [gotUp, gotDown] = await Promise.all([
      slowRead(pc, up.length),
      slowRead(phone.stream, down.length),
      write(phone.stream, up),
      write(pc, down)
    ])
    clearInterval(sampler)
    assert.deepEqual(violations, [])
    assert.ok(gotUp.equals(up), 'upstream bytes intact')
    assert.ok(gotDown.equals(down), 'downstream bytes intact')
    assert.ok(phone.stream.maxUnacked <= RELAY_WINDOW && pc.maxUnacked <= RELAY_WINDOW)
    assert.ok(phone.stream.maxFrameSent <= 16385 && pc.maxFrameSent <= 16385)
    assert.ok(relay.maxFrame.up <= 16385 && relay.maxFrame.down <= 16385)

    // A peer that ignores the window: 17 unacked 16 KiB frames make the stream close with 4400.
    const rogue = new WebSocket(`${relay.url}/v1/connect/${relayRoom(RELAY_KEY)}`)
    await once(rogue, 'message')
    await until(() => pcSide.length === 2, 2000, 'second accept')
    const rogueClosed = once(rogue, 'close')
    for (let i = 0; i < 17; i++) rogue.send(Buffer.concat([Buffer.from([0]), randomBytes(16384)]))
    const [code] = await within(rogueClosed, 2000, 'window violation close')
    assert.equal(code, 4400)
    assert.ok(pcSide[1].destroyed)
  } finally {
    host.terminate()
    await relay.close()
  }
})

test('relay stop and reset tear down sessions', async () => {
  const { hub, relay, hubRelay } = await relayedHub()
  try {
    const phone = await phoneTls(relay)
    const connected = new Promise<void>((resolve, reject) => {
      const req = httpRequest({ createConnection: () => phone.tls, path: '/events', headers: AUTH }, (res) =>
        res.once('data', () => resolve())
      )
      req.on('error', reject)
      req.end()
    })
    await connected
    const closed = once(phone.ws, 'close')
    hubRelay.stop()
    await hub.stop()
    await within(closed, 2000, 'phone close after stop')
    assert.equal(hubRelay.state, 'off')
    await assert.rejects(phoneStream(relay), /503/)
  } finally {
    hubRelay.stop()
    await hub.stop()
    await relay.close()
  }
})

test('relay reconnects after the control socket drops', async () => {
  const { hub, relay, hubRelay } = await relayedHub()
  try {
    const first = relay.host()
    first?.terminate()
    await until(() => hubRelay.state !== 'online', 2000, 'drop noticed')
    await until(() => hubRelay.state === 'online' && relay.host() !== first, 3000, 'reconnect')
  } finally {
    hubRelay.stop()
    await hub.stop()
    await relay.close()
  }
})

// ── Device pairing codes and linked PCs ──
interface PeerHost {
  tls: HubTls
  hub: PersonalHub
  pairing: PairingHost
  grants: Map<string, string>
  questions: Map<string, string>
  port: number
  tick: (ms: number) => void
  restart: () => Promise<unknown>
  /**
   * While a gate is set, snapshot reads answer only after it resolves, with the state from before it.
   * Resolves once a read is waiting at the gate.
   */
  holdSnapshot: (gate: Promise<void> | null) => Promise<void>
}
async function peerHost(isTailscale: (address: string) => boolean = () => true): Promise<PeerHost> {
  const tls = await createHubCertificate()
  let clock = Date.now()
  const pairing = new PairingHost('host-pc', () => clock)
  const grants = new Map<string, string>()
  const questions = new Map([['q1', 'first']])
  let held: { gate: Promise<void>; entered: () => void } | null = null
  const mint = (name: string): PairPayload => {
    const token = randomBytes(32).toString('base64url')
    const id = `peer-${grants.size}-${name}`
    grants.set(token, id)
    return { kind: 'pc', peerId: id, token, certPem: tls.cert, hostName: 'host-pc', addresses: ['127.0.0.1'], relay: null }
  }
  const hub: PersonalHub = new PersonalHub(
    async (caller, name, args) => {
      assert.equal(caller.kind, 'peer')
      if (name === 'snapshot') {
        const value = {
          profiles: [],
          activeProfileId: 'p',
          workspaces: [{ id: 'w1', profileId: 'p', name: 'Host WS' }],
          projects: [{ id: 'pr1', workspaceId: 'w1', name: 'P', description: '' }],
          concepts: [],
          questions: [...questions].map(([id, title]) => ({ ...question(id, 'pr1', [turn()]), title })),
          settings: {},
          storageBytes: 0
        }
        if (held) {
          held.entered()
          await held.gate
        }
        return value
      }
      if (name === 'rename') {
        await new Promise((r) => setTimeout(r, Math.random() * 20))
        questions.set(String(args[1]), String(args[2]))
        hub.broadcast('changed', {})
        return null
      }
      throw new Error('지원하지 않는 요청입니다.')
    },
    new Set(['snapshot', 'rename']),
    '1.1.2',
    {
      ke1: (b) => pairing.ke1(b),
      ke3: (b) =>
        pairing.ke3(b, (kind, name) =>
          kind === 'mobile' ? { kind: 'mobile', pairing: `fask://pair?v=1&fp=${tls.fingerprint}&t=mobile` } : mint(name)
        )
    },
    undefined,
    isTailscale
  )
  const auth = (bearer: string): HubCaller | null => (grants.has(bearer) ? { kind: 'peer', id: grants.get(bearer)! } : null)
  const [bound] = await hub.start(['127.0.0.1'], 0, auth, tls)
  return {
    tls,
    hub,
    pairing,
    grants,
    questions,
    port: bound.port,
    tick: (ms) => {
      clock += ms
    },
    restart: () => hub.start(['127.0.0.1'], bound.port, auth, tls),
    holdSnapshot: (gate) => {
      const entered = Promise.withResolvers<void>()
      held = gate ? { gate, entered: entered.resolve } : null
      return entered.promise
    }
  }
}
/** Unpinned POST to a hub's /pair routes over direct TLS, reporting the observed fingerprint. */
const directPost =
  (port: number): PairPost =>
  (path, body) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          rejectUnauthorized: false,
          agent: false,
          headers: { 'Content-Type': 'application/json' }
        },
        (res) => {
          const fingerprint = createHash('sha256')
            .update((res.socket as TLSSocket).getPeerCertificate().raw)
            .digest('base64url')
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || 'null'), fingerprint })
          )
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
const wrongSecret = (code: string): string => code.slice(0, 3) + (code.slice(3) === '00000' ? '11111' : '00000')
async function linked(h: PeerHost, name = 'client'): Promise<PeerLink> {
  const { code } = await h.pairing.begin(h.tls.fingerprint)
  return pairWithHost({ kind: 'direct', address: '127.0.0.1', port: h.port }, code, name)
}

test('pair code: direct pairing pins the host and is single use', async () => {
  const h = await peerHost()
  try {
    const { code } = await h.pairing.begin(h.tls.fingerprint)
    const link = await pairWithHost({ kind: 'direct', address: '127.0.0.1', port: h.port }, code, 'client')
    assert.equal(link.fingerprint, h.tls.fingerprint)
    assert.equal(link.name, 'host-pc')
    const conn = new PeerConnection(link, () => {}, () => {}, h.port)
    try {
      const snapshot = (await conn.rpc('snapshot', [])) as Snapshot
      assert.equal(snapshot.workspaces[0].name, 'Host WS')
    } finally {
      conn.close()
    }
    await assert.rejects(
      pairWithHost({ kind: 'direct', address: '127.0.0.1', port: h.port }, code, 'again'),
      /연결 코드가 없거나 만료되었습니다/
    )
  } finally {
    await h.hub.stop()
  }
})

test('pair code: relay rendezvous pairs; a pairing socket serves nothing else', async () => {
  const h = await peerHost(() => false)
  const relay = await fakeRelay()
  const pairRelay = new HubRelay((s) => h.hub.inject(s, 'pair'))
  try {
    const { code, rendezvous } = await h.pairing.begin(h.tls.fingerprint)
    pairRelay.start(relay.url, await pairRelayKey(rendezvous))
    await until(() => pairRelay.state === 'online', 3000, 'rendezvous registration')
    const link = await pairWithHost({ kind: 'relay', url: relay.url }, code, 'client')
    assert.equal(link.fingerprint, h.tls.fingerprint)
    const { socket } = await dial({ kind: 'relay', url: relay.url, room: relayRoom(await pairRelayKey(rendezvous)) }, h.tls.fingerprint)
    const res = await relayHttp(socket, '/rpc/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
      body: '{"args":[]}'
    })
    assert.equal(res.status, 404)
    socket.destroy()
  } finally {
    pairRelay.stop()
    await h.hub.stop()
    await relay.close()
  }
})

test('pair code: wrong secret, attempt limit, public routing part, phone kind, unknown kind', async () => {
  const h = await peerHost()
  const post = directPost(h.port)
  try {
    let { code } = await h.pairing.begin(h.tls.fingerprint)
    for (let i = 0; i < 5; i++)
      await assert.rejects(runPairClient(post, wrongSecret(code), 'pc', 'c'), /연결 코드가 올바르지 않습니다/)
    await assert.rejects(runPairClient(post, code, 'pc', 'c'), /연결 코드가 없거나 만료되었습니다/)
    ;({ code } = await h.pairing.begin(h.tls.fingerprint))
    const otherRoute = (code[0] === '0' ? '1' : '0') + code.slice(1)
    const link = await pairWithHost({ kind: 'direct', address: '127.0.0.1', port: h.port }, otherRoute, 'c')
    assert.equal(link.fingerprint, h.tls.fingerprint)
    const grants = h.grants.size
    ;({ code } = await h.pairing.begin(h.tls.fingerprint))
    const phone = await runPairClient(post, code, 'mobile', '휴대폰')
    assert.deepEqual(phone.payload, { kind: 'mobile', pairing: `fask://pair?v=1&fp=${h.tls.fingerprint}&t=mobile` })
    assert.equal(h.grants.size, grants)
    await h.pairing.begin(h.tls.fingerprint)
    const tablet = await post('/pair/ke1', { ke1: [1, 2, 3], name: 'x', kind: 'tablet' })
    assert.equal(tablet.status, 400)
  } finally {
    await h.hub.stop()
  }
})

test('pair code: concurrent first messages get at most one session and count against the limit', async () => {
  const h = await peerHost()
  const post = directPost(h.port)
  try {
    const { code } = await h.pairing.begin(h.tls.fingerprint)
    const cfg = pairConfig()
    const ke1s = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const ke1 = await new OpaqueClient(cfg).authInit(code.slice(3))
        assert.ok(!(ke1 instanceof Error))
        return ke1.serialize()
      })
    )
    const results = await Promise.all(ke1s.map((ke1) => post('/pair/ke1', { ke1, name: 'x', kind: 'pc' })))
    assert.ok(results.filter((r) => r.status === 200).length <= 1)
    assert.ok(h.pairing.attemptCount <= 5)
  } finally {
    await h.hub.stop()
  }
})

test('pair code: expires after five minutes', async () => {
  const h = await peerHost()
  try {
    const { code } = await h.pairing.begin(h.tls.fingerprint)
    h.tick(5 * 60_000 + 1)
    const ke1 = await new OpaqueClient(pairConfig()).authInit(code.slice(3))
    assert.ok(!(ke1 instanceof Error))
    const res = await directPost(h.port)('/pair/ke1', { ke1: ke1.serialize(), name: 'x', kind: 'pc' })
    assert.equal(res.status, 410)
  } finally {
    await h.hub.stop()
  }
})

test('pair code: a different channel fingerprint fails; a changed certificate blocks the link', async () => {
  const h = await peerHost()
  try {
    const { code } = await h.pairing.begin(h.tls.fingerprint)
    const real = directPost(h.port)
    const forged: PairPost = async (path, body) => ({ ...(await real(path, body)), fingerprint: 'forged' })
    await assert.rejects(runPairClient(forged, code, 'pc', 'c'), /연결 코드가 올바르지 않습니다/)
    const link = await linked(h)
    let changes = 0
    const conn = new PeerConnection({ ...link, fingerprint: 'tampered' }, () => changes++, () => {}, h.port)
    try {
      await until(() => conn.status === 'blocked', 5000, 'blocked status')
      await assert.rejects(conn.rpc('snapshot', []), /상대 PC 인증서가 바뀌었습니다/)
      assert.ok(changes > 0)
    } finally {
      conn.close()
    }
  } finally {
    await h.hub.stop()
  }
})

test('pair code: direct pairing and peer tokens are limited to Tailscale', async () => {
  const h = await peerHost(() => false)
  try {
    await h.pairing.begin(h.tls.fingerprint)
    const res = await directPost(h.port)('/pair/ke1', { ke1: [1], name: 'x', kind: 'pc' })
    assert.equal(res.status, 403)
    assert.deepEqual(res.body, { error: 'Tailscale 또는 릴레이로만 PC 연결을 할 수 있습니다.' })
    h.grants.set('peer-token', 'peer-x')
    const conn = new PeerConnection(
      { id: 'peer-x', name: 'h', fingerprint: h.tls.fingerprint, certPem: h.tls.cert, token: 'peer-token', addresses: ['127.0.0.1'], relay: null },
      () => {},
      () => {},
      h.port
    )
    try {
      await assert.rejects(conn.rpc('snapshot', []), /Tailscale 또는 릴레이로만/)
    } finally {
      conn.close()
    }
  } finally {
    await h.hub.stop()
  }
})

test('linked PC: revoking the grant ends the event stream and the token', async () => {
  const h = await peerHost()
  try {
    const link = await linked(h)
    const conn = new PeerConnection(link, () => {}, () => {}, h.port)
    try {
      await until(() => conn.status === 'online', 5000, 'online')
      for (const [token, id] of h.grants) if (id === link.id) h.grants.delete(token)
      h.hub.disconnect(link.id)
      await until(() => conn.status === 'revoked', 5000, 'revoked')
      await assert.rejects(conn.rpc('snapshot', []), /외부 PC에서 연결이 해제되었습니다/)
      const raw = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port: h.port,
            path: '/rpc/snapshot',
            method: 'POST',
            rejectUnauthorized: false,
            headers: { Authorization: `Bearer ${link.token}` }
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          }
        )
        req.on('error', reject)
        req.end('{"args":[]}')
      })
      assert.equal(raw, 401)
    } finally {
      conn.close()
    }
  } finally {
    await h.hub.stop()
  }
})

test('peer rules: only records of the active profile; no workspace creation or deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-peer-rules-'))
  const store = new PersonalStore(dir)
  try {
    const own = (kind: string, id: string): unknown => store.record(kind, id)
    const project = store.list<Project>('project')[0]
    store.put('question', store.active, question('mine', project.id, [turn()]))
    store.put('question', 'other-profile', question('theirs', project.id, [turn()]))
    assert.throws(() => checkPeerCall(own, 'create', ['workspace', 'x']), /워크스페이스를 만들 수 없습니다/)
    assert.throws(() => checkPeerCall(own, 'remove', ['workspace', project.workspaceId]), /워크스페이스를 삭제할 수 없습니다/)
    assert.throws(() => checkPeerCall(own, 'rename', ['question', 'theirs', 'n']), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'rename', ['profile', store.active, 'n']), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'move-question', ['mine', 'elsewhere']), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'ask', [{ projectId: project.id, questionId: 'theirs' }]), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'switch-profile', ['x']), /지원하지 않는 요청입니다/)
    checkPeerCall(own, 'rename', ['question', 'mine', 'n'])
    checkPeerCall(own, 'create', ['project', 'p', project.workspaceId])
    checkPeerCall(own, 'ask', [{ projectId: project.id, questionId: 'mine' }])
    const concept = store.create('concept', '개념', project.id)
    checkPeerCall(own, 'edit-concept-info', [concept, { definition: 'd' }])
    checkPeerCall(own, 'focus-question', ['mine'])
    checkPeerCall(own, 'focus-question', [null])
    checkPeerCall(own, 'tidy-plan', [project.workspaceId])
    checkPeerCall(own, 'tidy-status', [project.workspaceId])
    checkPeerCall(own, 'tidy-start', [project.workspaceId])
    checkPeerCall(own, 'tidy-clear', [project.workspaceId, 'job'])
    checkPeerCall(own, 'tidy-manager-request', [project.workspaceId])
    checkPeerCall(own, 'tidy-apply', [project.workspaceId, 'proposal', [0], []])
    checkPeerCall(own, 'export', [project.id, { images: false }])
    assert.throws(() => checkPeerCall(own, 'set-relation', ['missing', 'remove']), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'focus-question', ['theirs']), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'tidy-start', [project.id]), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'tidy-status', [project.id]), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'tidy-clear', [project.id, 'job']), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'tidy-manager-request', [project.id]), /권한이 없는 요청입니다/)
    assert.throws(() => checkPeerCall(own, 'tidy-apply', [project.id, 'proposal', [], []]), /권한이 없는 요청입니다/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer rules: running or applying tidy needs the knowledge-manager grant', () => {
  assert.throws(() => checkPeerManager(undefined, 'tidy-start'), /지식 관리자로 승인된 PC만/)
  assert.throws(() => checkPeerManager('pending', 'tidy-apply'), /지식 관리자로 승인된 PC만/)
  checkPeerManager('granted', 'tidy-start')
  checkPeerManager(undefined, 'tidy-status')
})

test('linked PC: offline keeps the last snapshot, refuses edits, and reconnects', async () => {
  const h = await peerHost()
  try {
    const link = await linked(h)
    const conn = new PeerConnection(link, () => router.rebuild(), () => {}, h.port)
    const router = new RemoteRouter(() => [conn], () => false, () => 'local')
    try {
      await until(() => conn.status === 'online' && !!conn.snapshot, 5000, 'online')
      router.rebuild()
      await h.hub.stop()
      await until(() => conn.status === 'offline', 5000, 'offline')
      assert.equal(conn.snapshot?.workspaces[0].name, 'Host WS')
      await assert.rejects(router.route('rename', ['question', 'q1', 'x']), /외부 PC가 오프라인이라 사용할 수 없습니다/)
      await h.restart()
      await until(() => conn.status === 'online', 10_000, 'reconnect')
    } finally {
      conn.close()
    }
  } finally {
    await h.hub.stop()
  }
})

test('linked PC routing: merged snapshot marks remote workspaces; calls go to their owner only', async () => {
  const calls: unknown[][] = []
  const remote: Snapshot = {
    profiles: [],
    activeProfileId: 'host-profile',
    workspaces: [{ id: 'rw', profileId: 'host-profile', name: 'Remote' }],
    projects: [{ id: 'rp', workspaceId: 'rw', name: 'P', description: '' }],
    concepts: [],
    relations: [],
    questions: [question('rq', 'rp', [turn()])],
    settings: {} as Snapshot['settings'],
    storageBytes: 0
  }
  const peer = {
    link: { id: 'peer-a', name: 'PC A' },
    status: 'online' as PeerStatus,
    snapshot: remote,
    rpc: async (name: string, args: unknown[]) => {
      calls.push([name, ...args])
      return name === 'ask' ? { questionId: 'rq', turnId: 't1' } : null
    }
  }
  const local: unknown[][] = []
  const asked: string[][] = []
  let linkedPeers = [peer]
  const router = new RemoteRouter(
    () => linkedPeers,
    (id) => id === 'lq' || id === 'lp',
    (name, args) => local.push([name, ...args]),
    (p, q) => asked.push([p, q])
  )
  router.rebuild()
  const merged = router.merge({ ...remote, activeProfileId: 'mine', workspaces: [], projects: [], questions: [] })
  assert.deepEqual(merged.workspaces[0].remote, { peerId: 'peer-a', name: 'PC A', status: 'online' })
  assert.equal(merged.questions[0].id, 'rq')
  await router.route('rename', ['question', 'rq', 'renamed'])
  await router.route('rename', ['question', 'lq', 'local'])
  await router.route('ask', [{ requestId: 'r1', profileId: 'mine', projectId: 'rp', raw: 'q', model: 'mine-model', annotated: true }])
  await router.route('cancel', ['r1'])
  assert.deepEqual(calls[0], ['rename', 'question', 'rq', 'renamed'])
  assert.deepEqual(calls[1], ['ask', { requestId: 'r1', profileId: 'host-profile', projectId: 'rp', raw: 'q', model: '', annotated: true }])
  assert.deepEqual(calls[2], ['cancel', 'r1'])
  assert.deepEqual(local, [['rename', 'question', 'lq', 'local']])
  await assert.rejects(router.route('move-question', ['rq', 'lp']), /로컬과 외부 워크스페이스 사이/)
  await assert.rejects(router.route('export', ['rp']), /지원하지 않는 기능/)
  assert.deepEqual(asked, [['rp', 'rq']])
  // The overlay and its recent conversation live on this PC, even for linked-PC projects.
  await router.route('open-overlay', ['rp', 'rq'])
  await router.route('active-project', ['rp'])
  await router.route('clear-recent', ['rp'])
  assert.deepEqual(local.slice(1), [
    ['open-overlay', 'rp', 'rq'],
    ['active-project', 'rp'],
    ['clear-recent', 'rp']
  ])
  assert.equal(router.remoteProject('rp')?.id, 'rp')
  assert.equal(router.remoteQuestion('rq')?.projectId, 'rp')
  assert.equal(router.remoteProject('lp'), undefined)
  // An id collision with local data hides the remote workspace instead of mixing owners.
  const colliding = new RemoteRouter(() => [peer], (id) => id === 'rq', () => null)
  colliding.rebuild()
  assert.equal(colliding.merge({ ...remote, workspaces: [], projects: [], questions: [] }).workspaces.length, 0)
  assert.equal(colliding.remoteProject('rp'), undefined)
  // Unlinking a PC removes its ownership.
  linkedPeers = []
  router.rebuild()
  assert.equal(router.remoteProject('rp'), undefined)
  assert.equal(router.remoteQuestion('rq'), undefined)
})

test('linked PC: concurrent renames from two PCs converge on both', async () => {
  const h = await peerHost()
  try {
    const a = new PeerConnection(await linked(h, 'a'), () => {}, () => {}, h.port)
    const b = new PeerConnection(await linked(h, 'b'), () => {}, () => {}, h.port)
    try {
      await until(() => a.status === 'online' && b.status === 'online', 5000, 'both online')
      await Promise.all([a.rpc('rename', ['question', 'q1', 'A']), b.rpc('rename', ['question', 'q1', 'B'])])
      const title = (c: PeerConnection): string | undefined => c.snapshot?.questions[0].title
      await until(() => title(a) === h.questions.get('q1') && title(b) === h.questions.get('q1'), 5000, 'converged')
    } finally {
      a.close()
      b.close()
    }
  } finally {
    await h.hub.stop()
  }
})

test('linked PC: a change during a snapshot read is re-read, not dropped', async () => {
  const h = await peerHost()
  try {
    const conn = new PeerConnection(await linked(h), () => {}, () => {}, h.port)
    try {
      await until(() => conn.status === 'online' && !!conn.snapshot, 5000, 'online')
      const gate = Promise.withResolvers<void>()
      const reading = h.holdSnapshot(gate.promise)
      h.questions.set('q1', 'v1')
      h.hub.broadcast('changed', {})
      // The read has started and is held with v1 already built in.
      await reading
      h.questions.set('q1', 'v2')
      h.hub.broadcast('changed', {})
      // Real delay: nothing on the client signals that this `changed` crossed the event stream.
      await new Promise((r) => setTimeout(r, 100))
      void h.holdSnapshot(null)
      gate.resolve()
      await until(() => conn.snapshot?.questions[0].title === 'v2', 5000, 'latest state')
    } finally {
      conn.close()
    }
  } finally {
    await h.hub.stop()
  }
})

test('project graph: linked concepts plus ancestors, shared and fresh manual ones', () => {
  const concept = (id: string, parentId: string | null, manual = false): Snapshot['concepts'][number] => ({
    id,
    workspaceId: 'W',
    name: id,
    parentId,
    manual,
    aliases: [],
    definition: '',
    level: 'concept'
  })
  const question = (id: string, projectId: string, conceptIds: string[]): Question =>
    ({ id, projectId, conceptIds }) as Question
  const data = {
    projects: [
      { id: 'A', workspaceId: 'W', name: 'A', description: '' },
      { id: 'B', workspaceId: 'W', name: 'B', description: '' }
    ],
    concepts: [
      concept('root', null),
      concept('mid', 'root'),
      concept('leaf', 'mid'),
      concept('other', null),
      concept('both', null),
      concept('fresh', null, true)
    ],
    questions: [question('q1', 'A', ['leaf', 'both']), question('q2', 'B', ['other', 'both'])]
  } as unknown as Snapshot
  const { concepts, shared } = projectConcepts(data, 'A')
  assert.deepEqual(
    concepts.map((c) => c.id),
    ['root', 'mid', 'leaf', 'both', 'fresh']
  )
  assert.deepEqual([...shared], ['both'])
  // The question picker lists the project's concepts first, then the rest of the workspace.
  assert.deepEqual(
    linkableConcepts(data, 'A').map((c) => c.id),
    ['root', 'mid', 'leaf', 'both', 'fresh', 'other']
  )
})

test('relation highlight: the selected concept and its approved, active relations, direction-tagged', () => {
  const relation = (
    id: string,
    from: string,
    to: string,
    type: string,
    approved = true,
    invalidatedAt: number | null = null
  ) => ({ id, from, to, type, approved, invalidatedAt }) as Snapshot['relations'][number]
  const data = {
    relations: [
      relation('r1', 'a', 'b', 'uses'),
      relation('r2', 'c', 'a', 'prerequisite'),
      relation('r3', 'a', 'd', 'uses', true, 1),
      relation('r4', 'e', 'a', 'uses', false),
      relation('r5', 'b', 'c', 'uses'),
      relation('r6', 'a', 'c', 'contrast'),
      relation('r7', 'b', 'a', 'part')
    ]
  } as unknown as Snapshot
  assert.equal(relationHighlight(data, null), undefined)
  assert.deepEqual(relationHighlight(data, 'a'), {
    focus: 'c:a',
    related: {
      'c:b': [
        { label: '사용', arrow: 'in' },
        { label: '부분', arrow: 'out' }
      ],
      'c:c': [{ label: '선행', arrow: 'out' }, { label: '대조' }]
    }
  })
  assert.deepEqual(relationHighlight(data, 'z'), { focus: 'c:z', related: {} })
})

test('ego graph: prerequisites left, part/uses right, contrast/example below; edges end on borders', () => {
  const names: Record<string, string> = { b: '행렬', c: '벡터 공간', d: '고유값 분해의 아주 긴 이름을 가진 개념', e: '예시' }
  const relation = (id: string, from: string, to: string, type: string) =>
    ({ id, from, to, type }) as Snapshot['relations'][number]
  const layout = egoLayout(
    { id: 'a', name: '고유값' },
    [
      relation('r1', 'b', 'a', 'prerequisite'),
      relation('r2', 'a', 'c', 'uses'),
      relation('r3', 'a', 'c', 'part'),
      relation('r4', 'd', 'a', 'contrast'),
      relation('r5', 'e', 'a', 'example'),
      relation('r6', 'a', 'gone', 'uses')
    ],
    (id) => names[id],
    (type) => RELATION_LABELS[type]
  )
  const { center } = layout
  const node = (id: string) => layout.nodes.find((n) => n.id === id)!
  assert.equal(layout.width, 320, 'never narrower than the minimum')
  assert.deepEqual(layout.nodes.map((n) => n.id).sort(), ['b', 'c', 'd', 'e'])
  assert.ok(node('b').x < center.x && Math.abs(node('b').y - center.y) < 1, 'prerequisite on the left')
  assert.ok(node('c').x > center.x, 'uses/part on the right')
  assert.ok(node('d').y > center.y && node('e').y > center.y, 'contrast/example below')
  assert.ok(node('d').label.endsWith('…') && node('d').name === names.d, 'long names are truncated')
  const edge = (id: string) => layout.edges.find((e) => e.id === id)!
  assert.deepEqual(edge('c').chip.lines, ['부분', '사용'])
  assert.equal(edge('b').arrows.length, 1)
  assert.equal(edge('d').arrows.length, 2, 'contrast points both ways')
  // Edge ends lie on the pill borders: the stadium's distance from its centre segment equals the radius.
  const onBorder = ([x, y]: [number, number], n: typeof center): boolean => {
    const a = n.width / 2 - n.height / 2
    const px = Math.max(-a, Math.min(a, x - n.x))
    return Math.abs(Math.hypot(x - n.x - px, y - n.y) - n.height / 2) < 1e-6
  }
  for (const e of layout.edges) {
    assert.ok(onBorder(e.start, center), `${e.id} starts on the centre border`)
    assert.ok(onBorder(e.end, node(e.id)), `${e.id} ends on its node border`)
    // Every arrowhead's tip is one of the border points.
    const tips = [e.start, e.end].map(([x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`)
    for (const points of e.arrows) assert.ok(tips.includes(points.split(' ')[0]), `${e.id} arrow tip on a border`)
  }
  assert.equal(pillBorder(100, 20, 1, 0), 50)
  assert.equal(pillBorder(100, 20, 0, 1), 10)
})

test('ego graph: label chips never overlap pills or each other, at any panel width', () => {
  const names: Record<string, string> = {
    cap: 'Channel Capacity',
    ent: '엔트로피',
    mi: '상호 정보량',
    code: '채널 부호화',
    rate: '전송률',
    shan: '섀넌 한계',
    fano: '파노 부등식',
    ex: '이진 대칭 채널',
    ex2: '가우시안 채널'
  }
  const relation = (id: string, from: string, to: string, type: string) =>
    ({ id, from, to, type }) as Snapshot['relations'][number]
  const relations = [
    relation('r1', 'cap', 'a', 'prerequisite'),
    relation('r2', 'a', 'cap', 'part'),
    relation('r3', 'a', 'cap', 'uses'),
    relation('r4', 'ent', 'a', 'prerequisite'),
    relation('r5', 'mi', 'a', 'prerequisite'),
    relation('r6', 'a', 'code', 'uses'),
    relation('r7', 'a', 'rate', 'part'),
    relation('r8', 'shan', 'a', 'contrast'),
    relation('r9', 'shan', 'a', 'example'),
    relation('r10', 'fano', 'a', 'contrast'),
    relation('r11', 'ex', 'a', 'example'),
    relation('r12', 'ex2', 'a', 'example')
  ]
  type Box = { x: number; y: number; width: number; height: number }
  const overlap = (p: Box, q: Box): boolean =>
    Math.abs(p.x - q.x) < (p.width + q.width) / 2 && Math.abs(p.y - q.y) < (p.height + q.height) / 2
  for (const width of [200, 320, 380, 540, 800]) {
    const layout = egoLayout(
      { id: 'a', name: '채널 용량 정리의 달성 가능성' },
      relations,
      (id) => names[id],
      (type) => RELATION_LABELS[type],
      width
    )
    assert.equal(layout.width, Math.max(320, width))
    const pills = [layout.center, ...layout.nodes]
    const chips = layout.edges.map((e) => ({ id: e.id, ...e.chip }))
    assert.deepEqual(chips.find((c) => c.id === 'cap')?.lines, ['선행', '부분', '사용'], `${width}: stacked types`)
    for (const c of chips) {
      for (const p of pills) assert.ok(!overlap(c, p), `${width}: chip ${c.id} covers pill ${p.id}`)
      for (const d of chips) if (d !== c) assert.ok(!overlap(c, d), `${width}: chips ${c.id} and ${d.id} overlap`)
      assert.ok(c.y - c.height / 2 >= 0 && c.y + c.height / 2 <= layout.height, `${width}: chip ${c.id} inside`)
    }
    for (const p of pills) {
      for (const q of pills) if (q !== p) assert.ok(!overlap(p, q), `${width}: pills ${p.id} and ${q.id} overlap`)
      if (width >= 380) assert.ok(p.x - p.width / 2 >= 0 && p.x + p.width / 2 <= layout.width, `${width}: ${p.id} inside`)
    }
  }
})

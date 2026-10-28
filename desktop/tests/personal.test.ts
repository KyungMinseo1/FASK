import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { TLSSocket } from 'node:tls'
import { createHash } from 'node:crypto'
import { createHubCertificate, PersonalHub } from '../src/main/personal-hub'
import { DatabaseSync } from 'node:sqlite'
import { PersonalStore } from '../src/main/personal-store'
import { normalizeEndpoint, localModels, streamChat } from '../src/main/local-api'
import type { Project, Question, Turn, TurnState } from '../src/preload/personal'
import { validateBackup } from '../src/main/personal-backup'
import { readAttachment } from '../src/renderer/src/personal/attachments'
import {
  applyDelta,
  cleanTitle,
  mergeLive,
  normalizeLegacyQuestion,
  reconcileTurnState
} from '../src/shared/questions'

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
    assert.equal(store.snapshot().concepts.length, 0)
    assert.equal(store.db.prepare('SELECT id FROM runs WHERE id=?').get('run'), undefined)
    assert.ok(store.image(image), 'other profile still references shared image')
    store.remove('workspace', project.workspaceId)
    assert.equal(store.snapshot().workspaces.length, 0)
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
    const otherConcept = store.create('concept', '다른 개념', other)
    assert.throws(() => store.updateQuestion(q.id, { conceptIds: [otherConcept] }), /프로젝트/)
    const child = store.create('concept', '창 입력', project.id)
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
test('endpoint normalization rejects remote hosts and avoids duplicate v1 paths', () => {
  assert.equal(
    normalizeEndpoint('http://localhost:8317/v1/v1/chat/completions/'),
    'http://localhost:8317/v1'
  )
  assert.equal(normalizeEndpoint('http://[::1]:8317'), 'http://[::1]:8317/v1')
  assert.throws(() => normalizeEndpoint('https://example.com/v1'), /로컬/)
  assert.throws(() => normalizeEndpoint('http://key@localhost:8317'), /경로/)
})
test('backup validation rejects cyclic concepts and cross-project references before restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-backup-')),
    store = new PersonalStore(dir)
  try {
    const project = store.list<Project>('project')[0]
    const a = store.create('concept', '부모', project.id),
      b = store.create('concept', '자식', project.id)
    const backup = { version: 2, snapshot: store.snapshot(), images: {} }
    assert.equal(validateBackup(backup).version, 2)
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
    assert.equal(backup.version, 2)
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
    async (name, args) => ({ name, args }),
    new Set(['snapshot']),
    '1.1.0'
  )
  const results = await hub.start(['127.0.0.1'], 0, 'tok', tls)
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
    const elsewhere = new PersonalHub(async () => null, new Set(), '1.1.0')
    const missing = await elsewhere.start(['203.0.113.7'], 0, 'tok', tls)
    assert.match(missing[0].error, /현재 네트워크에 없는 주소입니다/)
    assert.equal(elsewhere.running, false)
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

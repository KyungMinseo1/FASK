import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PersonalStore } from '../src/main/personal-store'
import { normalizeEndpoint, localModels, streamChat } from '../src/main/local-api'
import type { Project, Question } from '../src/preload/personal'
import { validateBackup } from '../src/main/personal-backup'
import { readAttachment } from '../src/renderer/src/personal/attachments'

test('records survive restart; profile and project scope prevent cross-links', () => {
  const path = mkdtempSync(join(tmpdir(), 'fask-store-'))
  let store = new PersonalStore(path)
  try {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    store.rename('project', project.id, '이름 바꾼 프로젝트')
    store.rename('workspace', project.workspaceId, '이름 바꾼 워크스페이스')
    const concept = store.create('concept', '투명 창', project.id)
    const q: Question = {
      id: 'question-1',
      projectId: project.id,
      conversationId: 'conversation',
      raw: '질문',
      refined: '',
      sent: '질문',
      answer: '부분 답변',
      createdAt: new Date().toISOString(),
      model: 'fake',
      actualModel: '',
      status: 'running',
      complexity: 'simple',
      routingReason: 'test',
      conceptIds: [concept],
      suggestions: [],
      memo: '',
      important: false,
      attachment: null,
      error: ''
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
    assert.equal(store.snapshot().questions[0].status, 'failed')
    assert.equal(store.snapshot().questions[0].answer, '부분 답변')
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
test('deduplicated attachment is retained while another question refers to it', () => {
  const path = mkdtempSync(join(tmpdir(), 'fask-images-')),
    store = new PersonalStore(path)
  try {
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const id = store.saveImage(image)
    assert.equal(store.saveImage(image), id)
    for (const qid of ['one', 'two'])
      store.put('question', store.active, { id: qid, attachment: id } as Question)
    store.removeAttachment('one')
    assert.equal(store.image(id), image)
    store.removeAttachment('two')
    assert.equal(store.image(id), null)
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
    const backup = { version: 1, snapshot: store.snapshot(), images: {} }
    assert.equal(validateBackup(backup).version, 1)
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

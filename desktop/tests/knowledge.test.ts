import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { crc32, inflateRawSync } from 'node:zlib'
import { PersonalStore } from '../src/main/personal-store'
import { KnowledgeExtractor, skippedSubjects, type Chat } from '../src/main/knowledge-extract'
import { buildExport, zip } from '../src/main/knowledge-export'
import { EXPORT_DEFAULTS, exportOptions } from '../src/shared/export'
import { PARENT_LEVEL } from '../src/main/personal-backup'
import type { Concept, Project, Question, Relation, TidyChange, TidyResult, Turn, Workspace } from '../src/preload/personal'

/** Every parent sits exactly one level above its child; topics have no parent. */
function assertHierarchy(concepts: Concept[]): void {
  const byId = new Map(concepts.map((c) => [c.id, c]))
  for (const c of concepts)
    if (c.parentId) assert.equal(byId.get(c.parentId)?.level, PARENT_LEVEL[c.level], `${c.name} under ${c.parentId}`)
}

/** Previews a tidy and applies every proposed change. */
async function tidyAll(extractor: KnowledgeExtractor, profile: string, ws: string): Promise<TidyResult> {
  const proposal = await extractor.tidyPreview(profile, ws)
  return extractor.tidyApply(profile, ws, proposal.id, proposal.changes.map((_, i) => i), [])
}

function kTurn(id: string, raw: string, answer: string, status: Turn['status'] = 'completed'): Turn {
  return {
    id,
    createdAt: new Date().toISOString(),
    raw,
    refined: '',
    sent: raw,
    answer,
    model: '',
    actualModel: '',
    status,
    complexity: 'simple',
    routingReason: '',
    attachment: null,
    documents: [],
    error: '',
    revision: 0
  }
}

function setup(): { dir: string; store: PersonalStore; project: Project; put: (id: string, turns: Turn[]) => Question } {
  const dir = mkdtempSync(join(tmpdir(), 'fask-kg-'))
  const store = new PersonalStore(dir)
  store.saveSettings({ ...store.settings(), organize: true, extractDelaySec: 0, model: 'm' })
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

/** Reads a ZIP with its central directory, checking every CRC. */
function unzip(data: Buffer): Map<string, Buffer> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'end of central directory')
  const count = data.readUInt16LE(end + 10)
  let p = data.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(p), 0x02014b50)
    const method = data.readUInt16LE(p + 10),
      crc = data.readUInt32LE(p + 16),
      size = data.readUInt32LE(p + 20),
      nameLength = data.readUInt16LE(p + 28),
      offset = data.readUInt32LE(p + 42)
    const name = data.subarray(p + 46, p + 46 + nameLength).toString('utf8')
    assert.equal(data.readUInt32LE(offset), 0x04034b50)
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28)
    const body = data.subarray(start, start + size)
    const content = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    assert.equal(crc32(content), crc, `crc of ${name}`)
    files.set(name, content)
    p += 46 + nameLength + data.readUInt16LE(p + 30) + data.readUInt16LE(p + 32)
  }
  return files
}

test('extraction: a turn completed during a running extraction is extracted by a follow-up run', async () => {
  const { dir, store, put } = setup()
  try {
    put('q1', [kTurn('t0', '고유값이 뭐야?', LONG)])
    const inputs: string[] = []
    // Holds the first model call open until a follow-up turn has been added.
    const gate = Promise.withResolvers<void>()
    const chat: Chat = async (_profile, _model, _instruction, input) => {
      inputs.push(input)
      const first = inputs.length === 1
      if (first) await gate.promise
      return JSON.stringify({
        concepts: first
          ? [
              { name: '고유값', aliases: ['eigenvalue'], definition: '배율', level: 'concept', role: 'focus', parent: '선형대수', turns: [0], confidence: 0.9 },
              { name: '스펙트럼 정리', level: 'concept', role: 'focus', parent: null, turns: [0], confidence: 0.4 }
            ]
          : [{ name: '고유벡터', level: 'concept', role: 'focus', parent: '선형대수', turns: [1], confidence: 0.8 }],
        relations: first
          ? []
          : [{ from: '고유벡터', to: '고유값', type: 'uses', evidence: '방향이 바뀌지 않는  벡터의 배율이다.', confidence: 0.5 }]
      })
    }
    const extractor = new KnowledgeExtractor(store, chat, () => {})
    const running = extractor.run(store.active, 'q1')
    assert.equal(inputs.length, 1, 'the first run is waiting on the model')
    // A follow-up turn finishes while the first extraction waits on the model.
    const q = store.record<Question>('question', 'q1')
    store.put('question', store.active, { ...q, turns: [...q.turns, kTurn('t1', '고유벡터는?', LONG)] })
    void extractor.run(store.active, 'q1')
    gate.resolve()
    await running
    await extractor.idle()
    assert.equal(inputs.length, 2)
    assert.deepEqual(
      (JSON.parse(inputs[1]).turns as { index: number }[]).map((t) => t.index),
      [1],
      'the follow-up run sends only the new turn'
    )
    const done = store.record<Question>('question', 'q1')
    assert.equal(done.extractedTurns, 2)
    const concepts = store.list<Concept>('concept')
    const eigenvalue = concepts.find((c) => c.name === '고유값')
    const vector = concepts.find((c) => c.name === '고유벡터')
    const parent = concepts.find((c) => c.name === '선형대수')
    assert.ok(eigenvalue && vector && parent)
    assert.equal(eigenvalue.parentId, parent.id)
    assert.equal(vector.parentId, parent.id, 'an existing parent name is reused, not duplicated')
    assert.equal(concepts.filter((c) => c.name === '선형대수').length, 1)
    assert.ok(!concepts.some((c) => c.name === '스펙트럼 정리'), 'low confidence is not created')
    assert.ok(done.suggestions.includes('스펙트럼 정리'))
    assert.deepEqual(done.conceptTurns[eigenvalue.id], ['t0'])
    assert.deepEqual(done.conceptTurns[vector.id], ['t1'])
    assert.ok(done.conceptIds.includes(eigenvalue.id) && done.conceptIds.includes(vector.id))
    assert.deepEqual(done.conceptRoles, { [eigenvalue.id]: 'focus', [vector.id]: 'focus' })
    assert.deepEqual(done.conceptSources, { [eigenvalue.id]: 'model', [vector.id]: 'model' })
    const relations = store.list<Relation>('relation')
    assert.equal(relations.length, 1)
    assert.equal(relations[0].approved, false, 'low-confidence relation waits for approval')
    assert.equal(relations[0].evidence, '방향이 바뀌지 않는  벡터의 배율이다.', 'found despite the doubled space')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: short text only advances the watermark; a running turn stops the range', async () => {
  const { dir, store, put } = setup()
  try {
    put('short', [kTurn('a', '이거 뭐야?', '그림입니다.')])
    put('busy', [kTurn('b0', '짧은 질문', '짧음'), kTurn('b1', '진행 중', '', 'running')])
    let calls = 0
    const extractor = new KnowledgeExtractor(store, async () => {
      calls++
      return '{}'
    }, () => {})
    await extractor.run(store.active, 'short')
    await extractor.run(store.active, 'busy')
    assert.equal(calls, 0)
    assert.equal(store.record<Question>('question', 'short').extractedTurns, 1)
    assert.equal(store.record<Question>('question', 'busy').extractedTurns, 1, 'stops before the running turn')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: completed turns debounce into one run; organize off does nothing', async () => {
  const { dir, store, put } = setup()
  try {
    put('q', [kTurn('t', '고유값', LONG)])
    let calls = 0
    const extractor = new KnowledgeExtractor(store, async () => {
      calls++
      return '{"concepts":[],"relations":[]}'
    }, () => {})
    store.saveSettings({ ...store.settings(), organize: false })
    extractor.completed(store.active, 'q')
    assert.equal(calls, 0)
    store.saveSettings({ ...store.settings(), organize: true })
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      extractor.completed(store.active, 'q')
      extractor.completed(store.active, 'q')
      mock.timers.tick(0)
    } finally {
      mock.timers.reset()
    }
    await extractor.idle()
    assert.equal(calls, 1)
    assert.equal(store.record<Question>('question', 'q').extractedTurns, 1)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: leaving a question runs only that client’s question, not one still open elsewhere', async () => {
  const { dir, store, put } = setup()
  store.saveSettings({ ...store.settings(), extractDelaySec: 120 })
  try {
    put('a', [kTurn('ta', '고유값', LONG)])
    put('b', [kTurn('tb', '고유벡터', LONG)])
    const ran: string[] = []
    const extractor = new KnowledgeExtractor(store, async (_p, _m, _i, input) => {
      ran.push(JSON.parse(input).turns[0].question)
      return '{"concepts":[],"relations":[]}'
    }, () => {})
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      extractor.focus('window:1', 'a')
      extractor.focus('peer:pc2:', 'a')
      extractor.focus('mobile', 'b')
      extractor.completed(store.active, 'a')
      extractor.completed(store.active, 'b')
      extractor.focus('window:1', null)
      await extractor.idle()
      assert.deepEqual(ran, [], 'A is still open on the linked PC')
      extractor.focus('peer:pc2:', null)
      await extractor.idle()
      assert.deepEqual(ran, ['고유값'], "leaving A runs A only; the phone's B keeps its debounce")
    } finally {
      mock.timers.reset()
      extractor.close()
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: parents are exactly one level up; a wrong-level parent leaves the concept parentless', async () => {
  const { dir, store, put } = setup()
  try {
    put('q', [kTurn('t0', '정규분포 표준화는?', LONG)])
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          concepts: [
            { name: '표준화', level: 'detail', role: 'focus', parent: '정규분포', grandparent: '확률', turns: [0], confidence: 0.9 },
            { name: 'z-점수', level: 'detail', role: 'focus', parent: '확률', turns: [0], confidence: 0.9 },
            { name: '확률론', level: 'topic', role: 'focus', parent: '수학', turns: [0], confidence: 0.9 }
          ]
        }),
      () => {}
    )
    await extractor.run(store.active, 'q')
    const concepts = store.list<Concept>('concept')
    assertHierarchy(concepts)
    const byName = (name: string): Concept | undefined => concepts.find((c) => c.name === name)
    const normal = byName('정규분포'),
      topic = byName('확률')
    assert.ok(normal && topic)
    assert.deepEqual([normal.level, topic.level], ['concept', 'topic'])
    assert.equal(byName('표준화')?.parentId, normal.id)
    assert.equal(normal.parentId, topic.id, 'the new intermediate concept goes under the named topic')
    assert.equal(byName('z-점수')?.parentId, null, 'a detail is never put directly under a topic')
    assert.equal(byName('확률론')?.parentId, null)
    assert.ok(!byName('수학'), 'a topic takes no parent, so none is created')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: invalid items are dropped; a null parent is an accepted abstention', async () => {
  const { dir, store, put } = setup()
  try {
    put('q', [kTurn('t0', '고유값이 뭐야?', LONG)])
    const concept = (name: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      name,
      existingId: null,
      aliases: [],
      definition: '',
      level: 'concept',
      role: 'focus',
      parent: null,
      grandparent: null,
      turns: [0],
      confidence: 0.9,
      ...extra
    })
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          concepts: [
            concept('고유값', { aliases: ['eigenvalue', '고유값은 어떻게 구해?'] }),
            concept('유령 개념', { existingId: randomUUID() }), // an id that was never sent
            concept('특성방정식', { level: 'chapter' }),
            concept('고유값은 어떻게 구해?'),
            concept('행렬 풀이 3번?'),
            concept('123.'),
            concept('가'.repeat(61)),
            concept('벡터', { confidence: 1.5 }),
            concept('배율', { parent: randomUUID() }),
            concept('행렬', { role: 'main' }),
            concept('선형 변환', { role: undefined })
          ],
          relations: [
            { from: '고유값', to: randomUUID(), type: 'uses', evidence: LONG, confidence: 0.9 },
            { from: '고유값', to: '고유값', type: 'causes', evidence: LONG, confidence: 0.9 },
            { from: '고유값', to: '배율', type: 'uses', confidence: 0.9 }
          ]
        }),
      () => {}
    )
    await extractor.run(store.active, 'q')
    const concepts = store.list<Concept>('concept')
    assert.deepEqual(concepts.map((c) => c.name), ['고유값'])
    assert.deepEqual(concepts[0].aliases, ['eigenvalue'], 'a question-like alias is dropped')
    assert.equal(concepts[0].parentId, null)
    assert.deepEqual(store.record<Question>('question', 'q').conceptIds, [concepts[0].id])
    assert.equal(store.list<Relation>('relation').length, 0)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: unparseable output is an empty result; a failed call keeps the watermark', async () => {
  const { dir, store, put } = setup()
  try {
    put('bad', [kTurn('t0', '고유값이 뭐야?', LONG)])
    put('down', [kTurn('t1', '고유벡터는?', LONG)])
    const extractor = new KnowledgeExtractor(
      store,
      async (_p, _m, _i, input) => {
        if (JSON.parse(input).turns[0].question === '고유값이 뭐야?') return 'not json {'
        throw new Error('proxy down')
      },
      () => {}
    )
    await extractor.run(store.active, 'bad')
    await extractor.run(store.active, 'down')
    assert.equal(store.record<Question>('question', 'bad').extractedTurns, 1)
    assert.equal(store.record<Question>('question', 'down').extractedTurns, 0)
    assert.equal(store.list<Concept>('concept').length, 0)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: a relation needs a focus end and an answer sentence as evidence; a related pair gets no second one', async () => {
  const { dir, store, put } = setup()
  try {
    put('q', [kTurn('t0', '고유값이 뭐야?', LONG)])
    const concept = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      name,
      level: 'concept',
      role: 'focus',
      parent: null,
      turns: [0],
      confidence: 0.9,
      ...extra
    })
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          concepts: [
            concept('고유값'),
            concept('특성방정식'),
            { ...concept('고유값의 배율'), level: 'detail', parent: '고유값' }
          ],
          relations: [
            { from: '고유값', to: '특성방정식', type: 'uses', evidence: '특성방정식으로 구한다.', confidence: 0.9 },
            // The pair is already related above: no second relation of another type or direction.
            { from: '특성방정식', to: '고유값', type: 'prerequisite', evidence: '특성방정식으로 구한다.', confidence: 0.9 },
            // Its own parent: the hierarchy already says it.
            { from: '고유값의 배율', to: '고유값', type: 'part', evidence: '벡터의 배율이다.', confidence: 0.9 },
            // Not a sentence of the answer.
            { from: '특성방정식', to: '고유값의 배율', type: 'uses', evidence: '특성방정식은 배율을 쓴다.', confidence: 0.9 }
          ]
        }),
      () => {}
    )
    await extractor.run(store.active, 'q')
    const id = (name: string): string | undefined => store.list<Concept>('concept').find((c) => c.name === name)?.id
    const relations = store.list<Relation>('relation')
    assert.equal(relations.length, 1)
    assert.deepEqual(
      [relations[0].from, relations[0].to, relations[0].approved, relations[0].evidence, relations[0].turnIds],
      [id('고유값'), id('특성방정식'), true, '특성방정식으로 구한다.', ['t0']]
    )
    assert.equal(store.list<Concept>('concept').find((c) => c.name === '고유값의 배율')?.parentId, id('고유값'))
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: a support concept without a node is a candidate until another question has it', async () => {
  const { dir, store, put } = setup()
  try {
    put('a', [kTurn('ta', '고유값이 뭐야?', LONG)])
    put('b', [kTurn('tb', '대각화는 어떻게 해?', `${LONG} 대각화도 특성방정식을 쓴다.`)])
    const extractor = new KnowledgeExtractor(
      store,
      async (_p, _m, _i, input) => {
        const first = JSON.parse(input).turns[0].question === '고유값이 뭐야?'
        return JSON.stringify({
          concepts: [
            { name: first ? '고유값' : '대각화', level: 'concept', role: 'focus', parent: '선형대수', turns: [0], confidence: 0.9 },
            { name: '특성방정식', aliases: ['characteristic equation'], definition: '고유값을 구하는 식', level: 'concept', role: 'support', parent: '선형대수', turns: [0], confidence: 0.9 }
          ],
          relations: [
            { from: first ? '고유값' : '대각화', to: '특성방정식', type: 'uses', evidence: '특성방정식으로 구한다.', confidence: 0.9 }
          ]
        })
      },
      () => {}
    )
    await extractor.run(store.active, 'a')
    const named = (name: string): Concept | undefined => store.list<Concept>('concept').find((c) => c.name === name)
    assert.ok(!named('특성방정식'), 'a support concept without a node is not created')
    const a = store.record<Question>('question', 'a')
    assert.deepEqual(a.suggestions, ['특성방정식'])
    assert.equal(a.conceptIds.length, 1)
    assert.equal(store.list<Relation>('relation').length, 0, 'a candidate has no relations')

    await extractor.run(store.active, 'b')
    const equation = named('특성방정식')
    assert.ok(equation, 'the candidate recurring in another question becomes a node')
    assert.equal(equation.parentId, named('선형대수')?.id, 'it joins the existing parent')
    const b = store.record<Question>('question', 'b')
    assert.equal(b.conceptRoles?.[equation.id], 'support')
    assert.equal(b.conceptSources?.[equation.id], 'model')
    const promoted = store.record<Question>('question', 'a')
    assert.ok(promoted.conceptIds.includes(equation.id), 'the earlier question links it too')
    assert.deepEqual([promoted.conceptRoles?.[equation.id], promoted.conceptSources?.[equation.id]], ['support', 'model'])
    assert.deepEqual(promoted.suggestions, [])
    assert.equal(promoted.conceptTurns[equation.id], undefined)
    assert.equal(store.list<Relation>('relation').length, 1, 'focus–support relation from the answer')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extraction: a linked model focus returned as support becomes support; a user link stays focus', async () => {
  const { dir, store, project, put } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const eigen = store.createConcept(profile, ws, { name: '고유값', level: 'concept' })
    const matrix = store.createConcept(profile, ws, { name: '행렬', level: 'concept' })
    const vector = store.createConcept(profile, ws, { name: '벡터', level: 'concept' })
    const q = put('q', [kTurn('t0', '고유값이 뭐야?', LONG), kTurn('t1', '대각화는?', `${LONG} 대각화는 고유값 분해다.`)])
    store.put('question', profile, {
      ...q,
      conceptIds: [eigen, matrix, vector],
      conceptRoles: { [eigen]: 'focus', [matrix]: 'focus' },
      conceptSources: { [eigen]: 'model', [matrix]: 'user' },
      extractedTurns: 1
    })
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          concepts: [
            { name: '고유값', existingId: eigen, level: 'concept', role: 'support', parent: null, turns: [1], confidence: 0.9 },
            { name: '행렬', existingId: matrix, level: 'concept', role: 'support', parent: null, turns: [1], confidence: 0.9 },
            { name: '벡터', existingId: vector, level: 'concept', role: 'support', parent: null, turns: [1], confidence: 0.9 },
            { name: '대각화', level: 'concept', role: 'focus', parent: null, turns: [1], confidence: 0.9 }
          ]
        }),
      () => {}
    )
    await extractor.run(profile, 'q')
    const done = store.record<Question>('question', 'q')
    const diagonal = store.findConceptByName(profile, ws, '대각화')?.id
    assert.ok(diagonal)
    assert.deepEqual(done.conceptRoles, {
      [eigen]: 'support',
      [matrix]: 'focus',
      [vector]: 'support',
      [diagonal]: 'focus'
    })
    assert.deepEqual(done.conceptSources, { [eigen]: 'model', [matrix]: 'user', [diagonal]: 'model' })
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: unknown ids, invalid enums and question-like names are dropped; a null parent is accepted', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const c1 = store.createConcept(profile, ws, { name: '중심극한정리', level: 'concept', parentId: null })
    const d1 = store.createConcept(profile, ws, { name: '표준화', level: 'detail', parentId: null })
    const ghost = randomUUID()
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          merges: [{ source: c1, target: ghost }],
          levels: [{ id: d1, level: 'subtopic' }],
          parents: [
            { name: '이건 어떻게 풀어?', level: 'topic', parent: null, children: [c1] },
            { name: '통계학', level: 'topic', parent: null, children: [c1, ghost] }
          ],
          assign: [{ id: d1, parentId: ghost }],
          folds: [{ source: d1, target: ghost }],
          demotes: [ghost],
          renames: [{ id: c1, name: '이건 어떻게 풀어?' }],
          promotes: [{ name: '표본', level: 'chapter', parent: null }],
          unrelate: [randomUUID()],
          // Tidy no longer creates relations; the key is ignored.
          relations: [{ from: c1, to: d1, type: 'uses', confidence: 0.9 }]
        }),
      () => {}
    )
    const proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(proposal.changes, [
      {
        kind: 'newParent',
        name: '통계학',
        level: 'topic',
        parent: null,
        children: [{ concept: { id: c1, name: '중심극한정리' }, from: null, levelFrom: 'concept', levelTo: 'concept' }]
      }
    ])
    const broken = new KnowledgeExtractor(store, async () => 'no json here', () => {})
    // An empty proposal would record every candidate as reviewed, so unreadable output stays an error.
    await assert.rejects(broken.tidyPreview(profile, ws), /JSON/)
    broken.close()
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: a conflicting relation pair is offered; unrelate removes one, a kept pair waits for a new relation', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const make = (name: string): string => store.createConcept(profile, ws, { name, level: 'topic', manual: true })
    const signal = make('신호처리'),
      stats = make('통계학')
    const base = { questionId: null, turnIds: [], confidence: 0.9, approved: true }
    const uses = store.addRelation(profile, { ...base, from: signal, to: stats, type: 'uses' })
    const prerequisite = store.addRelation(profile, { ...base, from: stats, to: signal, type: 'prerequisite' })
    let unrelate = [prerequisite]
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          unrelate,
          relations: [{ from: signal, to: stats, type: 'contrast', confidence: 0.9 }]
        }),
      () => {}
    )
    const plan = extractor.plan(profile, ws)
    assert.equal(plan.candidates, 1)
    assert.deepEqual(JSON.parse(plan.input).conflicts.map((r: { id: string }) => r.id).sort(), [uses, prerequisite].sort())
    let proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(proposal.changes, [
      {
        kind: 'unrelate',
        relation: prerequisite,
        from: { id: stats, name: '통계학' },
        to: { id: signal, name: '신호처리' },
        type: 'prerequisite'
      }
    ])
    // Dismissed: both are kept and not offered again.
    extractor.tidyApply(profile, ws, proposal.id, [], [0])
    assert.equal(extractor.plan(profile, ws).candidates, 0)
    assert.equal(store.list<Relation>('relation').length, 2, 'tidy creates no relation')

    const contrast = store.addRelation(profile, { ...base, from: signal, to: stats, type: 'contrast' })
    assert.equal(extractor.plan(profile, ws).candidates, 1, 'a new relation reopens the pair')
    unrelate = [contrast]
    proposal = await extractor.tidyPreview(profile, ws)
    const result = extractor.tidyApply(profile, ws, proposal.id, [0], [])
    assert.deepEqual([result.unrelated, result.skipped], [1, []])
    assert.ok(store.record<Relation>('relation', contrast).invalidatedAt)
    assert.equal(store.record<Relation>('relation', uses).invalidatedAt, null)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: a weak concept folds into its question’s focus concept; one left alone is not offered again', async () => {
  const { dir, store, project, put } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const topic = store.createConcept(profile, ws, { name: '정보이론', level: 'topic', manual: true })
    const coding = store.createConcept(profile, ws, { name: '채널 부호화', level: 'concept', parentId: topic, definition: '잡음에 강하게 부호를 고르는 방법' })
    const size = store.createConcept(profile, ws, { name: '코드북 크기', level: 'detail', parentId: coding, definition: '코드워드의 개수.' })
    const euler = store.createConcept(profile, ws, { name: '오일러 공식', level: 'detail', parentId: coding })
    const q = put('q', [kTurn('t0', '채널 부호화가 뭐야?', `${LONG} 코드북 크기와 오일러 공식도 나온다.`)])
    store.put('question', profile, {
      ...q,
      conceptIds: [coding, size, euler],
      conceptRoles: { [coding]: 'focus', [size]: 'support', [euler]: 'support' },
      conceptSources: { [coding]: 'model', [size]: 'model', [euler]: 'model' },
      extractedTurns: 1
    })
    let calls = 0
    const extractor = new KnowledgeExtractor(
      store,
      async () => {
        calls++
        return JSON.stringify({
          folds: [
            { source: size, target: coding },
            { source: euler, target: topic } // neither its parent, a sibling nor its question's focus
          ],
          demotes: [coding] // not weak
        })
      },
      () => {}
    )
    const plan = extractor.plan(profile, ws)
    const input = JSON.parse(plan.input)
    assert.deepEqual(input.weak.map((w: { id: string }) => w.id).sort(), [size, euler].sort())
    const weakSize = input.weak.find((w: { id: string }) => w.id === size)
    assert.deepEqual(weakSize.parent, { id: coding, name: '채널 부호화' })
    assert.deepEqual(weakSize.siblings, [{ id: euler, name: '오일러 공식' }])
    assert.deepEqual(weakSize.focus, [{ id: coding, name: '채널 부호화' }])
    const proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(proposal.changes, [
      { kind: 'fold', source: { id: size, name: '코드북 크기' }, target: { id: coding, name: '채널 부호화' } }
    ])
    const result = extractor.tidyApply(profile, ws, proposal.id, [0], [])
    assert.deepEqual([result.folded, result.skipped], [1, []])
    const folded = store.record<Concept>('concept', coding)
    assert.deepEqual(folded.aliases, ['코드북 크기'])
    assert.equal(folded.definition, '잡음에 강하게 부호를 고르는 방법. 코드워드의 개수.')
    assert.equal(folded.manual, false)
    const done = store.record<Question>('question', 'q')
    assert.deepEqual(done.conceptIds, [coding, euler])
    assert.deepEqual(done.conceptRoles, { [coding]: 'focus', [euler]: 'support' }, 'the focus keeps its role')
    // Left alone: recorded with its usage and not offered again until that changes.
    assert.ok(store.record<Concept>('concept', euler).tidyKept)
    assert.equal(extractor.plan(profile, ws).candidates, 0)
    // Its usage changes (the link's source is no longer recorded): offered again.
    store.put('question', profile, { ...done, conceptSources: { [coding]: 'model' } })
    assert.equal(extractor.plan(profile, ws).candidates, 1)
    assert.equal(calls, 1)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: re-judged tags set roles, replace with a candidate name and ask to confirm unknown-source removals', async () => {
  const { dir, store, project, put } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const topic = store.createConcept(profile, ws, { name: '정보이론', level: 'topic', manual: true })
    const capacity = store.createConcept(profile, ws, { name: '채널 용량', level: 'concept', parentId: topic })
    const info = store.createConcept(profile, ws, { name: '상호정보량', level: 'concept', parentId: topic })
    const converse = store.createConcept(profile, ws, { name: '상한 증명', level: 'detail', parentId: capacity, manual: true })
    const mine = store.createConcept(profile, ws, { name: '엔트로피', level: 'concept', parentId: topic, manual: true })
    const answer = '채널 용량은 상호정보량의 최댓값이다. 엔트로피와 함께 정의된다. 전송률이 그보다 작으면 오류 없이 보낼 수 있다.'
    const q = put('q', [kTurn('t0', '채널 용량이 뭐야?', answer)])
    store.put('question', profile, {
      ...q,
      conceptIds: [capacity, info, converse, mine],
      conceptSources: { [info]: 'model', [mine]: 'user' },
      conceptRoles: { [mine]: 'focus' },
      extractedTurns: 1
    })
    // One unjudged link the conversation names: judged locally as focus.
    const one = put('one', [kTurn('o0', '상호정보량은?', answer)])
    store.put('question', profile, { ...one, conceptIds: [info], extractedTurns: 1 })
    const inputs: Record<string, unknown>[] = []
    const extractor = new KnowledgeExtractor(
      store,
      async (_p, _m, _i, input) => {
        const parsed = JSON.parse(input)
        inputs.push(parsed)
        return JSON.stringify({
          items: parsed.judge
            ? [{ id: capacity, verdict: 'focus' }]
            : [
                { id: capacity, verdict: 'unsure' },
                { id: info, verdict: 'replace', target: '전송률' },
                { id: converse, verdict: 'remove' },
                { id: mine, verdict: 'remove' } // a user link: never judged
              ]
        })
      },
      () => {}
    )
    const plan = extractor.plan(profile, ws)
    assert.deepEqual([plan.candidates, plan.retag], [1, 1])
    const proposal = await extractor.tidyPreview(profile, ws)
    assert.equal(inputs.length, 0, 'no structural candidates: no tidy call')
    assert.equal(proposal.retag, 1)
    assert.deepEqual(proposal.changes, [
      {
        kind: 'retag',
        question: { id: 'one', title: '상호정보량은?' },
        items: [{ concept: { id: info, name: '상호정보량' }, from: null, verdict: 'focus', target: null, suspect: false }],
        confirm: false
      }
    ])
    const retag = await extractor.tidyRetag(profile, ws, proposal.id)
    assert.equal(inputs.length, 2, 'the unsure link gets one more call with the full turns')
    assert.deepEqual(inputs[1].judge, [capacity])
    const linked = (inputs[0].linked as { id: string; user: boolean; suspect: boolean }[]).map((l) => [l.id, l.user, l.suspect])
    assert.deepEqual(linked, [
      [capacity, false, false],
      [info, false, false],
      [converse, false, true],
      [mine, true, false]
    ])
    assert.equal(retag.remaining, 0)
    assert.deepEqual(retag.changes, [
      {
        kind: 'retag',
        question: { id: 'q', title: '채널 용량이 뭐야?' },
        items: [
          { concept: { id: info, name: '상호정보량' }, from: null, verdict: 'replace', target: { id: null, name: '전송률' }, suspect: false },
          { concept: { id: converse, name: '상한 증명' }, from: null, verdict: 'remove', target: null, suspect: true },
          { concept: { id: capacity, name: '채널 용량' }, from: null, verdict: 'focus', target: null, suspect: false }
        ],
        confirm: true
      }
    ])
    const result = extractor.tidyApply(profile, ws, proposal.id, [0, 1], [])
    assert.deepEqual([result.retagged, result.skipped], [2, []])
    const done = store.record<Question>('question', 'q')
    assert.deepEqual(done.conceptIds, [capacity, mine])
    assert.deepEqual(done.conceptRoles, { [mine]: 'focus', [capacity]: 'focus' })
    assert.deepEqual(done.suggestions, ['전송률'])
    assert.equal(store.record<Question>('question', 'one').conceptRoles?.[info], 'focus')
    assert.equal(extractor.plan(profile, ws).retag, 0)
    await assert.rejects(extractor.tidyRetag(profile, ws, proposal.id), /만료/)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: orphans and misplaced concepts are candidates; applying never breaks the 3-level tree', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    // Manual: placement tests, not usage (weak concepts, thin topics).
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId, manual: true })
    const topic = make('확률', 'topic')
    const kept = make('이항분포', 'concept', topic)
    const keptDetail = make('베르누이 시행', 'detail', kept)
    const d1 = make('표준화', 'detail')
    const d2 = make('시행 횟수', 'detail')
    const c1 = make('중심극한정리', 'concept')
    // A detail directly under a topic, as data from before the rule had; written past the store check.
    const misplaced = make('정규화 상수', 'detail')
    store.put('concept', profile, { ...store.record<Concept>('concept', misplaced), parentId: topic })
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          merges: [],
          levels: [
            { id: topic, level: 'detail' }, // has children: rejected
            { id: keptDetail, level: 'topic' } // has a parent: rejected
          ],
          parents: [
            { name: '정규분포', level: 'concept', parent: topic, children: [d1, misplaced, keptDetail] },
            { name: '엉뚱한 주제', level: 'topic', children: [d2] }, // a detail cannot sit under a topic
            { name: '통계학', level: 'topic', children: [c1] }
          ],
          assign: [
            { id: d2, parentId: topic }, // wrong level: skipped
            { id: d2, parentId: kept }, // `kept` was not sent: an unknown id, dropped
            { id: d2, parentId: c1 },
            { id: keptDetail, parentId: kept } // not sent either: untouched
          ]
        }),
      () => {}
    )
    const plan = JSON.parse(extractor.plan(profile, ws).input)
    assert.deepEqual([...plan.orphans].sort(), [d1, d2, c1].sort())
    assert.deepEqual(plan.misplaced, [misplaced])
    const result = await tidyAll(extractor, profile, ws)
    const concepts = store.list<Concept>('concept')
    assertHierarchy(concepts)
    const byName = (name: string): Concept | undefined => concepts.find((c) => c.name === name)
    const normal = byName('정규분포'),
      stats = byName('통계학')
    assert.ok(normal && stats)
    assert.deepEqual([normal.level, normal.parentId], ['concept', topic])
    assert.equal(byName('표준화')?.parentId, normal.id)
    assert.equal(byName('정규화 상수')?.parentId, normal.id, 'the misplaced detail gets an intermediate concept')
    assert.equal(byName('베르누이 시행')?.parentId, kept, 'a valid parent stays')
    assert.equal(byName('시행 횟수')?.parentId, c1)
    assert.deepEqual([stats.level, byName('중심극한정리')?.parentId], ['topic', stats.id])
    assert.equal(byName('확률')?.level, 'topic')
    assert.ok(!byName('엉뚱한 주제'), 'a parent without valid children is not created')
    assert.equal(result.parents, 2)
    assert.deepEqual(result.skipped, [])
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: a crowded topic is offered; levels + assign regroup a concept as a sibling’s detail', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    // Manual: placement tests, not usage (weak concepts, thin topics).
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId, manual: true })
    // The migrated real-data shape: detail-ish items sit as concepts directly under the topic.
    const topic = make('확률과 통계', 'topic')
    const continuous = make('연속확률분포', 'concept', topic)
    const pdf = make('확률밀도함수 그래프', 'concept', topic)
    const exp = make('지수분포·감마분포·레일리분포', 'concept', topic)
    const discrete = make('이산확률분포', 'concept', topic)
    const binomial = make('이항분포', 'detail', discrete)
    const bayes = make('베이즈 정리', 'concept', topic)
    const conditional = make('조건부확률', 'concept', topic)
    const other = make('선형대수', 'topic')
    const matrix = make('행렬', 'concept', other)
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          merges: [],
          levels: [
            { id: pdf, level: 'detail' },
            { id: exp, level: 'detail' },
            { id: discrete, level: 'detail' }
          ],
          parents: [{ name: '확률의 기초', level: 'concept', parent: topic, children: [bayes, conditional] }],
          assign: [
            { id: pdf, parentId: continuous },
            { id: exp, parentId: continuous },
            { id: discrete, parentId: continuous }, // has a detail child: stays
            { id: matrix, parentId: continuous } // another topic's concept: not a sibling, stays
          ]
        }),
      () => {}
    )
    const plan = JSON.parse(extractor.plan(profile, ws).input)
    assert.deepEqual(plan.crowded, [topic])
    await tidyAll(extractor, profile, ws)
    const concepts = store.list<Concept>('concept')
    assertHierarchy(concepts)
    const get = (id: string): Concept | undefined => concepts.find((c) => c.id === id)
    assert.deepEqual([get(pdf)?.level, get(pdf)?.parentId], ['detail', continuous])
    assert.deepEqual([get(exp)?.level, get(exp)?.parentId], ['detail', continuous])
    assert.deepEqual([get(discrete)?.level, get(discrete)?.parentId], ['concept', topic])
    assert.equal(get(binomial)?.parentId, discrete)
    assert.deepEqual([get(matrix)?.level, get(matrix)?.parentId], ['concept', other])
    const basics = concepts.find((c) => c.name === '확률의 기초')
    assert.deepEqual([basics?.level, basics?.parentId], ['concept', topic])
    for (const id of [bayes, conditional])
      assert.deepEqual([get(id)?.level, get(id)?.parentId], ['detail', basics?.id], 'new sibling concept groups them')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: a topic is crowded after 5 new direct concepts; only candidate subtrees are sent', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    // Manual: placement tests, not usage (weak concepts, thin topics).
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId, manual: true })
    const topic = make('선형대수', 'topic')
    const under = ['벡터', '내적', '외적', '노름'].map((name) => make(name, 'concept', topic))
    const detail = make('크기와 방향', 'detail', under[0])
    const other = make('미적분', 'topic')
    const limit = make('극한', 'concept', other)
    const inputs: string[] = []
    const extractor = new KnowledgeExtractor(
      store,
      async (_profile, _model, _instruction, input) => {
        inputs.push(input)
        return JSON.stringify({ merges: [], levels: [], parents: [], assign: [] })
      },
      () => {}
    )
    assert.equal(extractor.plan(profile, ws).candidates, 0, '+4 since no baseline: not crowded')
    under.push(make('기저', 'concept', topic))
    const plan = extractor.plan(profile, ws)
    assert.deepEqual([plan.candidates, plan.crowded], [1, [topic]], '+5: crowded')
    const input = JSON.parse(plan.input)
    assert.deepEqual(
      input.concepts.map((c: Concept) => c.id).sort(),
      [topic, ...under, detail].sort(),
      'the crowded subtree only'
    )
    assert.deepEqual(input.topics, [{ id: other, name: '미적분' }], 'other topics as context')
    assert.ok(!plan.input.includes(limit), 'an unrelated topic’s concepts stay out')

    await tidyAll(extractor, profile, ws)
    assert.equal(inputs.length, 1)
    assert.equal(store.record<Concept>('concept', topic).tidiedCount, 5)
    assert.equal(extractor.plan(profile, ws).candidates, 0, 'baseline reset after the run')
    for (const name of ['차원', '랭크', '전치', '직교']) make(name, 'concept', topic)
    assert.equal(extractor.plan(profile, ws).candidates, 0, '+4 since the run: not crowded')
    make('대각화', 'concept', topic)
    assert.deepEqual(extractor.plan(profile, ws).crowded, [topic], '+5 since the run: crowded')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: the preview writes nothing; apply applies only accepted changes that still fit', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    // Manual: placement tests, not usage (weak concepts, thin topics).
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId, manual: true })
    const topic = make('확률과 통계', 'topic')
    const continuous = make('연속확률분포', 'concept', topic)
    const pdf = make('확률밀도함수 그래프', 'concept', topic)
    const clt = make('중심극한정리', 'concept')
    // Crowded, so its subtree (with the concepts the response names) is sent.
    for (const name of ['베이즈 정리', '조건부확률', '표본분산']) make(name, 'concept', topic)
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          merges: [],
          levels: [{ id: pdf, level: 'detail' }],
          parents: [{ name: '통계학', level: 'topic', children: [clt] }],
          assign: [{ id: pdf, parentId: continuous }]
        }),
      () => {}
    )
    const dump = (): string => JSON.stringify([store.list('concept'), store.list('relation')])
    const before = dump()
    const proposal = await extractor.tidyPreview(profile, ws)
    assert.equal(dump(), before, 'the preview writes nothing')
    assert.deepEqual(proposal.changes, [
      {
        kind: 'newParent',
        name: '통계학',
        level: 'topic',
        parent: null,
        children: [{ concept: { id: clt, name: '중심극한정리' }, from: null, levelFrom: 'concept', levelTo: 'concept' }]
      },
      {
        kind: 'move',
        concept: { id: pdf, name: '확률밀도함수 그래프' },
        from: { id: topic, name: '확률과 통계' },
        to: { id: continuous, name: '연속확률분포' },
        levelFrom: 'concept',
        levelTo: 'detail'
      }
    ])
    // Meanwhile the user places the concept the new parent was for: that change no longer fits.
    store.editConcept(clt, '중심극한정리', topic)
    const result = extractor.tidyApply(profile, ws, proposal.id, [0, 1], [])
    assert.deepEqual(result, {
      merged: 0,
      folded: 0,
      demoted: 0,
      renamed: 0,
      promoted: 0,
      parents: 0,
      moved: 1,
      unrelated: 0,
      retagged: 0,
      movedQuestions: 0,
      skipped: [0]
    })
    const get = (id: string): Concept => store.record<Concept>('concept', id)
    assert.deepEqual([get(pdf).level, get(pdf).parentId], ['detail', continuous])
    assert.equal(get(clt).parentId, topic)
    assert.ok(!store.findConceptByName(profile, ws, '통계학'), 'a skipped new parent is not created')
    assert.throws(() => extractor.tidyApply(profile, ws, proposal.id, [1], []), /만료/, 'a proposal applies once')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: skipped candidates are offered again; dismissed and untouched ones are not until they change', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    // Manual: placement tests, not usage (weak concepts, thin topics).
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId, manual: true })
    const topic = make('확률', 'topic')
    const normal = make('정규분포', 'concept', topic)
    const standard = make('표준 정규분포', 'concept', topic)
    const untouched = make('표준화', 'detail')
    const rejected = make('중심극한정리', 'concept')
    let calls = 0
    const extractor = new KnowledgeExtractor(
      store,
      async () => {
        calls++
        return JSON.stringify({
          merges: [{ source: standard, target: normal }],
          levels: [],
          parents: [{ name: '통계학', level: 'topic', children: [rejected] }],
          assign: []
        })
      },
      () => {}
    )
    const plan = extractor.plan(profile, ws)
    assert.equal(plan.candidates, 3)
    assert.deepEqual(plan.pairs.map((p) => [...p].sort()), [[normal, standard].sort()])
    let proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(
      proposal.changes.map((c) => c.kind),
      ['merge', 'newParent']
    )
    // Skipped (neither accepted nor dismissed): the pair and the new parent's child come back.
    extractor.tidyApply(profile, ws, proposal.id, [], [])
    let again = extractor.plan(profile, ws)
    assert.equal(again.candidates, 2, 'only the skipped changes’ subjects are offered again')
    assert.deepEqual(again.pairs.map((p) => [...p].sort()), [[normal, standard].sort()])
    assert.deepEqual(JSON.parse(again.input).orphans, [rejected])
    assert.equal(store.record<Concept>('concept', normal).tidyPairs, undefined)
    assert.ok(store.record<Concept>('concept', untouched).tidyReviewed, 'the untouched candidate is recorded')

    // Dismissed: reviewed and not offered again.
    proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(
      proposal.changes.map((c) => c.kind),
      ['merge', 'newParent']
    )
    extractor.tidyApply(profile, ws, proposal.id, [], [0, 1])
    again = extractor.plan(profile, ws)
    assert.equal(again.candidates, 0, 'dismissed and untouched candidates are reviewed')
    assert.deepEqual(store.record<Concept>('concept', normal).tidyPairs, [standard])
    assert.deepEqual(store.record<Concept>('concept', standard).tidyPairs, [normal])

    // An empty proposal still records the review.
    const other = make('베이즈 정리', 'concept')
    const empty = new KnowledgeExtractor(
      store,
      async () => JSON.stringify({ merges: [], levels: [], parents: [], assign: [] }),
      () => {}
    )
    const none = await empty.tidyPreview(profile, ws)
    assert.deepEqual(none.changes, [])
    empty.tidyApply(profile, ws, none.id, [], [])
    assert.equal(empty.plan(profile, ws).candidates, 0)
    empty.close()

    // Moved away and back: a changed candidate is offered again.
    store.editConcept(rejected, '중심극한정리', topic)
    assert.equal(extractor.plan(profile, ws).candidates, 0, 'validly placed now')
    store.editConcept(rejected, '중심극한정리', null)
    assert.deepEqual(JSON.parse(extractor.plan(profile, ws).input).orphans, [rejected])
    store.editConceptInfo(other, { level: 'detail' })
    assert.deepEqual(JSON.parse(extractor.plan(profile, ws).input).orphans.sort(), [rejected, other].sort())
    assert.equal(calls, 2)

    // A reviewed pair is forgotten with its partner.
    store.remove('concept', standard)
    assert.equal(store.record<Concept>('concept', normal).tidyPairs, undefined)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Lets pending promise callbacks (a resolved chat stub, the job runner after it) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

test('tidy: a background job runs per workspace, is read by status and cleared or applied', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const orphan = store.createConcept(profile, ws, { name: '중심극한정리', level: 'concept', manual: true })
    const ws2 = store.create('workspace', '신호처리')
    store.createConcept(profile, ws2, { name: '푸리에 변환', level: 'concept', manual: true })
    const calls: { resolve: (s: string) => void }[] = []
    const chat: Chat = () => new Promise<string>((resolve) => calls.push({ resolve }))
    let notified = 0
    const extractor = new KnowledgeExtractor(store, chat, () => notified++)

    const job = extractor.tidyStart(profile, ws)
    assert.equal(job.state, 'running')
    assert.equal(extractor.tidyStatus(profile, ws)?.state, 'running')
    assert.equal(extractor.tidyStart(profile, ws).id, job.id, 'a running job is returned as it is')
    const job2 = extractor.tidyStart(profile, ws2)
    assert.notEqual(job2.id, job.id)
    await settle()
    assert.equal(calls.length, 2, 'one tidy call per workspace')
    const before = notified
    calls[0].resolve(JSON.stringify({ merges: [], levels: [], parents: [{ name: '통계학', level: 'topic', children: [orphan] }], assign: [] }))
    calls[1].resolve(JSON.stringify({ merges: [], levels: [], parents: [], assign: [] }))
    await settle()
    assert.ok(notified > before, 'the end is announced')
    const ready = extractor.tidyStatus(profile, ws)
    assert.equal(ready?.state, 'ready')
    assert.equal(ready?.finishedAt !== null, true)
    assert.deepEqual(ready?.proposal?.changes.map((c) => c.kind), ['newParent'])
    const ready2 = extractor.tidyStatus(profile, ws2)
    assert.equal(ready2?.state, 'ready')
    assert.deepEqual(ready2?.proposal?.changes, [])
    extractor.tidyClear(profile, ws2, job2.id)
    assert.equal(extractor.tidyStatus(profile, ws2)?.state, 'ready', 'only a failed job is cleared')

    extractor.tidyApply(profile, ws, ready!.proposal!.id, [0], [])
    assert.equal(extractor.tidyStatus(profile, ws), null)
    assert.equal(extractor.tidyLastApplied(profile, ws), job.id)
    assert.ok(store.findConceptByName(profile, ws, '통계학'))
    // The other workspace's proposal did not expire.
    assert.equal(extractor.tidyStatus(profile, ws2)?.state, 'ready')
    extractor.tidyApply(profile, ws2, ready2!.proposal!.id, [], [])
    assert.equal(extractor.tidyLastApplied(profile, ws2), job2.id)

    // A failed call fails the job; clearing it removes it.
    store.createConcept(profile, ws, { name: '베이즈 정리', level: 'concept', manual: true })
    const failing = new KnowledgeExtractor(
      store,
      async () => {
        throw new Error('모델 오류')
      },
      () => {}
    )
    const failed = failing.tidyStart(profile, ws)
    await settle()
    const status = failing.tidyStatus(profile, ws)
    assert.equal(status?.state, 'failed')
    assert.equal(status?.proposal, null)
    assert.match(status?.error ?? '', /모델 오류/)
    failing.tidyClear(profile, ws, 'other')
    assert.equal(failing.tidyStatus(profile, ws)?.id, failed.id, 'another id clears nothing')
    failing.tidyClear(profile, ws, failed.id)
    assert.equal(failing.tidyStatus(profile, ws), null)
    failing.close()

    // A restart loses jobs and the applied record.
    const restarted = new KnowledgeExtractor(store, chat, () => {})
    assert.equal(restarted.tidyStatus(profile, ws), null)
    assert.equal(restarted.tidyLastApplied(profile, ws), null)
    restarted.close()
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: background re-tagging appends once and a later failure preserves a reviewable partial proposal', async () => {
  for (const fail of [false, true]) {
    const { dir, store, project, put } = setup()
    let extractor: KnowledgeExtractor | undefined
    try {
      const profile = store.active
      const ws = project.workspaceId
      const topic = store.createConcept(profile, ws, { name: '정보이론', level: 'topic', manual: true })
      const a = store.createConcept(profile, ws, { name: '엔트로피', level: 'concept', parentId: topic, manual: true })
      const b = store.createConcept(profile, ws, { name: '상호정보량', level: 'concept', parentId: topic, manual: true })
      for (const id of ['first', 'second']) {
        const q = put(id, [kTurn(`${id}-turn`, '엔트로피와 상호정보량의 관계?', '두 정보량의 관계를 설명합니다.')])
        store.put('question', profile, { ...q, conceptIds: [a, b], extractedTurns: 1 })
      }
      let calls = 0
      extractor = new KnowledgeExtractor(store, async () => {
        if (++calls === 2 && fail) throw new Error('second re-tag failed')
        return JSON.stringify({ items: [{ id: a, verdict: 'focus' }, { id: b, verdict: 'support' }] })
      }, () => {})
      const plan = extractor.plan(profile, ws)
      assert.equal(plan.retag, 2)
      assert.deepEqual(plan.items.filter((c) => c.kind === 'question').map((c) => c.question.id), ['first', 'second'])
      const initial = extractor.tidyStart(profile, ws)
      initial.progress.done = 99
      await settle()
      const ready = extractor.tidyStatus(profile, ws)!
      assert.equal(ready.state, 'ready')
      assert.deepEqual(ready.progress, { done: fail ? 1 : 2, total: 2 })
      assert.equal(ready.error, fail ? 'second re-tag failed' : '')
      assert.deepEqual(ready.proposal!.changes.map((c) => c.kind === 'retag' ? c.question.id : c.kind),
        fail ? ['first'] : ['first', 'second'])
      const accepted = ready.proposal!.changes.map((_, i) => i)
      ready.proposal!.changes.length = 0
      assert.equal(extractor.tidyStatus(profile, ws)!.proposal!.changes.length, accepted.length, 'status is a detached view')
      const result = extractor.tidyApply(profile, ws, ready.proposal!.id, accepted, [])
      assert.equal(result.retagged, fail ? 1 : 2)
      assert.deepEqual(store.record<Question>('question', 'first').conceptRoles, { [a]: 'focus', [b]: 'support' })
      assert.equal(extractor.plan(profile, ws).retag, fail ? 1 : 0)
    } finally {
      extractor?.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('tidy: a skipped change keeps only its subjects open, not its context', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    // Manual: placement tests, not usage (weak concepts, thin topics).
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId, manual: true })
    const topic = make('확률', 'topic')
    const a = make('표준 정규분포', 'concept', topic)
    const b = make('정규분포', 'concept', topic)
    const x = make('표준화', 'detail')
    const p = make('중심극한정리', 'concept')
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({ merges: [{ source: a, target: b }], levels: [], parents: [], assign: [{ id: x, parentId: p }] }),
      () => {}
    )
    assert.equal(extractor.plan(profile, ws).candidates, 3)
    let proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(proposal.changes.map((c) => c.kind).sort(), ['merge', 'move'])
    extractor.tidyApply(profile, ws, proposal.id, [], [])
    const get = (id: string): Concept => store.record<Concept>('concept', id)
    assert.equal(get(x).tidyReviewed, undefined, 'the moved concept is a subject')
    assert.ok(get(p).tidyReviewed, 'the destination parent is context: recorded')
    assert.equal(get(a).tidyPairs, undefined)
    assert.equal(get(b).tidyPairs, undefined)
    const plan = extractor.plan(profile, ws)
    assert.deepEqual(JSON.parse(plan.input).orphans, [x])
    assert.deepEqual(plan.pairs.map((pair) => [...pair].sort()), [[a, b].sort()])

    proposal = await extractor.tidyPreview(profile, ws)
    extractor.tidyApply(profile, ws, proposal.id, [], proposal.changes.map((_, i) => i))
    assert.ok(get(x).tidyReviewed)
    assert.deepEqual(get(a).tidyPairs, [b])
    assert.equal(extractor.plan(profile, ws).candidates, 0, 'dismissed: none offered again')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: a skipped fold inside a thin topic leaves the topic unreviewed', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const topic = store.createConcept(profile, ws, { name: '신호처리', level: 'topic' })
    const kept = store.createConcept(profile, ws, { name: '푸리에 변환', level: 'concept', parentId: topic })
    const weak = store.createConcept(profile, ws, { name: '라플라스 변환', level: 'concept', parentId: topic })
    const extractor = new KnowledgeExtractor(
      store,
      async () => JSON.stringify({ folds: [{ source: weak, target: kept }] }),
      () => {}
    )
    assert.deepEqual(JSON.parse(extractor.plan(profile, ws).input).thin, [topic])
    let proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(proposal.changes, [
      { kind: 'fold', source: { id: weak, name: '라플라스 변환' }, target: { id: kept, name: '푸리에 변환' } }
    ])
    extractor.tidyApply(profile, ws, proposal.id, [], [])
    assert.equal(store.record<Concept>('concept', topic).tidyKept, undefined)
    assert.equal(store.record<Concept>('concept', weak).tidyKept, undefined)
    assert.deepEqual(JSON.parse(extractor.plan(profile, ws).input).thin, [topic])

    proposal = await extractor.tidyPreview(profile, ws)
    extractor.tidyApply(profile, ws, proposal.id, [], [0])
    assert.ok(store.record<Concept>('concept', topic).tidyKept, 'dismissed: the topic is reviewed')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skippedSubjects: subjects per change kind; context refs and retags add nothing', () => {
  const concepts = new Map<string, Concept>(
    [
      ['t', null, 'topic'],
      ['c', 't', 'concept'],
      ['d', 'c', 'detail'],
      ['old', null, 'concept'],
      ['dest', null, 'concept']
    ].map(([id, parentId, level]) => [id!, { id: id!, parentId, level, name: id } as unknown as Concept])
  )
  const graph = {
    get: (id: unknown): Concept | undefined => (typeof id === 'string' ? concepts.get(id) : undefined),
    follow: (id: unknown): unknown => (id === 'merged' ? 'c' : id),
    resolve: (ref: unknown): Concept | undefined => (ref === 'old' ? concepts.get('old') : undefined)
  }
  const ref = (id: string | null): { id: string | null; name: string } => ({ id, name: id ?? 'new' })
  const question = { id: 'q', title: 'Q' }
  const changes: TidyChange[] = [
    { kind: 'move', concept: ref('d'), from: ref('c'), to: ref('dest'), levelFrom: 'detail', levelTo: 'detail' },
    { kind: 'merge', source: ref('merged'), target: ref(null) },
    { kind: 'newParent', name: 'old', level: 'concept', parent: ref('t'), children: [] },
    { kind: 'promote', name: ' Bayes ', level: 'concept', parent: ref('dest'), questions: [question] },
    { kind: 'unrelate', relation: 'r', from: ref('old'), to: ref('dest'), type: 'uses' },
    { kind: 'moveQuestion', question, to: { projectId: 'p', projectName: 'P', workspaceName: 'W' } },
    { kind: 'retag', question: { id: 'q2', title: 'Q2' }, items: [], confirm: false }
  ]
  const all = skippedSubjects(graph, changes, changes.map((_, i) => i))
  assert.deepEqual([...all.concepts].sort(), ['c', 'd', 'merged', 'old'].sort())
  assert.ok(!all.concepts.has('dest') && !all.concepts.has('t'), 'destinations and parents are context')
  assert.deepEqual([...all.ancestors].sort(), ['c', 't'])
  assert.deepEqual([...all.pairs], ['dest|old'])
  assert.equal(all.promotions.size, 1)
  assert.deepEqual([...all.questions], ['q'], 'a retag records nothing, so it adds nothing')
  const none = skippedSubjects(graph, changes, [])
  assert.deepEqual([none.concepts.size, none.pairs.size, none.questions.size], [0, 0, 0])
})

test('zip writer output has valid headers, CRCs, and UTF-8 names', () => {
  const files = unzip(
    zip([
      { name: '개념.txt', data: Buffer.from('한글 내용'.repeat(50)) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'raw.bin', data: Buffer.from([1, 2, 3]), stored: true }
    ])
  )
  assert.equal(files.get('개념.txt')?.toString(), '한글 내용'.repeat(50))
  assert.equal(files.get('empty.txt')?.length, 0)
  assert.deepEqual([...(files.get('raw.bin') ?? [])], [1, 2, 3])
})

test('export archive holds README, JSONL, SKOS; options gate images, conversations, memo and relations', () => {
  const workspace: Workspace = { id: 'w', profileId: 'p', name: '수학' }
  const project: Project = { id: 'p1', workspaceId: 'w', name: '선형대수', description: '' }
  const concept = (id: string, name: string, parentId: string | null, level: Concept['level']): Concept => ({
    id,
    workspaceId: 'w',
    name,
    parentId,
    manual: false,
    aliases: id === 'c2' ? ['eigen "value"'] : [],
    definition: id === 'c2' ? '배율\n한 줄' : '',
    level
  })
  const concepts = [
    concept('c1', '선형대수', null, 'topic'),
    concept('c2', '고유값', 'c1', 'concept'),
    concept('c3', '미분', null, 'topic')
  ]
  const q: Question = {
    id: 'q',
    projectId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    turns: [{ ...kTurn('t', '고유값?', '답'), attachment: 'a.png' }],
    conceptIds: ['c2'],
    conceptTurns: { c2: ['t'] },
    extractedTurns: 1,
    suggestions: [],
    memo: '메모',
    important: false
  }
  const relations: Relation[] = [
    { id: 'r1', workspaceId: 'w', from: 'c2', to: 'c1', type: 'part', questionId: 'q', turnIds: ['t'], confidence: 0.9, approved: true, createdAt: '', invalidatedAt: null },
    { id: 'r2', workspaceId: 'w', from: 'c2', to: 'c1', type: 'uses', questionId: 'q', turnIds: ['t'], confidence: 0.9, approved: true, createdAt: '', invalidatedAt: '2026-01-02' },
    { id: 'r3', workspaceId: 'w', from: 'c2', to: 'c1', type: 'example', questionId: 'q', turnIds: ['t'], confidence: 0.5, approved: false, createdAt: '', invalidatedAt: null }
  ]
  const source = { workspace, project, concepts, relations, questions: [q], image: () => Buffer.from('png') }
  const files = unzip(buildExport(source, exportOptions({ images: false })))
  const rows = (archive: Map<string, Buffer>, name: string): Record<string, unknown>[] =>
    (archive.get(name)?.toString() ?? '').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual([...files.keys()].sort(), ['README.md', 'concepts.jsonl', 'ontology.ttl', 'questions.jsonl', 'relations.jsonl'])
  const readme = files.get('README.md')?.toString() ?? ''
  assert.match(readme, /NOT verified facts/)
  assert.match(readme, /- 선형대수 \[topic\]\n {2}- 고유값 \[concept\]/)
  const exported = (files.get('concepts.jsonl')?.toString() ?? '').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(exported.map((c) => c.id).sort(), ['c1', 'c2'], 'unlinked concepts stay out; ancestors come along')
  assert.equal(rows(files, 'relations.jsonl').length, 2, 'invalidated relations stay out')
  const ttl = files.get('ontology.ttl')?.toString() ?? ''
  assert.match(ttl, /skos:broader <urn:fask:concept:c1>/)
  assert.match(ttl, /fask:part rdfs:subPropertyOf|fask:part a owl:ObjectProperty ; rdfs:subPropertyOf skos:related/)
  assert.match(ttl, /skos:altLabel "eigen \\"value\\""/)
  assert.match(ttl, /skos:definition "배율\\n한 줄"/)
  assert.ok(!JSON.parse(files.get('questions.jsonl')?.toString() ?? '{}').turns[0].image)
  assert.equal(rows(files, 'questions.jsonl')[0].memo, '메모')
  const withImages = unzip(buildExport(source, exportOptions({ images: true })))
  assert.equal(withImages.get('images/a.png')?.toString(), 'png')
  assert.equal(JSON.parse(withImages.get('questions.jsonl')?.toString() ?? '{}').turns[0].image, 'images/a.png')

  // Graph only: no conversations, so no images even when asked, and no question provenance.
  const graph = unzip(buildExport(source, exportOptions({ conversations: false, images: true })))
  assert.deepEqual([...graph.keys()].sort(), ['README.md', 'concepts.jsonl', 'ontology.ttl', 'relations.jsonl'])
  for (const r of rows(graph, 'relations.jsonl')) assert.ok(!('questionId' in r) && !('turnIds' in r))
  for (const c of rows(graph, 'concepts.jsonl')) assert.ok(!('questionIds' in c))
  assert.match(graph.get('README.md')?.toString() ?? '', /conversations it was built from are not included/)

  const noMemo = unzip(buildExport(source, exportOptions({ memo: false })))
  assert.ok(!('memo' in rows(noMemo, 'questions.jsonl')[0]))

  const approved = unzip(buildExport(source, exportOptions({ approvedOnly: true })))
  assert.deepEqual(rows(approved, 'relations.jsonl').map((r) => r.id), ['r1'])
  assert.match(approved.get('README.md')?.toString() ?? '', /only relations the user approved/)
})

test('exportOptions: non-boolean input takes defaults; memo and images need conversations', () => {
  assert.deepEqual(exportOptions('x'), EXPORT_DEFAULTS)
  assert.deepEqual(exportOptions({ memo: 'yes', approvedOnly: 1 }), EXPORT_DEFAULTS)
  assert.equal(exportOptions({ conversations: false, memo: true }).memo, false)
  assert.equal(exportOptions({ conversations: false, images: true }).images, false)
})

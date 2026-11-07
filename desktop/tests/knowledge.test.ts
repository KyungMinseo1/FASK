import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { PersonalStore } from '../src/main/personal-store'
import { KnowledgeExtractor, type Chat } from '../src/main/knowledge-extract'
import { buildExport, zip } from '../src/main/knowledge-export'
import { PARENT_LEVEL } from '../src/main/personal-backup'
import type { Concept, Project, Question, Relation, TidyResult, Turn, Workspace } from '../src/preload/personal'

/** Every parent sits exactly one level above its child; topics have no parent. */
function assertHierarchy(concepts: Concept[]): void {
  const byId = new Map(concepts.map((c) => [c.id, c]))
  for (const c of concepts)
    if (c.parentId) assert.equal(byId.get(c.parentId)?.level, PARENT_LEVEL[c.level], `${c.name} under ${c.parentId}`)
}

/** Previews a tidy and applies every proposed change. */
async function tidyAll(extractor: KnowledgeExtractor, profile: string, ws: string): Promise<TidyResult> {
  const proposal = await extractor.tidyPreview(profile, ws)
  return extractor.tidyApply(profile, ws, proposal.id, proposal.changes.map((_, i) => i))
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
              { name: '고유값', aliases: ['eigenvalue'], definition: '배율', level: 'concept', parent: '선형대수', turns: [0], confidence: 0.9 },
              { name: '스펙트럼 정리', level: 'concept', parent: null, turns: [0], confidence: 0.4 }
            ]
          : [{ name: '고유벡터', level: 'concept', parent: '선형대수', turns: [1], confidence: 0.8 }],
        relations: first ? [] : [{ from: '고유벡터', to: '고유값', type: 'uses', confidence: 0.5 }]
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
    const relations = store.list<Relation>('relation')
    assert.equal(relations.length, 1)
    assert.equal(relations[0].approved, false, 'low-confidence relation waits for approval')
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
            { name: '표준화', level: 'detail', parent: '정규분포', grandparent: '확률', turns: [0], confidence: 0.9 },
            { name: 'z-점수', level: 'detail', parent: '확률', turns: [0], confidence: 0.9 },
            { name: '확률론', level: 'topic', parent: '수학', turns: [0], confidence: 0.9 }
          ],
          relations: []
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

test('tidy: orphans and misplaced concepts are candidates; applying never breaks the 3-level tree', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId })
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
            { id: d2, parentId: kept },
            { id: keptDetail, parentId: kept } // already validly placed: untouched
          ],
          relations: []
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
    assert.equal(byName('시행 횟수')?.parentId, kept)
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
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId })
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
          ],
          relations: []
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
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId })
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
        return JSON.stringify({ merges: [], levels: [], parents: [], assign: [], relations: [] })
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
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId })
    const topic = make('확률과 통계', 'topic')
    const continuous = make('연속확률분포', 'concept', topic)
    const pdf = make('확률밀도함수 그래프', 'concept', topic)
    const clt = make('중심극한정리', 'concept')
    const extractor = new KnowledgeExtractor(
      store,
      async () =>
        JSON.stringify({
          merges: [],
          levels: [{ id: pdf, level: 'detail' }],
          parents: [{ name: '통계학', level: 'topic', children: [clt] }],
          assign: [{ id: pdf, parentId: continuous }],
          relations: [{ from: clt, to: continuous, type: 'uses', confidence: 0.8 }]
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
      },
      {
        kind: 'relation',
        from: { id: clt, name: '중심극한정리' },
        to: { id: continuous, name: '연속확률분포' },
        type: 'uses',
        confidence: 0.8
      }
    ])
    // Meanwhile the user places the concept the new parent was for: that change no longer fits.
    store.editConcept(clt, '중심극한정리', topic)
    const result = extractor.tidyApply(profile, ws, proposal.id, [0, 1])
    assert.deepEqual(result, { merged: 0, parents: 0, moved: 1, relations: 0, skipped: [0] })
    const get = (id: string): Concept => store.record<Concept>('concept', id)
    assert.deepEqual([get(pdf).level, get(pdf).parentId], ['detail', continuous])
    assert.equal(get(clt).parentId, topic)
    assert.ok(!store.findConceptByName(profile, ws, '통계학'), 'a skipped new parent is not created')
    assert.equal(store.list<Relation>('relation').length, 0, 'the unaccepted relation is not added')
    assert.throws(() => extractor.tidyApply(profile, ws, proposal.id, [2]), /만료/, 'a proposal applies once')
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy: rejected and untouched candidates are not offered again until they change', async () => {
  const { dir, store, project } = setup()
  try {
    const profile = store.active
    const ws = project.workspaceId
    const make = (name: string, level: Concept['level'], parentId: string | null = null): string =>
      store.createConcept(profile, ws, { name, level, parentId })
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
          assign: [],
          relations: []
        })
      },
      () => {}
    )
    const plan = extractor.plan(profile, ws)
    assert.equal(plan.candidates, 3)
    assert.deepEqual(plan.pairs.map((p) => [...p].sort()), [[normal, standard].sort()])
    const proposal = await extractor.tidyPreview(profile, ws)
    assert.deepEqual(
      proposal.changes.map((c) => c.kind),
      ['merge', 'newParent']
    )
    extractor.tidyApply(profile, ws, proposal.id, [])
    assert.equal(extractor.plan(profile, ws).candidates, 0, 'rejected and untouched candidates are reviewed')
    assert.deepEqual(store.record<Concept>('concept', normal).tidyPairs, [standard])
    assert.deepEqual(store.record<Concept>('concept', standard).tidyPairs, [normal])

    // An empty proposal still records the review.
    const other = make('베이즈 정리', 'concept')
    const empty = new KnowledgeExtractor(
      store,
      async () => JSON.stringify({ merges: [], levels: [], parents: [], assign: [], relations: [] }),
      () => {}
    )
    const none = await empty.tidyPreview(profile, ws)
    assert.deepEqual(none.changes, [])
    empty.tidyApply(profile, ws, none.id, [])
    assert.equal(empty.plan(profile, ws).candidates, 0)
    empty.close()

    // Moved away and back: a changed candidate is offered again.
    store.editConcept(rejected, '중심극한정리', topic)
    assert.equal(extractor.plan(profile, ws).candidates, 0, 'validly placed now')
    store.editConcept(rejected, '중심극한정리', null)
    assert.deepEqual(JSON.parse(extractor.plan(profile, ws).input).orphans, [rejected])
    store.editConceptInfo(other, { level: 'detail' })
    assert.deepEqual(JSON.parse(extractor.plan(profile, ws).input).orphans.sort(), [rejected, other].sort())
    assert.equal(calls, 1)

    // A reviewed pair is forgotten with its partner.
    store.remove('concept', standard)
    assert.equal(store.record<Concept>('concept', normal).tidyPairs, undefined)
    extractor.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
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

test('export archive holds README, JSONL, SKOS; images only when requested', () => {
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
    { id: 'r2', workspaceId: 'w', from: 'c2', to: 'c1', type: 'uses', questionId: 'q', turnIds: ['t'], confidence: 0.9, approved: true, createdAt: '', invalidatedAt: '2026-01-02' }
  ]
  const source = { workspace, project, concepts, relations, questions: [q], image: () => Buffer.from('png') }
  const files = unzip(buildExport(source, { images: false }))
  assert.deepEqual([...files.keys()].sort(), ['README.md', 'concepts.jsonl', 'ontology.ttl', 'questions.jsonl', 'relations.jsonl'])
  const readme = files.get('README.md')?.toString() ?? ''
  assert.match(readme, /NOT verified facts/)
  assert.match(readme, /- 선형대수 \[topic\]\n {2}- 고유값 \[concept\]/)
  const exported = (files.get('concepts.jsonl')?.toString() ?? '').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(exported.map((c) => c.id).sort(), ['c1', 'c2'], 'unlinked concepts stay out; ancestors come along')
  assert.equal((files.get('relations.jsonl')?.toString() ?? '').trim().split('\n').length, 1, 'invalidated relations stay out')
  const ttl = files.get('ontology.ttl')?.toString() ?? ''
  assert.match(ttl, /skos:broader <urn:fask:concept:c1>/)
  assert.match(ttl, /fask:part rdfs:subPropertyOf|fask:part a owl:ObjectProperty ; rdfs:subPropertyOf skos:related/)
  assert.match(ttl, /skos:altLabel "eigen \\"value\\""/)
  assert.match(ttl, /skos:definition "배율\\n한 줄"/)
  assert.ok(!JSON.parse(files.get('questions.jsonl')?.toString() ?? '{}').turns[0].image)
  const withImages = unzip(buildExport(source, { images: true }))
  assert.equal(withImages.get('images/a.png')?.toString(), 'png')
  assert.equal(JSON.parse(withImages.get('questions.jsonl')?.toString() ?? '{}').turns[0].image, 'images/a.png')
})

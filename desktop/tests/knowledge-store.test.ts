import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PersonalStore } from '../src/main/personal-store'
import { validateBackup } from '../src/main/personal-backup'
import { searchTerms } from '../src/main/knowledge-search'
import type { Concept, Project, Question, Relation, Turn } from '../src/preload/personal'

function sTurn(id: string, sent: string, answer = ''): Turn {
  return {
    id,
    createdAt: '2026-01-01T10:00:00.000Z',
    raw: sent,
    refined: '',
    sent,
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
function sQuestion(
  id: string,
  projectId: string,
  turns: Turn[],
  conceptIds: string[] = []
): Question {
  return {
    id,
    projectId,
    createdAt: turns[0].createdAt,
    turns,
    conceptIds,
    conceptTurns: {},
    extractedTurns: 0,
    suggestions: [],
    memo: '',
    important: false
  }
}
function withStore(name: string, run: (store: PersonalStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `fask-${name}-`))
  const store = new PersonalStore(dir)
  try {
    run(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// A 1.1.x database: schema 2, concepts owned by projects, `memory` boolean in settings.
function schema2Database(dir: string): void {
  const db = new DatabaseSync(join(dir, 'fask.sqlite'))
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES(1); INSERT INTO schema_migrations VALUES(2);
    CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX records_scope ON records(profile,kind);
    CREATE TABLE preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY, question_id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', turn_id TEXT NOT NULL DEFAULT '', request_hash TEXT NOT NULL DEFAULT '');`)
  const put = (kind: string, profile: string, value: object & { id: string }): void => {
    db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(
      value.id,
      kind,
      profile,
      JSON.stringify(value)
    )
  }
  put('profile', '*', { id: 'P', name: '기본 프로필' })
  db.prepare('INSERT INTO preferences VALUES(?,?)').run('active', 'P')
  db.prepare('INSERT INTO preferences VALUES(?,?)').run(
    'settings:P',
    JSON.stringify({ model: 'm', memory: false, organize: true })
  )
  put('workspace', 'P', { id: 'W', profileId: 'P', name: 'w' })
  put('workspace', 'P', { id: 'W2', profileId: 'P', name: 'w2' })
  put('project', 'P', { id: 'PA', workspaceId: 'W', name: 'a', description: '' })
  put('project', 'P', { id: 'PB', workspaceId: 'W', name: 'b', description: '' })
  put('project', 'P', { id: 'PC', workspaceId: 'W2', name: 'c', description: '' })
  const concept = (
    id: string,
    projectId: string,
    name: string,
    parentId: string | null = null
  ): void => put('concept', 'P', { id, projectId, name, parentId, manual: false })
  concept('X', 'PA', '행렬')
  concept('X2', 'PB', ' 행렬 ')
  concept('Y', 'PB', '고유값', 'X2')
  concept('Z', 'PC', '행렬')
  concept('O', 'gone', '고아')
  const legacyQ = (q: Question): object & { id: string } => {
    const legacy: Partial<Question> & { id: string } = { ...q }
    delete legacy.conceptTurns
    delete legacy.extractedTurns
    return legacy
  }
  put('question', 'P', legacyQ(sQuestion('QA', 'PA', [sTurn('a1', '행렬 곱셈')], ['X'])))
  put(
    'question',
    'P',
    legacyQ(sQuestion('QB', 'PB', [sTurn('b1', '고유값'), sTurn('b2', '고유벡터')], ['X2', 'Y']))
  )
  db.close()
}

test('schema 3 migration moves project concepts into workspaces and merges exact duplicates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-migrate-kg-'))
  schema2Database(dir)
  let store = new PersonalStore(dir)
  try {
    const concepts = new Map(store.list<Concept>('concept', 'P').map((c) => [c.id, c]))
    assert.deepEqual([...concepts.keys()].sort(), ['X', 'Y', 'Z'])
    assert.deepEqual(concepts.get('X'), {
      id: 'X',
      workspaceId: 'W',
      name: '행렬',
      parentId: null,
      manual: false,
      aliases: [],
      definition: '',
      level: 'concept'
    })
    assert.equal(concepts.get('Y')?.parentId, 'X')
    assert.equal(concepts.get('Y')?.level, 'detail', 'schema 4 puts a child one level below')
    assert.equal(concepts.get('Z')?.workspaceId, 'W2')
    const qb = store.record<Question>('question', 'QB', 'P')
    assert.deepEqual(qb.conceptIds, ['X', 'Y'])
    assert.deepEqual(qb.conceptTurns, {})
    // Existing questions are not re-extracted automatically.
    assert.equal(qb.extractedTurns, 2)
    assert.equal(store.settings('P').memoryScope, 'off')
    assert.equal('memory' in JSON.parse(store.pref('settings:P')), false)
    assert.equal(store.settings('P').model, 'm')
    assert.ok(existsSync(join(dir, 'fask-pre-kg.sqlite')))
    assert.deepEqual(
      store
        .search('P', '고유값', { workspaceId: 'W', kinds: ['concept'], limit: 5 })
        .map((h) => h.id),
      ['Y']
    )
    store.close()
    store = new PersonalStore(dir)
    assert.equal(store.list<Concept>('concept', 'P').length, 3)
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=3').get()?.n,
      1
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: trigram MATCH, LIKE for 2-character terms, particle stems, scopes, and index sync', () => {
  withStore('search', (store) => {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    const ws = project.workspaceId
    const matrix = store.create('concept', '행렬', project.id)
    const eigen = store.createConcept(profile, ws, {
      name: '고유값',
      aliases: ['eigenvalue'],
      definition: '선형 변환에서 방향이 유지되는 벡터의 배율'
    })
    const other = store.create('project', '다른 프로젝트', ws)
    store.put(
      'question',
      profile,
      sQuestion('q1', project.id, [sTurn('t1', '행렬 분해가 뭐야?', '고유값 분해는 …')], [eigen])
    )
    store.put('question', profile, sQuestion('q2', other, [sTurn('t2', '미분 방정식')]))
    const far = store.create('workspace', '먼 곳')
    store.create('concept', '행렬식', store.create('project', '먼 프로젝트', far))

    assert.deepEqual(searchTerms('행렬의 고유값').short, ['행렬'])
    assert.deepEqual(
      store.search(profile, '고유값', { kinds: ['concept'], limit: 5 }).map((h) => h.id),
      [eigen]
    )
    assert.deepEqual(
      store.search(profile, 'EigenValues', { kinds: ['concept'], limit: 5 }).map((h) => h.id),
      [eigen]
    )
    const short = store.search(profile, '행렬', { workspaceId: ws, kinds: ['concept'], limit: 5 })
    assert.deepEqual(
      short.map((h) => h.id),
      [matrix]
    )
    assert.ok(short[0].score > 0)
    assert.deepEqual(
      store
        .search(profile, '행렬의', { workspaceId: ws, kinds: ['concept'], limit: 5 })
        .map((h) => h.id),
      [matrix]
    )
    assert.equal(store.search(profile, '행렬', { kinds: ['concept'], limit: 5 }).length, 2)
    assert.deepEqual(
      store
        .search(profile, '고유값 분해', { projectId: project.id, limit: 5 })
        .map((h) => h.kind)
        .sort(),
      ['concept', 'question']
    )
    assert.deepEqual(store.search(profile, '미분', { projectId: project.id, limit: 5 }), [])
    assert.deepEqual(
      store.search(profile, '미분', { kinds: ['question'], limit: 5 }).map((h) => h.id),
      ['q2']
    )
    assert.deepEqual(store.search(profile, '  ', { limit: 5 }), [])
    assert.deepEqual(store.search('other-profile', '고유값', { limit: 5 }), [])

    store.rename('concept', matrix, '선형대수 행렬')
    assert.equal(store.search(profile, '선형대수', { kinds: ['concept'], limit: 5 })[0]?.id, matrix)
    store.remove('concept', eigen)
    assert.equal(store.search(profile, 'eigenvalue', { limit: 5 }).length, 0)
    store.remove('question', 'q2')
    assert.deepEqual(store.search(profile, '방정식', { limit: 5 }), [])
  })
})

test('concepts dedupe by name/alias; links keep turns; relations dedupe and are never revived', () => {
  withStore('concepts', (store) => {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    const ws = project.workspaceId
    const a = store.create('concept', '행렬', project.id)
    assert.equal(store.create('concept', ' 행렬 ', project.id), a)
    assert.equal(store.createConcept(profile, ws, { name: 'Matrix', aliases: ['행렬'] }), a)
    assert.deepEqual(store.record<Concept>('concept', a).aliases, ['Matrix'])
    assert.equal(store.findConceptByName(profile, ws, 'matrix')?.id, a)
    assert.throws(
      () => store.createConcept(profile, ws, { name: '고유값', level: 'topic', parentId: a }),
      /주제는 상위 개념을/
    )
    const b = store.createConcept(profile, ws, { name: '고유값', level: 'detail', parentId: a })
    assert.equal(store.record<Concept>('concept', b).level, 'detail')
    assert.throws(() => store.editConceptInfo(b, { aliases: ['matrix'] }), /이미 있습니다/)
    assert.throws(() => store.editConcept(b, 'Matrix', a), /이미 있습니다/)
    assert.throws(() => store.editConceptInfo(b, { level: 'huge' as Concept['level'] }), /단계/)
    store.editConceptInfo(b, {
      aliases: [' eigenvalue ', 'Eigenvalue', '고유값'],
      definition: ' 배율 '
    })
    assert.deepEqual(store.record<Concept>('concept', b).aliases, ['eigenvalue'])
    assert.equal(store.record<Concept>('concept', b).definition, '배율')

    const c = store.createConcept(profile, ws, { name: '스칼라' })
    store.put(
      'question',
      profile,
      sQuestion('q', project.id, [
        sTurn('t1', 'x'),
        sTurn('t2', '행렬이 뭐야?'),
        sTurn('t3', 'z', 'An EIGENVALUE scales a vector.')
      ])
    )
    const turnsOf = (): Question['conceptTurns'] => store.record<Question>('question', 'q').conceptTurns
    // A manual link records the turns mentioning its name or an alias, case-insensitively.
    store.updateQuestion('q', { conceptIds: [a] })
    assert.deepEqual(turnsOf(), { [a]: ['t2'] })
    store.updateQuestion('q', { conceptIds: [a, b, c] })
    assert.deepEqual(turnsOf(), { [a]: ['t2'], [b]: ['t3'] }, 'no mention: no entry')
    store.updateQuestion('q', { conceptIds: [b] })
    assert.deepEqual(turnsOf(), { [b]: ['t3'] })
    // Given positions win; only a newly linked concept without one is searched.
    store.updateQuestion('q', { conceptIds: [a, b], conceptTurns: { [b]: ['t1', 'missing'] } })
    assert.deepEqual(turnsOf(), { [a]: ['t2'], [b]: ['t1'] })
    assert.throws(() => store.updateQuestion('q', { conceptTurns: { [c]: ['t1'] } }), /형식/)

    const rel = {
      from: a,
      to: b,
      type: 'part' as const,
      questionId: 'q',
      turnIds: ['t2'],
      confidence: 0.4,
      approved: false
    }
    const r1 = store.addRelation(profile, rel)
    assert.equal(store.addRelation(profile, { ...rel, confidence: 0.9, approved: true }), r1)
    assert.deepEqual(
      (({ confidence, approved }) => ({ confidence, approved }))(
        store.record<Relation>('relation', r1)
      ),
      { confidence: 0.9, approved: true }
    )
    assert.throws(() => store.addRelation(profile, { ...rel, to: a }), /서로 다른 개념/)
    store.setRelation(r1, 'remove')
    assert.ok(store.record<Relation>('relation', r1).invalidatedAt)
    assert.equal(store.addRelation(profile, rel), r1)
    assert.equal(store.list<Relation>('relation').length, 1)
    assert.equal(store.snapshot().relations.length, 1)
    const r2 = store.addRelation(profile, { ...rel, type: 'uses' })
    store.setRelation(r2, 'approve')
    assert.equal(store.record<Relation>('relation', r2).approved, true)
    // Deleting the source question keeps the relation and clears its provenance.
    store.remove('question', 'q')
    assert.deepEqual(
      (({ questionId, turnIds }) => ({ questionId, turnIds }))(
        store.record<Relation>('relation', r2)
      ),
      { questionId: null, turnIds: [] }
    )
    store.remove('concept', b)
    assert.equal(store.list<Relation>('relation').length, 0)
  })
})

test('mergeConcept moves links, turn positions, relations and names to the target', () => {
  withStore('merge', (store) => {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    const ws = project.workspaceId
    const source = store.createConcept(profile, ws, {
      name: '행렬곱',
      aliases: ['matmul'],
      definition: '곱'
    })
    const target = store.createConcept(profile, ws, { name: '행렬 곱셈' })
    const c = store.createConcept(profile, ws, { name: '벡터' })
    const child = store.createConcept(profile, ws, {
      name: '아다마르 곱',
      level: 'detail',
      parentId: source
    })
    store.put('question', profile, {
      ...sQuestion('q', project.id, [sTurn('t1', 'x'), sTurn('t2', 'y')], [source, target]),
      conceptTurns: { [source]: ['t2'] }
    })
    store.put('question', profile, sQuestion('q2', project.id, [sTurn('u1', 'x')], [source]))
    const base = { questionId: null, turnIds: [], confidence: 0.8, approved: true }
    const moved = store.addRelation(profile, { ...base, from: source, to: c, type: 'uses' })
    const twin = store.addRelation(profile, {
      ...base,
      from: target,
      to: c,
      type: 'uses',
      approved: false
    })
    const loop = store.addRelation(profile, { ...base, from: source, to: target, type: 'part' })
    const removed = store.addRelation(profile, { ...base, from: c, to: source, type: 'example' })
    store.setRelation(removed, 'remove')
    store.mergeConcept(source, target)

    const q = store.record<Question>('question', 'q')
    assert.deepEqual(q.conceptIds, [target])
    assert.deepEqual(q.conceptTurns, { [target]: ['t2'] }, 'only recorded turns carry over')
    const q2 = store.record<Question>('question', 'q2')
    assert.deepEqual([q2.conceptIds, q2.conceptTurns], [[target], {}], 'no recorded turns: no entry')
    assert.equal(store.record<Concept>('concept', child).parentId, target)
    const merged = store.record<Concept>('concept', target)
    assert.deepEqual(merged.aliases, ['행렬곱', 'matmul'])
    assert.equal(merged.definition, '곱')
    const relations = store.list<Relation>('relation')
    assert.equal(
      relations.some((r) => r.id === moved || r.id === loop),
      false
    )
    assert.equal(store.record<Relation>('relation', twin).approved, true)
    const kept = store.record<Relation>('relation', removed)
    assert.deepEqual([kept.from, kept.to, !!kept.invalidatedAt], [c, target, true])
    assert.equal(store.search(profile, 'matmul', { kinds: ['concept'], limit: 5 })[0]?.id, target)
    assert.throws(() => store.record('concept', source), /찾을 수 없습니다/)
  })
})

test('backup v3 round-trips relations; v2 concepts upgrade into workspaces', () => {
  withStore('backup-kg', (store) => {
    const profile = store.active
    const project = store.list<Project>('project')[0]
    const ws = project.workspaceId
    const a = store.create('concept', 'A', project.id)
    const b = store.create('concept', 'B', project.id)
    store.put('question', profile, sQuestion('q', project.id, [sTurn('t1', 'x')], [a]))
    store.addRelation(profile, {
      from: a,
      to: b,
      type: 'prerequisite',
      questionId: 'q',
      turnIds: ['t1'],
      confidence: 0.5,
      approved: false
    })
    const snapshot = store.snapshot()
    assert.equal(
      validateBackup({ version: 3, snapshot: structuredClone(snapshot), images: {} }).snapshot
        .relations.length,
      1
    )
    const bad = (mutate: (s: typeof snapshot) => void): void => {
      const s = structuredClone(snapshot)
      mutate(s)
      assert.throws(() => validateBackup({ version: 3, snapshot: s, images: {} }), /백업/)
    }
    bad((s) => (s.relations[0].to = 'missing'))
    bad((s) => (s.relations[0].type = 'broader' as Relation['type']))
    bad((s) => (s.relations[0].turnIds = ['nope']))
    bad((s) => (s.relations[0].confidence = 2))
    bad((s) => (s.questions[0].conceptTurns = { [b]: ['t1'] }))
    bad((s) => (s.questions[0].extractedTurns = 5))
    bad((s) => (s.concepts[0].level = 'x' as Concept['level']))
    bad((s) => {
      const other = { ...s.workspaces[0], id: 'W-other' }
      s.workspaces.push(other)
      s.concepts[1].workspaceId = other.id
    })
    // v3 backups from before the 3-level rule: 'domain' becomes 'topic', the tree is repaired.
    const legacyLevels = structuredClone(snapshot)
    legacyLevels.concepts[0].level = 'domain' as Concept['level']
    legacyLevels.concepts[1].parentId = a
    assert.deepEqual(
      validateBackup({ version: 3, snapshot: legacyLevels, images: {} }).snapshot.concepts.map(
        (c) => [c.id, c.level, c.parentId]
      ),
      [
        [a, 'topic', null],
        [b, 'concept', a]
      ]
    )

    // v2: concepts carry projectId; same-name concepts of one workspace merge.
    const second = store.create('project', '둘째', ws)
    const oldSettings: Partial<typeof snapshot.settings> = { ...snapshot.settings }
    delete oldSettings.memoryScope
    const v2 = {
      version: 2,
      snapshot: {
        ...snapshot,
        relations: undefined,
        settings: { ...oldSettings, memory: true },
        projects: [
          ...snapshot.projects,
          { id: second, workspaceId: ws, name: '둘째', description: '' }
        ],
        concepts: [
          { id: 'c1', projectId: project.id, name: '행렬', parentId: null, manual: true },
          { id: 'c2', projectId: second, name: '행렬', parentId: null, manual: false },
          { id: 'c3', projectId: second, name: '고유값', parentId: 'c2', manual: false }
        ],
        questions: [
          {
            ...snapshot.questions[0],
            conceptIds: ['c1'],
            conceptTurns: undefined,
            extractedTurns: undefined
          }
        ]
      },
      images: {}
    }
    const upgraded = validateBackup(structuredClone(v2))
    assert.equal(upgraded.version, 3)
    assert.deepEqual(
      upgraded.snapshot.concepts.map((c) => [c.id, c.workspaceId, c.parentId, c.level]),
      [
        ['c1', ws, null, 'concept'],
        ['c3', ws, 'c1', 'detail']
      ]
    )
    assert.deepEqual(upgraded.snapshot.relations, [])
    assert.equal(upgraded.snapshot.settings.memoryScope, 'project')
    assert.equal('memory' in upgraded.snapshot.settings, false)
    assert.equal(upgraded.snapshot.questions[0].extractedTurns, 1)
    const crossProject = structuredClone(v2)
    crossProject.snapshot.questions[0].conceptIds = ['c2']
    assert.throws(() => validateBackup(crossProject), /백업/)
  })
})

/** Every parent sits exactly one level above its child; topics have no parent. */
function assertHierarchy(concepts: Concept[]): void {
  const above = { topic: null, concept: 'topic', detail: 'concept' } as const
  const byId = new Map(concepts.map((c) => [c.id, c]))
  for (const c of concepts)
    if (c.parentId)
      assert.equal(byId.get(c.parentId)?.level, above[c.level], `${c.name} under ${c.parentId}`)
}

test('schema 4 migration maps domain to topic and repairs a topic→detail-shaped tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fask-migrate-levels-'))
  let store = new PersonalStore(dir)
  try {
    const profile = store.active
    const ws = store.list<Project>('project')[0].workspaceId
    const put = (id: string, level: string, parentId: string | null = null): void => {
      store.put('concept', profile, {
        id,
        workspaceId: ws,
        name: id,
        parentId,
        manual: false,
        aliases: [],
        definition: '',
        level
      })
    }
    put('수학', 'domain')
    put('확률분포', 'topic', '수학') // topic under topic, holding only details
    put('정규분포 표준화', 'detail', '확률분포')
    put('z-점수', 'detail', '확률분포')
    put('z-점수 표 읽기', 'detail', 'z-점수') // detail under detail
    put('선형대수', 'topic')
    put('특성방정식 풀이', 'detail', '선형대수') // detail leaf directly under a topic
    put('행렬 분해', 'topic', '선형대수') // its child is a concept, so it cannot drop a level
    put('LU 분해', 'concept', '행렬 분해')
    store.db.prepare('DELETE FROM schema_migrations WHERE version=4').run()
    store.close()
    store = new PersonalStore(dir)
    const concepts = store.list<Concept>('concept', profile)
    assert.deepEqual(
      Object.fromEntries(concepts.map((c) => [c.id, [c.level, c.parentId]])),
      {
        수학: ['topic', null],
        확률분포: ['concept', '수학'],
        '정규분포 표준화': ['detail', '확률분포'],
        'z-점수': ['detail', '확률분포'],
        'z-점수 표 읽기': ['detail', null],
        선형대수: ['topic', null],
        '특성방정식 풀이': ['concept', '선형대수'],
        '행렬 분해': ['topic', null],
        'LU 분해': ['concept', '행렬 분해']
      }
    )
    assertHierarchy(concepts)
    assert.ok(existsSync(join(dir, 'fask-pre-levels.sqlite')))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store rejects a parent or level that breaks topic > concept > detail', () => {
  withStore('levels', (store) => {
    const profile = store.active
    const ws = store.list<Project>('project')[0].workspaceId
    const topic = store.createConcept(profile, ws, { name: '확률', level: 'topic' })
    const concept = store.createConcept(profile, ws, {
      name: '정규분포',
      level: 'concept',
      parentId: topic
    })
    const detail = store.createConcept(profile, ws, {
      name: '표준화',
      level: 'detail',
      parentId: concept
    })
    assert.throws(
      () => store.createConcept(profile, ws, { name: '중심극한정리', level: 'detail', parentId: topic }),
      /바로 위 단계/
    )
    assert.throws(() => store.editConcept(detail, '표준화', topic), /바로 위 단계/)
    assert.throws(() => store.editConceptInfo(concept, { level: 'topic' }), /주제는 상위 개념을/)
    assert.throws(() => store.editConceptInfo(concept, { level: 'detail' }), /바로 위 단계/)
    assert.throws(() => store.editConceptInfo(topic, { level: 'concept' }), /하위 개념의 단계/)
    // Detach, change the level, attach: each step stays valid.
    store.editConcept(detail, '표준화', null)
    store.editConceptInfo(detail, { level: 'concept' })
    store.editConcept(detail, '표준화', topic)
    assertHierarchy(store.list<Concept>('concept'))

    // Merging into a topic: the source's details cannot sit under it, so they become roots.
    const other = store.createConcept(profile, ws, { name: '이항분포', level: 'concept', parentId: topic })
    const trial = store.createConcept(profile, ws, { name: '베르누이 시행', level: 'detail', parentId: other })
    const stats = store.createConcept(profile, ws, { name: '통계', level: 'topic' })
    store.mergeConcept(other, stats)
    assert.equal(store.record<Concept>('concept', trial).parentId, null)
    // Removing a concept: its children cannot jump two levels, so they become roots.
    const leaf = store.createConcept(profile, ws, { name: '정규화 상수', level: 'detail', parentId: concept })
    store.remove('concept', concept)
    assert.equal(store.record<Concept>('concept', leaf).parentId, null)
    assertHierarchy(store.list<Concept>('concept'))
  })
})

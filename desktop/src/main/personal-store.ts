import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Concept,
  ConceptLevel,
  LocalSettings,
  Profile,
  Project,
  Question,
  Relation,
  Snapshot,
  Turn,
  Workspace
} from '../preload/personal'
import { mergeLegacyQuestions, questionImages, type LegacyQuestion } from '../shared/questions'
import { t } from '../shared/i18n'
import {
  KnowledgeSearch,
  conceptText,
  normalizeName,
  questionText,
  type SearchHit,
  type SearchOptions
} from './knowledge-search'
import {
  CHILD_LEVEL,
  CONCEPT_LEVELS,
  PARENT_LEVEL,
  RELATION_TYPES,
  repairHierarchy,
  upgradeConcepts,
  type LegacyConcept
} from './personal-backup'

export const defaults: LocalSettings = {
  endpoint: 'http://127.0.0.1:8317/v1',
  hasKey: false,
  model: '',
  fastModel: '',
  deepModel: '',
  models: [],
  routing: 'recommend',
  refine: false,
  organize: true,
  memoryScope: 'project',
  memoryTokens: 1500,
  extractDelaySec: 120,
  organizeModel: '',
  retention: 'balanced',
  autoTitle: true,
  regions: []
}

export interface ConceptFields {
  name: string
  aliases?: string[]
  definition?: string
  level?: ConceptLevel
  parentId?: string | null
  manual?: boolean
}
export type NewRelation = Pick<
  Relation,
  'from' | 'to' | 'type' | 'questionId' | 'turnIds' | 'confidence' | 'approved'
>

const MAX_ALIASES = 20
const MAX_DEFINITION = 2000

/** Trimmed, unique (by normalized form) aliases that differ from the concept's own name. */
function cleanAliases(aliases: string[], name: string): string[] {
  const seen = new Set([normalizeName(name)])
  const out: string[] = []
  for (const alias of aliases) {
    const value = alias.trim().slice(0, 200)
    const key = normalizeName(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length === MAX_ALIASES) break
  }
  return out
}

/** Turn ids of `q` in chronological order, restricted to `ids`. */
function orderedTurns(q: Question, ids: Iterable<string>): string[] {
  const wanted = new Set(ids)
  return q.turns.map((t) => t.id).filter((id) => wanted.has(id))
}
/**
 * Ids of `turns` whose question (raw, refined or sent) or answer contains the concept's name or an
 * alias, case-insensitively; local only, used when no recorded turn positions exist.
 */
export function mentionTurns(turns: Turn[], c: Pick<Concept, 'name' | 'aliases'>): string[] {
  const names = [c.name, ...c.aliases].map((n) => n.trim().toLowerCase()).filter(Boolean)
  return turns
    .filter((t) => {
      const text = [t.raw, t.refined, t.sent, t.answer].join('\n').toLowerCase()
      return names.some((n) => text.includes(n))
    })
    .map((t) => t.id)
}

/** Where a concept sits (parent, level, the parent's level): the state tidy records as reviewed. */
export const placementKey = (c: Concept, parent: Pick<Concept, 'level'> | undefined): string =>
  `${c.parentId ?? ''}|${c.level}|${parent?.level ?? ''}`

/** A review recorded for another parent or level no longer applies, so a moved concept drops it. */
function freshReview(c: Concept): Concept {
  if (c.tidyReviewed === undefined || c.tidyReviewed.startsWith(`${c.parentId ?? ''}|${c.level}|`)) return c
  const next = { ...c }
  delete next.tidyReviewed
  return next
}

export class PersonalStore {
  readonly db: DatabaseSync
  private readonly index: KnowledgeSearch
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, 'fask.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_scope ON records(profile,kind);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, question_id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');`)
    this.index = new KnowledgeSearch(this.db)
    this.index.create()
    this.migrateTurns()
    this.migrateKnowledge()
    this.migrateLevels()
    this.migrateHierarchyRelations()
    if (!this.list<Profile>('profile', '*').length) {
      const id = this.put('profile', '*', { id: randomUUID(), name: '기본 프로필' })
      this.pref('active', id)
      const workspace = this.create('workspace', '내 워크스페이스')
      this.create('project', '첫 프로젝트', workspace)
    }
    for (const row of this.db
      .prepare("SELECT id,data,profile FROM records WHERE kind='question'")
      .all()) {
      const q = JSON.parse(String(row.data)) as Question
      if (q.turns.some((t) => t.status === 'running'))
        this.put('question', String(row.profile), {
          ...q,
          turns: q.turns.map((t) =>
            t.status === 'running'
              ? {
                  ...t,
                  status: 'failed',
                  error: '앱이 종료되어 요청이 중단되었습니다.',
                  revision: t.revision + 1
                }
              : t
          )
        })
    }
    this.db.exec(
      "UPDATE runs SET status='failed',error='앱 재시작으로 중단' WHERE status='running'"
    )
  }
  /** Copies the database before a data-changing upgrade; VACUUM cannot run inside a transaction. */
  private backupBefore(file: string): void {
    const path = join(this.root, file)
    if (existsSync(path)) return
    try {
      this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
    } catch (e) {
      this.db.close()
      throw new Error(
        t('업그레이드 전 백업을 만들 수 없습니다: {{error}}', {
          error: e instanceof Error ? e.message : String(e)
        })
      )
    }
  }
  /** Schema 2: one question record holds every follow-up turn; runs reference turns. */
  private migrateTurns(): void {
    if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) return
    const legacy = this.db
      .prepare(
        "SELECT 1 FROM records WHERE kind='question' AND json_type(data,'$.turns') IS NULL LIMIT 1"
      )
      .get()
    if (legacy) this.backupBefore('fask-pre-1.1.0.sqlite')
    this.db.exec('BEGIN')
    try {
      this.db.exec(`ALTER TABLE runs ADD COLUMN turn_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
        UPDATE runs SET turn_id=question_id WHERE turn_id='';`)
      const profiles = this.db
        .prepare("SELECT DISTINCT profile FROM records WHERE kind='question'")
        .all()
        .map((r) => String(r.profile))
      for (const profile of profiles) {
        const records = this.db
          .prepare(
            "SELECT data FROM records WHERE kind='question' AND profile=? AND json_type(data,'$.turns') IS NULL ORDER BY rowid"
          )
          .all(profile)
          .map((r) => JSON.parse(String(r.data)) as LegacyQuestion)
        for (const question of mergeLegacyQuestions(records)) {
          this.put('question', profile, question)
          for (const turn of question.turns.slice(1)) {
            this.db.prepare('DELETE FROM records WHERE id=?').run(turn.id)
            this.db
              .prepare('UPDATE runs SET question_id=? WHERE question_id=?')
              .run(question.id, turn.id)
          }
        }
      }
      this.db.exec('INSERT INTO schema_migrations VALUES(2); COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      this.db.close()
      throw e
    }
  }
  /**
   * Schema 3: concepts move from projects to workspaces (exact-name duplicates merge), questions get
   * conceptTurns/extractedTurns, `memory` becomes `memoryScope`, and the search index is rebuilt.
   */
  private migrateKnowledge(): void {
    if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()) return
    if (this.db.prepare("SELECT 1 FROM records WHERE kind='concept' LIMIT 1").get())
      this.backupBefore('fask-pre-kg.sqlite')
    this.db.exec('BEGIN')
    try {
      const profiles = this.db
        .prepare("SELECT DISTINCT profile FROM records WHERE profile<>'*'")
        .all()
        .map((r) => String(r.profile))
      for (const profile of profiles) {
        const legacy = this.list<LegacyConcept>('concept', profile)
        const upgraded = upgradeConcepts(
          this.list<Project>('project', profile),
          legacy,
          this.list<Question>('question', profile)
        )
        const kept = new Set(upgraded.concepts.map((c) => c.id))
        for (const c of legacy) if (!kept.has(c.id)) this.drop(c.id, profile)
        for (const c of upgraded.concepts) this.put('concept', profile, c)
        for (const q of upgraded.questions) this.put('question', profile, q)
      }
      for (const row of this.db
        .prepare("SELECT key,value FROM preferences WHERE key LIKE 'settings:%'")
        .all()) {
        const { memory, ...settings } = JSON.parse(String(row.value)) as { memory?: unknown }
        if (memory === undefined) continue
        this.pref(
          String(row.key),
          JSON.stringify({ ...settings, memoryScope: memory === false ? 'off' : 'project' })
        )
      }
      this.index.clear()
      for (const row of this.db
        .prepare("SELECT rowid,kind,profile,data FROM records WHERE kind IN ('concept','question')")
        .all())
        this.indexRecord(
          String(row.kind),
          String(row.profile),
          Number(row.rowid),
          JSON.parse(String(row.data))
        )
      this.db.exec('INSERT INTO schema_migrations VALUES(3); COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      this.db.close()
      throw e
    }
  }
  /** Schema 4: exactly three levels; 'domain' becomes 'topic' and broken parent links are repaired. */
  private migrateLevels(): void {
    if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=4').get()) return
    const profiles = this.db
      .prepare("SELECT DISTINCT profile FROM records WHERE kind='concept'")
      .all()
      .map((r) => String(r.profile))
    const repaired = profiles.map((profile) => ({
      profile,
      concepts: repairHierarchy(this.list<Concept>('concept', profile))
    }))
    if (repaired.some((r) => r.concepts.length)) this.backupBefore('fask-pre-levels.sqlite')
    this.db.exec('BEGIN')
    try {
      for (const { profile, concepts } of repaired)
        for (const c of concepts) this.put('concept', profile, c)
      this.db.exec('INSERT INTO schema_migrations VALUES(4); COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      this.db.close()
      throw e
    }
  }
  /**
   * Schema 5: a relation between a concept and its direct parent repeats the hierarchy (broader),
   * so active ones are invalidated; extraction and tidy no longer add them.
   */
  private migrateHierarchyRelations(): void {
    if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=5').get()) return
    const profiles = this.db
      .prepare("SELECT DISTINCT profile FROM records WHERE kind='relation'")
      .all()
      .map((r) => String(r.profile))
    const now = new Date().toISOString()
    const stale = profiles.map((profile) => {
      const parent = new Map(this.list<Concept>('concept', profile).map((c) => [c.id, c.parentId]))
      return {
        profile,
        relations: this.list<Relation>('relation', profile).filter(
          (r) => !r.invalidatedAt && (parent.get(r.from) === r.to || parent.get(r.to) === r.from)
        )
      }
    })
    if (stale.some((s) => s.relations.length)) this.backupBefore('fask-pre-relations.sqlite')
    this.db.exec('BEGIN')
    try {
      for (const { profile, relations } of stale)
        for (const r of relations) this.put('relation', profile, { ...r, invalidatedAt: now })
      this.db.exec('INSERT INTO schema_migrations VALUES(5); COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      this.db.close()
      throw e
    }
  }
  findRun(
    requestId: string
  ): { questionId: string; turnId: string; profile: string; requestHash: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT r.question_id, r.turn_id, r.request_hash, q.profile FROM runs r JOIN records q ON q.id = r.question_id WHERE r.id=?'
      )
      .get(requestId)
    return row
      ? {
          questionId: String(row.question_id),
          turnId: String(row.turn_id),
          profile: String(row.profile),
          requestHash: String(row.request_hash)
        }
      : undefined
  }
  /** Saves the question/turn and its run row in one transaction; replays identical requests. */
  recordAsk(p: {
    requestId: string
    requestHash: string
    profile: string
    projectId: string
    questionId?: string
    turn: Turn
    saveOnly: boolean
  }): { questionId: string; turnId: string; replay: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.findRun(p.requestId)
      if (run) {
        if (run.profile !== p.profile) throw new Error('이미 처리한 요청입니다.')
        if (run.requestHash !== p.requestHash)
          throw new Error('같은 요청 ID로 다른 내용을 보낼 수 없습니다.')
        this.db.exec('COMMIT')
        return { questionId: run.questionId, turnId: run.turnId, replay: true }
      }
      let question: Question
      if (p.questionId) {
        const row = this.db
          .prepare("SELECT data FROM records WHERE kind='question' AND id=? AND profile=?")
          .get(p.questionId, p.profile)
        const existing = row ? (JSON.parse(String(row.data)) as Question) : undefined
        if (!existing || existing.projectId !== p.projectId)
          throw new Error('대화를 찾을 수 없습니다.')
        if (existing.turns.some((t) => t.status === 'running'))
          throw new Error('이 질문의 이전 답변이 끝난 뒤 이어서 질문해 주세요.')
        question = { ...existing, turns: [...existing.turns, p.turn] }
      } else
        question = {
          id: randomUUID(),
          projectId: p.projectId,
          createdAt: p.turn.createdAt,
          turns: [p.turn],
          conceptIds: [],
          conceptTurns: {},
          extractedTurns: 0,
          suggestions: [],
          memo: '',
          important: false
        }
      this.put('question', p.profile, question)
      this.db
        .prepare(
          'INSERT INTO runs(id,question_id,turn_id,request_hash,created_at,status,model) VALUES(?,?,?,?,?,?,?)'
        )
        .run(
          p.requestId,
          question.id,
          p.turn.id,
          p.requestHash,
          p.turn.createdAt,
          p.saveOnly ? 'saved' : 'running',
          p.turn.model
        )
      this.db.exec('COMMIT')
      return { questionId: question.id, turnId: p.turn.id, replay: false }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  /** Read-modify-write of one turn; callers changing answer/status pass `revision` explicitly. */
  updateTurn(
    questionId: string,
    turnId: string,
    patch: Partial<Turn>,
    profile = this.active
  ): Question {
    const q = this.record<Question>('question', questionId, profile)
    if (!q.turns.some((t) => t.id === turnId)) throw new Error('대화 항목을 찾을 수 없습니다.')
    const next = { ...q, turns: q.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t)) }
    this.put('question', profile, next)
    return next
  }
  isImageReferenced(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM records, json_each(records.data, '$.turns') AS t WHERE records.kind='question' AND json_extract(t.value, '$.attachment') = ? LIMIT 1"
      )
      .get(id)
  }
  pref(key: string, value?: string): string {
    if (value !== undefined)
      this.db.prepare('INSERT OR REPLACE INTO preferences VALUES(?,?)').run(key, value)
    return String(
      this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key)?.value ?? ''
    )
  }
  get active(): string {
    return this.pref('active')
  }
  list<T>(kind: string, profile = this.active): T[] {
    return this.db
      .prepare('SELECT data FROM records WHERE kind=? AND profile=? ORDER BY rowid')
      .all(kind, profile)
      .map((r) => JSON.parse(String(r.data)))
  }
  /**
   * Upserts a record; concepts and questions are kept in the search index in the same statement
   * batch. A concept written at another placement than its tidy review loses the review.
   */
  put<T extends { id: string }>(kind: string, profile: string, value: T): string {
    const data = kind === 'concept' ? freshReview(value as unknown as Concept) : value
    const row = this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data RETURNING rowid'
      )
      .get(value.id, kind, profile, JSON.stringify(data))
    this.indexRecord(kind, profile, Number(row?.rowid), data)
    return value.id
  }
  /** Drops a deleted or merged-away concept from the others' reviewed tidy pairs. */
  private forgetPairs(id: string, profile: string): void {
    for (const c of this.list<Concept>('concept', profile)) {
      if (!c.tidyPairs?.includes(id)) continue
      const next: Concept = { ...c, tidyPairs: c.tidyPairs.filter((p) => p !== id) }
      if (!next.tidyPairs?.length) delete next.tidyPairs
      this.put('concept', profile, next)
    }
  }
  private indexRecord(kind: string, profile: string, rowid: number, value: unknown): void {
    if (kind === 'concept') {
      const c = value as Concept
      this.index.upsert({
        rowid,
        id: c.id,
        kind,
        profile,
        workspace: c.workspaceId ?? '',
        project: '',
        text: conceptText(c)
      })
    } else if (kind === 'question') {
      const q = value as Question
      const project = this.db
        .prepare(
          "SELECT json_extract(data,'$.workspaceId') AS w FROM records WHERE kind='project' AND id=?"
        )
        .get(q.projectId)
      this.index.upsert({
        rowid,
        id: q.id,
        kind,
        profile,
        workspace: String(project?.w ?? ''),
        project: q.projectId,
        text: questionText(q)
      })
    }
  }
  /** Deletes one record and its search entry. */
  private drop(id: string, profile: string): void {
    const row = this.db.prepare('SELECT rowid FROM records WHERE id=? AND profile=?').get(id, profile)
    if (!row) return
    this.index.remove(Number(row.rowid))
    this.db.prepare('DELETE FROM records WHERE rowid=?').run(row.rowid)
  }
  record<T>(kind: string, id: string, profile = this.active): T {
    const row = this.db
      .prepare('SELECT data FROM records WHERE kind=? AND id=? AND profile=?')
      .get(kind, id, profile)
    if (!row) throw new Error('현재 프로필에서 항목을 찾을 수 없습니다.')
    return JSON.parse(String(row.data))
  }
  search(profile: string, text: string, options: SearchOptions): SearchHit[] {
    return this.index.search(profile, text, options)
  }
  workspaceOf(projectId: string, profile = this.active): string {
    return this.record<Project>('project', projectId, profile).workspaceId
  }
  /** The workspace concept whose name or alias equals one of `names` (normalized), if any. */
  private matchConcept(
    profile: string,
    workspaceId: string,
    names: string[],
    exceptId?: string
  ): Concept | undefined {
    const keys = new Set(names.map(normalizeName).filter(Boolean))
    if (!keys.size) return undefined
    return this.list<Concept>('concept', profile).find(
      (c) =>
        c.workspaceId === workspaceId &&
        c.id !== exceptId &&
        [c.name, ...c.aliases].some((n) => keys.has(normalizeName(n)))
    )
  }
  findConceptByName(profile: string, workspaceId: string, name: string): Concept | undefined {
    return this.matchConcept(profile, workspaceId, [name])
  }
  private assertNamesFree(c: Concept, names: string[], profile: string): void {
    if (this.matchConcept(profile, c.workspaceId, names, c.id))
      throw new Error('같은 이름이나 동의어의 개념이 이미 있습니다. 병합해 주세요.')
  }
  /** Rejects a parent or level that breaks topic > concept > detail (a parent is exactly one level up). */
  private assertLevels(c: Concept, profile: string): void {
    if (c.parentId) {
      const need = PARENT_LEVEL[c.level]
      if (!need) throw new Error('주제는 상위 개념을 가질 수 없습니다.')
      if (this.record<Concept>('concept', c.parentId, profile).level !== need)
        throw new Error('상위 개념은 바로 위 단계여야 합니다(주제 > 개념 > 세부).')
    }
    if (
      this.list<Concept>('concept', profile).some(
        (k) => k.parentId === c.id && k.level !== CHILD_LEVEL[c.level]
      )
    )
      throw new Error('하위 개념의 단계와 맞지 않습니다. 하위 개념을 먼저 옮겨 주세요.')
  }
  settings(profile = this.active): LocalSettings {
    const value = this.pref(`settings:${profile}`)
    return {
      ...defaults,
      ...(value ? JSON.parse(value) : {}),
      hasKey: !!this.pref(`key:${profile}`)
    }
  }
  saveSettings(settings: LocalSettings): void {
    this.pref(`settings:${this.active}`, JSON.stringify(settings))
  }
  create(kind: string, name: string, parentId?: string): string {
    name = name.trim().slice(0, 200)
    if (!name) throw new Error('이름을 입력해 주세요.')
    const id = randomUUID()
    if (kind === 'profile') return this.put(kind, '*', { id, name } as Profile)
    if (kind === 'workspace')
      return this.put(kind, this.active, { id, name, profileId: this.active } as Workspace)
    if (kind === 'project') {
      this.record('workspace', parentId ?? '')
      return this.put(kind, this.active, {
        id,
        name,
        workspaceId: parentId,
        description: ''
      } as Project)
    }
    if (kind === 'concept')
      return this.createConcept(this.active, this.workspaceOf(parentId ?? ''), {
        name,
        manual: true
      })
    throw new Error('지원하지 않는 항목입니다.')
  }
  /**
   * Creates a workspace concept. An exact name/alias match returns the existing concept instead,
   * after adding the new names as aliases and filling an empty definition.
   */
  createConcept(profile: string, workspaceId: string, fields: ConceptFields): string {
    this.record<Workspace>('workspace', workspaceId, profile)
    const name = fields.name.trim().slice(0, 200)
    if (!name) throw new Error('개념 이름을 입력해 주세요.')
    const aliases = cleanAliases(fields.aliases ?? [], name)
    const definition = (fields.definition ?? '').trim().slice(0, MAX_DEFINITION)
    const existing = this.matchConcept(profile, workspaceId, [name, ...aliases])
    if (existing) {
      const merged = cleanAliases([...existing.aliases, name, ...aliases], existing.name)
      const next = {
        ...existing,
        aliases: merged.filter((a) => !this.matchConcept(profile, workspaceId, [a], existing.id)),
        definition: existing.definition || definition
      }
      if (
        next.aliases.length !== existing.aliases.length ||
        next.definition !== existing.definition
      )
        this.put('concept', profile, next)
      return existing.id
    }
    const parentId = fields.parentId ?? null
    if (parentId && this.record<Concept>('concept', parentId, profile).workspaceId !== workspaceId)
      throw new Error('다른 워크스페이스의 개념입니다.')
    const concept: Concept = {
      id: randomUUID(),
      workspaceId,
      name,
      parentId,
      manual: fields.manual ?? false,
      aliases,
      definition,
      level: fields.level && CONCEPT_LEVELS.includes(fields.level) ? fields.level : 'concept'
    }
    this.assertLevels(concept, profile)
    return this.put<Concept>('concept', profile, concept)
  }
  /**
   * Adds a relation between two concepts of one workspace. The same active from/to/type is updated
   * (approval and confidence only rise); one the user removed is never revived.
   */
  addRelation(profile: string, rel: NewRelation): string {
    const from = this.record<Concept>('concept', rel.from, profile)
    const to = this.record<Concept>('concept', rel.to, profile)
    if (rel.from === rel.to || from.workspaceId !== to.workspaceId)
      throw new Error('같은 워크스페이스의 서로 다른 개념을 연결해 주세요.')
    if (!RELATION_TYPES.includes(rel.type)) throw new Error('지원하지 않는 관계입니다.')
    const confidence = Number.isFinite(rel.confidence)
      ? Math.min(1, Math.max(0, rel.confidence))
      : 0
    const same = this.list<Relation>('relation', profile).filter(
      (r) => r.from === rel.from && r.to === rel.to && r.type === rel.type
    )
    const existing = same.find((r) => !r.invalidatedAt) ?? same[0]
    if (existing) {
      if (
        !existing.invalidatedAt &&
        ((rel.approved && !existing.approved) || confidence > existing.confidence)
      )
        this.put('relation', profile, {
          ...existing,
          approved: existing.approved || !!rel.approved,
          confidence: Math.max(existing.confidence, confidence)
        })
      return existing.id
    }
    const source = rel.questionId
      ? this.record<Question>('question', rel.questionId, profile)
      : undefined
    return this.put<Relation>('relation', profile, {
      id: randomUUID(),
      workspaceId: from.workspaceId,
      from: rel.from,
      to: rel.to,
      type: rel.type,
      questionId: source?.id ?? null,
      turnIds: source ? orderedTurns(source, rel.turnIds) : [],
      confidence,
      approved: !!rel.approved,
      createdAt: new Date().toISOString(),
      invalidatedAt: null
    })
  }
  setRelation(id: string, action: 'approve' | 'remove', profile = this.active): void {
    const r = this.record<Relation>('relation', id, profile)
    if (action === 'approve') this.put('relation', profile, { ...r, approved: true })
    else if (action === 'remove') {
      if (!r.invalidatedAt)
        this.put('relation', profile, { ...r, invalidatedAt: new Date().toISOString() })
    } else throw new Error('지원하지 않는 요청입니다.')
  }
  editConceptInfo(
    id: string,
    info: Partial<Pick<Concept, 'aliases' | 'definition' | 'level'>>,
    profile = this.active
  ): void {
    const c = this.record<Concept>('concept', id, profile)
    const next = { ...c, manual: true }
    if (info.aliases !== undefined) {
      if (!Array.isArray(info.aliases) || info.aliases.some((a) => typeof a !== 'string'))
        throw new Error('동의어 형식이 잘못되었습니다.')
      next.aliases = cleanAliases(info.aliases, c.name)
      this.assertNamesFree(c, next.aliases, profile)
    }
    if (info.definition !== undefined) {
      if (typeof info.definition !== 'string') throw new Error('정의 형식이 잘못되었습니다.')
      next.definition = info.definition.trim().slice(0, MAX_DEFINITION)
    }
    if (info.level !== undefined) {
      if (!CONCEPT_LEVELS.includes(info.level)) throw new Error('지원하지 않는 개념 단계입니다.')
      next.level = info.level
      this.assertLevels(next, profile)
    }
    this.put('concept', profile, next)
  }
  switchProfile(id: string): void {
    this.record('profile', id, '*')
    this.pref('active', id)
    if (!this.list('workspace').length) {
      const workspace = this.create('workspace', '내 워크스페이스')
      this.create('project', '첫 프로젝트', workspace)
    }
  }
  rename(kind: string, id: string, name: string): void {
    if (
      !['profile', 'workspace', 'project', 'concept', 'question'].includes(kind) ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 200
    )
      throw new Error('이름은 1~200자로 입력해 주세요.')
    const profile = kind === 'profile' ? '*' : this.active
    const record = this.record<{ id: string }>(kind, id, profile)
    if (kind === 'concept') return this.editConcept(id, name, (record as Concept).parentId)
    this.put(kind, profile, {
      ...record,
      ...(kind === 'question' ? { title: name.trim() } : { name: name.trim() })
    })
  }
  remove(kind: string, id: string): void {
    if (!['profile', 'workspace', 'project', 'concept', 'question'].includes(kind))
      throw new Error('지원하지 않는 항목입니다.')
    const profile = kind === 'profile' ? id : this.active
    this.record(kind, id, kind === 'profile' ? '*' : profile)
    const projects = new Set(
      this.list<Project>('project', profile)
        .filter(
          (p) =>
            kind === 'profile' ||
            (kind === 'workspace' && p.workspaceId === id) ||
            (kind === 'project' && p.id === id)
        )
        .map((p) => p.id)
    )
    const questions = this.list<Question>('question', profile).filter(
      (q) => projects.has(q.projectId) || (kind === 'question' && q.id === id)
    )
    const removedQuestions = new Set(questions.map((q) => q.id))
    const images = new Set(questions.flatMap(questionImages))
    this.db.exec('BEGIN')
    try {
      for (const q of questions) {
        this.db.prepare('DELETE FROM runs WHERE question_id=?').run(q.id)
        this.drop(q.id, profile)
      }
      if (kind === 'concept') {
        for (const q of this.list<Question>('question', profile))
          if (q.conceptIds.includes(id)) {
            const conceptTurns = { ...q.conceptTurns }
            delete conceptTurns[id]
            this.put('question', profile, {
              ...q,
              conceptIds: q.conceptIds.filter((c) => c !== id),
              conceptTurns
            })
          }
        // The grandparent is two levels up, so children become roots (tidy candidates).
        for (const child of this.list<Concept>('concept', profile))
          if (child.parentId === id) this.put('concept', profile, { ...child, parentId: null })
        this.forgetPairs(id, profile)
      }
      for (const r of this.list<Relation>('relation', profile))
        if (
          r.from === id ||
          r.to === id ||
          (kind === 'workspace' && r.workspaceId === id)
        )
          this.drop(r.id, profile)
        else if (r.questionId && removedQuestions.has(r.questionId))
          // Provenance is gone; the relation itself stays.
          this.put('relation', profile, { ...r, questionId: null, turnIds: [] })
      if (kind === 'workspace')
        for (const c of this.list<Concept>('concept', profile))
          if (c.workspaceId === id) this.drop(c.id, profile)
      for (const project of projects) this.drop(project, profile)
      this.drop(id, kind === 'profile' ? '*' : profile)
      if (kind === 'profile') {
        this.db.prepare('DELETE FROM records WHERE profile=?').run(profile)
        this.index.removeProfile(profile)
        for (const key of [`settings:${profile}`, `key:${profile}`])
          this.db.prepare('DELETE FROM preferences WHERE key=?').run(key)
        if (this.active === profile) {
          const next =
            this.list<Profile>('profile', '*')[0]?.id ?? this.create('profile', '기본 프로필')
          this.switchProfile(next)
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    for (const image of images) if (!this.isImageReferenced(image)) this.deleteImage(image)
  }
  snapshot(): Snapshot {
    const questions = this.list<Question>('question').sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    const paths = new Set(questions.flatMap(questionImages))
    let storageBytes = 0
    for (const path of paths)
      for (const file of [this.imagePath(path), this.displayPath(path)])
        if (existsSync(file)) storageBytes += statSync(file).size
    return {
      profiles: this.list('profile', '*'),
      activeProfileId: this.active,
      workspaces: this.list('workspace'),
      projects: this.list('project'),
      concepts: this.list('concept'),
      relations: this.list('relation'),
      questions,
      settings: this.settings(),
      storageBytes
    }
  }
  imagePath(id: string): string {
    if (!/^[a-f0-9]{64}\.(png|jpg)$/.test(id)) throw new Error('잘못된 이미지 ID입니다.')
    return join(this.root, 'attachments', id)
  }
  saveImage(data: string): string {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(data)
    if (!match || data.length > 36_000_000)
      throw new Error('캡처 이미지 형식 또는 크기를 확인해 주세요.')
    const bytes = Buffer.from(match[2], 'base64')
    const id = `${createHash('sha256').update(bytes).digest('hex')}.${match[1] === 'png' ? 'png' : 'jpg'}`
    mkdirSync(join(this.root, 'attachments'), { recursive: true })
    if (!existsSync(this.imagePath(id))) {
      writeFileSync(`${this.imagePath(id)}.tmp`, bytes)
      renameSync(`${this.imagePath(id)}.tmp`, this.imagePath(id))
    }
    return id
  }
  image(id: string): string | null {
    if (!existsSync(this.imagePath(id))) return null
    return `data:image/${id.endsWith('png') ? 'png' : 'jpeg'};base64,${readFileSync(this.imagePath(id)).toString('base64')}`
  }
  // Smaller WebP copy for viewing; generated in the background, so the original may be served until then.
  displayPath(id: string): string {
    return `${this.imagePath(id)}.webp`
  }
  displayImage(id: string): string | null {
    const display = this.displayPath(id)
    if (!existsSync(display) || !existsSync(this.imagePath(id))) return this.image(id)
    return `data:image/webp;base64,${readFileSync(display).toString('base64')}`
  }
  deleteImage(id: string): void {
    for (const file of [this.imagePath(id), this.displayPath(id)])
      if (existsSync(file)) unlinkSync(file)
  }
  removeAttachment(questionId: string, turnId: string): void {
    const turn = this.record<Question>('question', questionId).turns.find((t) => t.id === turnId)
    if (!turn) throw new Error('대화 항목을 찾을 수 없습니다.')
    this.updateTurn(questionId, turnId, { attachment: null })
    const id = turn.attachment
    if (id && !this.isImageReferenced(id)) this.deleteImage(id)
  }
  updateQuestion(id: string, patch: Partial<Question>): void {
    const q = this.record<Question>('question', id)
    const safe: Partial<Question> = {}
    if (typeof patch.memo === 'string') safe.memo = patch.memo.slice(0, 50000)
    if (typeof patch.important === 'boolean') safe.important = patch.important
    if (Array.isArray(patch.conceptIds)) {
      safe.conceptIds = [...new Set(patch.conceptIds)]
      const workspaceId = this.workspaceOf(q.projectId)
      for (const cid of safe.conceptIds)
        if (this.record<Concept>('concept', cid).workspaceId !== workspaceId)
          throw new Error('워크스페이스가 다른 개념입니다.')
    }
    const conceptIds = safe.conceptIds ?? q.conceptIds
    const conceptTurns: Record<string, string[]> = {}
    if (patch.conceptTurns !== undefined) {
      const value = patch.conceptTurns
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('개념 위치 형식이 잘못되었습니다.')
      for (const [cid, turns] of Object.entries(value)) {
        if (!conceptIds.includes(cid) || !Array.isArray(turns))
          throw new Error('개념 위치 형식이 잘못되었습니다.')
        const ordered = orderedTurns(q, turns)
        if (ordered.length) conceptTurns[cid] = ordered
      }
    } else
      for (const [cid, turns] of Object.entries(q.conceptTurns))
        if (conceptIds.includes(cid)) conceptTurns[cid] = turns
    if (patch.conceptTurns !== undefined || safe.conceptIds) {
      // A newly linked concept without given positions gets the turns that mention it, if any.
      for (const cid of conceptIds)
        if (!q.conceptIds.includes(cid) && patch.conceptTurns?.[cid] === undefined) {
          const found = mentionTurns(q.turns, this.record<Concept>('concept', cid))
          if (found.length) conceptTurns[cid] = found
        }
      safe.conceptTurns = conceptTurns
    }
    if (Array.isArray(patch.suggestions))
      safe.suggestions = patch.suggestions.filter((s) => typeof s === 'string').slice(0, 10)
    this.put('question', this.active, { ...q, ...safe })
  }
  /**
   * Within a workspace a question keeps its concept links. Across workspaces they are cleared and
   * the question becomes unextracted, so the target workspace's map picks it up.
   */
  moveQuestion(id: string, projectId: string): void {
    const q = this.record<Question>('question', id)
    const target = this.record<Project>('project', projectId)
    if (q.projectId === projectId) return
    this.put(
      'question',
      this.active,
      this.workspaceOf(q.projectId) === target.workspaceId
        ? { ...q, projectId }
        : {
            ...q,
            projectId,
            conceptIds: [],
            conceptTurns: {},
            suggestions: [],
            extractedTurns: 0
          }
    )
  }
  editConcept(id: string, name: string, parentId: string | null): void {
    const c = this.record<Concept>('concept', id)
    if (!name.trim()) throw new Error('개념 이름을 입력해 주세요.')
    let next = parentId
    const seen = new Set([id])
    while (next) {
      if (seen.has(next)) throw new Error('하위 개념으로 이동할 수 없습니다.')
      seen.add(next)
      const parent = this.record<Concept>('concept', next)
      if (parent.workspaceId !== c.workspaceId)
        throw new Error('다른 워크스페이스로 이동할 수 없습니다.')
      next = parent.parentId
    }
    const trimmed = name.trim().slice(0, 200)
    this.assertNamesFree(c, [trimmed], this.active)
    const edited: Concept = {
      ...c,
      name: trimmed,
      aliases: cleanAliases(c.aliases, trimmed),
      parentId,
      manual: true
    }
    this.assertLevels(edited, this.active)
    this.put('concept', this.active, edited)
  }
  /**
   * Folds `source` into `target`: links, turn positions, children, relations and names move over.
   * The target keeps its own level and parent; a child of `source` moves under the target only when
   * it is exactly one level below the target, otherwise it becomes a root (a tidy candidate).
   */
  mergeConcept(source: string, target: string): void {
    const a = this.record<Concept>('concept', source),
      b = this.record<Concept>('concept', target)
    if (source === target || a.workspaceId !== b.workspaceId)
      throw new Error('같은 워크스페이스의 다른 개념을 선택해 주세요.')
    // Reject merging into a descendant; the tree must remain acyclic.
    let parent: Concept | undefined = b
    while (parent) {
      if (parent.id === source) throw new Error('하위 개념으로 병합할 수 없습니다.')
      parent = parent.parentId ? this.record<Concept>('concept', parent.parentId) : undefined
    }
    const profile = this.active
    const swap = (id: string): string => (id === source ? target : id)
    this.db.exec('BEGIN')
    try {
      for (const q of this.list<Question>('question', profile))
        if (q.conceptIds.includes(source)) {
          const conceptTurns = { ...q.conceptTurns }
          delete conceptTurns[source]
          // Only recorded positions carry over; a link without any stays without an entry.
          const turns = orderedTurns(q, [...(q.conceptTurns[source] ?? []), ...(q.conceptTurns[target] ?? [])])
          if (turns.length) conceptTurns[target] = turns
          else delete conceptTurns[target]
          this.put('question', profile, {
            ...q,
            conceptIds: [...new Set(q.conceptIds.map(swap))],
            conceptTurns
          })
        }
      for (const c of this.list<Concept>('concept', profile))
        if (c.parentId === source)
          this.put('concept', profile, {
            ...c,
            parentId: c.level === CHILD_LEVEL[b.level] ? target : null
          })
      const relations = this.list<Relation>('relation', profile)
      for (const r of relations) {
        if (r.from !== source && r.to !== source) continue
        const moved = { ...r, from: swap(r.from), to: swap(r.to) }
        const twin = relations.find(
          (o) =>
            o.id !== r.id &&
            o.from === moved.from &&
            o.to === moved.to &&
            o.type === moved.type &&
            !o.invalidatedAt === !moved.invalidatedAt
        )
        if (moved.from === moved.to) this.drop(r.id, profile)
        else if (twin) {
          this.drop(r.id, profile)
          const fresh = this.record<Relation>('relation', twin.id, profile)
          this.put('relation', profile, {
            ...fresh,
            approved: fresh.approved || r.approved,
            confidence: Math.max(fresh.confidence, r.confidence)
          })
        } else this.put('relation', profile, moved)
      }
      this.put('concept', profile, {
        ...b,
        aliases: cleanAliases([...b.aliases, a.name, ...a.aliases], b.name),
        definition: b.definition || a.definition
      })
      this.drop(source, profile)
      this.forgetPairs(source, profile)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  close(): void {
    this.db.close()
  }
}

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
  LocalSettings,
  Profile,
  Project,
  Question,
  Snapshot,
  Turn,
  Workspace
} from '../preload/personal'
import { mergeLegacyQuestions, questionImages, type LegacyQuestion } from '../shared/questions'
import { t } from '../shared/i18n'

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
  memory: true,
  retention: 'balanced',
  autoTitle: true,
  regions: []
}
export class PersonalStore {
  readonly db: DatabaseSync
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
    this.migrateTurns()
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
  /** Schema 2: one question record holds every follow-up turn; runs reference turns. */
  private migrateTurns(): void {
    if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) return
    const legacy = this.db
      .prepare(
        "SELECT 1 FROM records WHERE kind='question' AND json_type(data,'$.turns') IS NULL LIMIT 1"
      )
      .get()
    const backupPath = join(this.root, 'fask-pre-1.1.0.sqlite')
    if (legacy && !existsSync(backupPath)) {
      try {
        // VACUUM cannot run inside a transaction, so the copy is taken before BEGIN.
        this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      } catch (e) {
        this.db.close()
        throw new Error(
          t('업그레이드 전 백업을 만들 수 없습니다: {{error}}', {
            error: e instanceof Error ? e.message : String(e)
          })
        )
      }
    }
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
  put<T extends { id: string }>(kind: string, profile: string, value: T): string {
    this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(value.id, kind, profile, JSON.stringify(value))
    return value.id
  }
  record<T>(kind: string, id: string, profile = this.active): T {
    const row = this.db
      .prepare('SELECT data FROM records WHERE kind=? AND id=? AND profile=?')
      .get(kind, id, profile)
    if (!row) throw new Error('현재 프로필에서 항목을 찾을 수 없습니다.')
    return JSON.parse(String(row.data))
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
    if (kind === 'concept') {
      this.record('project', parentId ?? '')
      return this.put(kind, this.active, {
        id,
        name,
        projectId: parentId,
        parentId: null,
        manual: true
      } as Concept)
    }
    throw new Error('지원하지 않는 항목입니다.')
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
    const images = new Set(questions.flatMap(questionImages))
    this.db.exec('BEGIN')
    try {
      const del = this.db.prepare('DELETE FROM records WHERE id=? AND profile=?')
      for (const q of questions) {
        this.db.prepare('DELETE FROM runs WHERE question_id=?').run(q.id)
        del.run(q.id, profile)
      }
      if (kind === 'concept') {
        const concept = this.record<Concept>('concept', id, profile)
        for (const q of this.list<Question>('question', profile))
          if (q.conceptIds.includes(id))
            this.put('question', profile, {
              ...q,
              conceptIds: q.conceptIds.filter((c) => c !== id)
            })
        for (const child of this.list<Concept>('concept', profile))
          if (child.parentId === id)
            this.put('concept', profile, { ...child, parentId: concept.parentId })
      }
      for (const c of this.list<Concept>('concept', profile))
        if (projects.has(c.projectId)) del.run(c.id, profile)
      for (const project of projects) del.run(project, profile)
      del.run(id, kind === 'profile' ? '*' : profile)
      if (kind === 'profile') {
        this.db.prepare('DELETE FROM records WHERE profile=?').run(profile)
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
      for (const cid of safe.conceptIds)
        if (this.record<Concept>('concept', cid).projectId !== q.projectId)
          throw new Error('프로젝트가 다른 개념입니다.')
    }
    if (Array.isArray(patch.suggestions))
      safe.suggestions = patch.suggestions.filter((s) => typeof s === 'string').slice(0, 10)
    this.put('question', this.active, { ...q, ...safe })
  }
  moveQuestion(id: string, projectId: string): void {
    const q = this.record<Question>('question', id)
    this.record<Project>('project', projectId)
    if (q.projectId === projectId) return
    // Concepts belong to the old project's map, so links and suggestions do not carry over.
    this.put('question', this.active, { ...q, projectId, conceptIds: [], suggestions: [] })
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
      if (parent.projectId !== c.projectId) throw new Error('다른 프로젝트로 이동할 수 없습니다.')
      next = parent.parentId
    }
    this.put('concept', this.active, {
      ...c,
      name: name.trim().slice(0, 200),
      parentId,
      manual: true
    })
  }
  mergeConcept(source: string, target: string): void {
    const a = this.record<Concept>('concept', source),
      b = this.record<Concept>('concept', target)
    if (source === target || a.projectId !== b.projectId)
      throw new Error('같은 프로젝트의 다른 개념을 선택해 주세요.')
    // Reject merging into a descendant; the tree must remain acyclic.
    let parent: Concept | undefined = b
    while (parent) {
      if (parent.id === source) throw new Error('하위 개념으로 병합할 수 없습니다.')
      parent = parent.parentId ? this.record<Concept>('concept', parent.parentId) : undefined
    }
    this.db.exec('BEGIN')
    try {
      for (const q of this.list<Question>('question'))
        if (q.conceptIds.includes(source))
          this.updateQuestion(q.id, {
            conceptIds: [...new Set(q.conceptIds.map((id) => (id === source ? target : id)))]
          })
      for (const c of this.list<Concept>('concept'))
        if (c.parentId === source) this.editConcept(c.id, c.name, target)
      this.db.prepare('DELETE FROM records WHERE id=?').run(source)
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

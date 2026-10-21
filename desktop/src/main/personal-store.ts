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
  Workspace
} from '../preload/personal'

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
      if (q.status === 'running')
        this.put('question', String(row.profile), {
          ...q,
          status: 'failed',
          error: '앱이 종료되어 요청이 중단되었습니다.'
        })
    }
    this.db.exec(
      "UPDATE runs SET status='failed',error='앱 재시작으로 중단' WHERE status='running'"
    )
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
  rename(kind: 'workspace' | 'project', id: string, name: string): void {
    if (
      !['workspace', 'project'].includes(kind) ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 200
    )
      throw new Error('이름은 1~200자로 입력해 주세요.')
    const record = this.record<Workspace | Project>(kind, id)
    this.put(kind, this.active, { ...record, name: name.trim() })
  }
  snapshot(): Snapshot {
    const questions = this.list<Question>('question').sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    const paths = new Set(questions.map((q) => q.attachment).filter(Boolean) as string[])
    let storageBytes = 0
    for (const path of paths)
      if (existsSync(this.imagePath(path))) storageBytes += statSync(this.imagePath(path)).size
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
  removeAttachment(questionId: string): void {
    const q = this.record<Question>('question', questionId)
    const id = q.attachment
    this.put('question', this.active, { ...q, attachment: null })
    if (
      id &&
      !this.db
        .prepare(
          "SELECT id FROM records WHERE kind='question' AND json_extract(data,'$.attachment')=?"
        )
        .get(id) &&
      existsSync(this.imagePath(id))
    )
      unlinkSync(this.imagePath(id))
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

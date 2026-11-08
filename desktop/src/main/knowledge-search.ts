// Local full-text search over concepts and questions: an FTS5 trigram index ranked with bm25().
// Trigram MATCH cannot find terms shorter than 3 characters, so 1–2 character terms use LIKE.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Concept, Question } from '../preload/personal'

export type SearchKind = 'concept' | 'question'
export interface SearchHit {
  kind: SearchKind
  id: string
  /** Higher is better: -bm25() for trigram terms plus an IDF weight per matched short term. */
  score: number
}
export interface SearchOptions {
  workspaceId?: string
  /** Questions of this project and the concepts they link. */
  projectId?: string
  kinds?: SearchKind[]
  limit: number
}
export interface IndexEntry {
  /** rowid of the source row in `records`. */
  rowid: number
  id: string
  kind: SearchKind
  profile: string
  workspace: string
  project: string
  text: string
}

const MAX_TRIGRAMS = 256
const MAX_SHORT = 32
const QUESTION_TURN_CHARS = 2000
// Common Korean particles; "행렬의" should also find the concept "행렬". Longest first.
const PARTICLES = [
  '에서는',
  '으로는',
  '이라는',
  '에게서',
  '이라고',
  '에서',
  '에게',
  '으로',
  '이란',
  '라는',
  '라고',
  '이나',
  '부터',
  '까지',
  '처럼',
  '보다',
  '하고',
  '와',
  '과',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '도',
  '로',
  '만',
  '란',
  '나'
]
const HANGUL = /^[\uac00-\ud7a3]+$/

/** Case-, width- and whitespace-insensitive form used for exact name/alias equality. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function conceptText(c: Pick<Concept, 'name' | 'aliases' | 'definition'>): string {
  return [c.name, ...(c.aliases ?? []), c.definition ?? ''].join('\n')
}

export function questionText(q: Pick<Question, 'title' | 'memo' | 'turns'>): string {
  const turns = q.turns
    .map((t) => `${t.sent || t.refined || t.raw}\n${t.answer}`)
    .join('\n')
    .slice(0, QUESTION_TURN_CHARS)
  return [q.title ?? '', q.memo ?? '', turns].join('\n')
}

/** Splits text into trigram phrases (for MATCH) and 1–2 character terms (for LIKE). */
export function searchTerms(text: string): { trigrams: string[]; short: string[] } {
  const trigrams = new Set<string>()
  const short = new Set<string>()
  for (const word of text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue
    const variants = [word]
    if (HANGUL.test(word))
      for (const p of PARTICLES)
        if (word.length - p.length >= 2 && word.endsWith(p)) {
          variants.push(word.slice(0, -p.length))
          break
        }
    for (const v of variants) {
      const chars = [...v]
      if (chars.length < 3) {
        if (short.size < MAX_SHORT) short.add(v)
        continue
      }
      for (let i = 0; i + 3 <= chars.length && trigrams.size < MAX_TRIGRAMS; i++)
        trigrams.add(chars.slice(i, i + 3).join(''))
    }
  }
  return { trigrams: [...trigrams], short: [...short] }
}

export class KnowledgeSearch {
  constructor(private readonly db: DatabaseSync) {}

  create(): void {
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(text, id UNINDEXED, kind UNINDEXED, profile UNINDEXED, workspace UNINDEXED, project UNINDEXED, tokenize='trigram')"
    )
  }

  upsert(e: IndexEntry): void {
    this.db.prepare('DELETE FROM knowledge_fts WHERE rowid=?').run(e.rowid)
    this.db
      .prepare(
        'INSERT INTO knowledge_fts(rowid,text,id,kind,profile,workspace,project) VALUES(?,?,?,?,?,?,?)'
      )
      .run(e.rowid, e.text, e.id, e.kind, e.profile, e.workspace, e.project)
  }

  remove(rowid: number): void {
    this.db.prepare('DELETE FROM knowledge_fts WHERE rowid=?').run(rowid)
  }

  removeProfile(profile: string): void {
    this.db.prepare('DELETE FROM knowledge_fts WHERE profile=?').run(profile)
  }

  clear(): void {
    this.db.exec('DELETE FROM knowledge_fts')
  }

  search(profile: string, text: string, options: SearchOptions): SearchHit[] {
    const { trigrams, short } = searchTerms(text)
    const limit = Math.max(0, Math.floor(options.limit))
    if ((!trigrams.length && !short.length) || !limit) return []
    const kinds = (options.kinds?.length ? options.kinds : ['concept', 'question']).filter(
      (k): k is SearchKind => k === 'concept' || k === 'question'
    )
    if (!kinds.length) return []
    let scope = `profile=? AND kind IN (${kinds.map(() => '?').join(',')})`
    const params: SQLInputValue[] = [profile, ...kinds]
    if (options.workspaceId) {
      scope += ' AND workspace=?'
      params.push(options.workspaceId)
    }
    if (options.projectId) {
      scope += ` AND (project=? OR (kind='concept' AND id IN (SELECT c.value FROM records q, json_each(q.data,'$.conceptIds') c WHERE q.kind='question' AND q.profile=? AND json_extract(q.data,'$.projectId')=?)))`
      params.push(options.projectId, profile, options.projectId)
    }
    const scores = new Map<string, SearchHit>()
    const add = (kind: SearchKind, id: string, score: number): void => {
      const hit = scores.get(id)
      if (hit) hit.score += score
      else scores.set(id, { kind, id, score })
    }
    if (trigrams.length) {
      const query = trigrams.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      for (const row of this.db
        .prepare(
          `SELECT id,kind,bm25(knowledge_fts) AS s FROM knowledge_fts WHERE knowledge_fts MATCH ? AND ${scope} ORDER BY s LIMIT 500`
        )
        .all(query, ...params))
        add(row.kind as SearchKind, String(row.id), -Number(row.s))
    }
    if (short.length) {
      const total = Number(
        this.db.prepare(`SELECT count(*) AS n FROM knowledge_fts WHERE ${scope}`).get(...params)
          ?.n ?? 0
      )
      const like = this.db.prepare(
        `SELECT id,kind FROM knowledge_fts WHERE ${scope} AND text LIKE ? ESCAPE '\\' LIMIT 500`
      )
      for (const term of short) {
        const rows = like.all(...params, `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
        if (!rows.length) continue
        // Same IDF as FTS5's bm25(), floored the same way, so both kinds of terms rank together.
        const idf = Math.max(1e-6, Math.log((total - rows.length + 0.5) / (rows.length + 0.5)))
        for (const row of rows) add(row.kind as SearchKind, String(row.id), idf)
      }
    }
    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

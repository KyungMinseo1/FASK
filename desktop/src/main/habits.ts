import { randomUUID } from 'node:crypto'
import type { Habit, HabitInput, HabitLine, HabitList, HabitSource, Project, Question } from '../preload/personal'
import type { ExtractedHabit } from './knowledge-response'
import { normalizeName } from './knowledge-search'
import type { PersonalStore } from './personal-store'

/**
 * Answer habits: format rules learned from the user's requests ("표로 정리해줘", "latex로 변환해줘")
 * and applied to later answers. Detection is its own model call on the asking profile's PC
 * (habit-detect.ts) over that profile's requests only; the model judges every request, with no
 * local keyword gate. A format wish first becomes a candidate (status 'proposed') that is never
 * applied; it turns on by itself once it was seen in HABIT_PROMOTE_COUNT distinct conversations,
 * or at once when the model judged the user asked for it to last (`explicit`). A habit applies to
 * every project (scope 'profile') or to one project (scope 'project', identified by the owning
 * PC's profile id and the project id); a project habit wins over a profile habit only through its
 * explicit `overrides`.
 */

/** Requests per habit model call; also the pending count that triggers a local batch. */
export const HABIT_FEEDBACK_MAX = 8
/** Opening of the answer the request followed (its head shows the answer's format). */
export const HABIT_PREVIOUS_CHARS = 600
/** Longest request sent; a longer one keeps its head and tail (a format wish often ends it). */
export const HABIT_REQUEST_CHARS = 500
/** Newest rejected habits sent so a turned-off habit is recognized instead of re-proposed. */
export const HABIT_REJECTED_SENT_MAX = 100
/** Candidates kept; beyond this the one seen in the fewest conversations (oldest first) goes. */
export const HABIT_CANDIDATE_MAX = 30
/** Distinct conversations that turn a candidate on. */
export const HABIT_PROMOTE_COUNT = 3
/** Every-answer rules that rank first when the prompt budget is short. */
export const HABIT_ALWAYS_MAX = 5
/** Budget of the habit lines in the answer system prompt. */
export const HABIT_PROMPT_CHARS = 1500
export const HABIT_KEYWORDS_MAX = 8
const RULE_MAX = 300
const WHEN_MAX = 200
const SOURCES_MAX = 10
const FILE_MAX = 1_000_000
const FILE_HABITS_MAX = 200
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/**
 * Situation keywords: split on , ， 、 / · ; or newlines, trimmed, 1-character ones dropped ("표"
 * would match "대표", "표준"), duplicates (normalized) dropped, at most HABIT_KEYWORDS_MAX joined
 * by ", " within 200 characters.
 */
export function normalizeWhen(raw: string): string {
  const seen = new Set<string>()
  const keywords: string[] = []
  for (const piece of raw.split(/[,，、/·;\n]/)) {
    const k = piece.trim().replace(/\s+/g, ' ')
    if (k.length < 2 || seen.has(normalizeName(k))) continue
    seen.add(normalizeName(k))
    keywords.push(k)
    if (keywords.length >= HABIT_KEYWORDS_MAX) break
  }
  let out = ''
  for (const k of keywords) {
    const next = out ? `${out}, ${k}` : k
    if (next.length > WHEN_MAX) break
    out = next
  }
  return out
}

/** Keywords of `h.when` found in `text` (normalized substring, so "수식을" matches "수식"). */
export function whenMatches(h: Habit, text: string): number {
  if (!h.when) return 0
  const haystack = normalizeName(text)
  return h.when.split(', ').filter((k) => haystack.includes(normalizeName(k))).length
}

/** A request within HABIT_REQUEST_CHARS; a longer one keeps its first and last halves. */
export function clipRequest(text: string): string {
  if (text.length <= HABIT_REQUEST_CHARS) return text
  return `${text.slice(0, HABIT_REQUEST_CHARS / 2)} … ${text.slice(-HABIT_REQUEST_CHARS / 2)}`
}

/** A request sent to the habit model; `index` is its turn index in the question. */
export interface FeedbackTurn {
  index: number
  turnId: string
  createdAt: string
  question: string
  previousAnswer?: string
}

/** Every finished turn of `own` among [from, end), oldest first. */
export function feedbackTurns(
  q: Question,
  from: number,
  end: number,
  own: (t: Question['turns'][number]) => boolean = () => true
): FeedbackTurn[] {
  const out: FeedbackTurn[] = []
  for (let i = from; i < end; i++) {
    const t = q.turns[i]
    if (!t || (t.status !== 'completed' && t.status !== 'saved') || !own(t)) continue
    const previous = q.turns[i - 1]
    out.push({
      index: i,
      turnId: t.id,
      createdAt: t.createdAt,
      question: clipRequest((t.refined || t.raw).trim()),
      ...(previous?.status === 'completed' && previous.answer
        ? { previousAnswer: previous.answer.slice(0, HABIT_PREVIOUS_CHARS) }
        : {})
    })
  }
  return out
}

const live = (store: PersonalStore, profile: string): Habit[] =>
  store.list<Habit>('habit', profile).filter((h) => !h.invalidatedAt)
const newestFirst = (a: Habit, b: Habit): number => b.updatedAt.localeCompare(a.updatedAt)
/** Identity of a habit's meaning: normalized rule, scope and (for a project habit) its project. */
const habitKey = (rule: string, scope: Habit['scope'], projectOwner: string | null, projectId: string | null): string =>
  `${normalizeName(rule)}\u0000${scope}\u0000${scope === 'project' ? `${projectOwner}/${projectId}` : ''}`
const keyOf = (h: Habit): string => habitKey(h.rule, h.scope, h.projectOwner, h.projectId)

function findLive(store: PersonalStore, profile: string, id: string): Habit {
  const h = live(store, profile).find((x) => x.id === id)
  if (!h) throw new Error('습관을 찾을 수 없습니다.')
  return h
}

/**
 * Habits sent with requests of `project`: the profile habits and that project's habits; every
 * active one, then every candidate, then the HABIT_REJECTED_SENT_MAX newest rejected ones, each
 * group newest first. Another project's habits are never sent, so no answer can point at them.
 */
export function habitContext(store: PersonalStore, profile: string, project: { owner: string; id: string }): Habit[] {
  const inScope = live(store, profile)
    .filter(
      (h) =>
        h.scope === 'profile' || (h.scope === 'project' && h.projectOwner === project.owner && h.projectId === project.id)
    )
    .sort(newestFirst)
  return [
    ...inScope.filter((h) => h.status === 'active'),
    ...inScope.filter((h) => h.status === 'proposed'),
    ...inScope.filter((h) => h.status === 'rejected').slice(0, HABIT_REJECTED_SENT_MAX)
  ]
}

/** Adds a source (merging turns of the same question, moved last) and keeps the latest SOURCES_MAX. */
function withSource(sources: HabitSource[], source: HabitSource): HabitSource[] {
  const old = sources.find((s) => s.questionId === source.questionId)
  const merged = old ? { ...source, turnIds: [...new Set([...old.turnIds, ...source.turnIds])] } : source
  return [...sources.filter((s) => s !== old), merged].slice(-SOURCES_MAX)
}

/** Turns a habit on; the habit it replaces is superseded only now. */
export function activate(store: PersonalStore, profile: string, h: Habit): void {
  const now = new Date().toISOString()
  store.put('habit', profile, { ...h, status: 'active' })
  if (!h.replaces) return
  const old = store.list<Habit>('habit', profile).find((x) => x.id === h.replaces)
  if (old && !old.invalidatedAt) store.put('habit', profile, { ...old, invalidatedAt: now, updatedAt: now })
}

/** Where a request sent to the habit model came from; keyed by the `turn` number it was sent as. */
export interface HabitRef {
  questionId: string
  turnId: string
  project: { owner: string; id: string }
}

/**
 * Writes the habits the model found in requests; `refs` maps each sent `turn` number to its
 * request, and every ref of one call shares one project. A known habit (by `same`, else by
 * meaning) gains the new sources and one count per conversation not seen before; a request it
 * already holds writes nothing, so a re-check is idempotent. A candidate turns on, still
 * unconfirmed (reviewedAt null), once it was seen in HABIT_PROMOTE_COUNT conversations or when
 * the model judged the request `explicit`; active and rejected habits keep their status. A new
 * habit is a candidate unless that already holds; at HABIT_CANDIDATE_MAX candidates the one seen
 * in the fewest conversations (oldest first) is dropped for it. A conflict whose scope the user
 * left unclear (`scopeClear` false) stays a candidate and changes no existing habit until the user
 * turns it on. `overrides` is kept only as the model gave it (a live profile habit); it is never
 * filled in locally.
 */
export function applyDetected(
  store: PersonalStore,
  profile: string,
  items: ExtractedHabit[],
  refs: ReadonlyMap<number, HabitRef>
): void {
  for (const item of items) {
    const cited = item.turns.flatMap((n) => refs.get(n) ?? [])
    if (!cited.length) continue
    const now = new Date().toISOString()
    const byQuestion = new Map<string, Set<string>>()
    for (const r of cited) byQuestion.set(r.questionId, (byQuestion.get(r.questionId) ?? new Set()).add(r.turnId))
    const sources: HabitSource[] = [...byQuestion].map(([questionId, turnIds]) => ({ questionId, turnIds: [...turnIds] }))
    const unclear = item.scopeClear === false
    const explicit = item.explicit
    const projectOwner = item.scope === 'project' ? cited[0].project.owner : null
    const projectId = item.scope === 'project' ? cited[0].project.id : null
    const habits = live(store, profile)
    const key = habitKey(item.rule, item.scope, projectOwner, projectId)
    const known =
      (item.same ? habits.find((h) => h.id === item.same) : undefined) ?? habits.find((h) => keyOf(h) === key)
    if (known) {
      const seenTurns = new Set(known.sources.flatMap((s) => s.turnIds))
      const seenQuestions = new Set(known.sources.map((s) => s.questionId))
      if (cited.every((r) => seenTurns.has(r.turnId))) continue
      const freshQuestions = sources.filter((s) => !seenQuestions.has(s.questionId)).length
      const next: Habit = {
        ...known,
        sources: sources.reduce(withSource, known.sources),
        count: known.count + freshQuestions,
        updatedAt: now
      }
      if (known.status === 'proposed' && !unclear && (explicit || next.count >= HABIT_PROMOTE_COUNT))
        activate(store, profile, { ...next, origin: explicit ? 'explicit' : 'detected' })
      else store.put('habit', profile, next)
      continue
    }
    const count = sources.length
    const on = !unclear && (explicit || count >= HABIT_PROMOTE_COUNT)
    if (!on) {
      const candidates = habits.filter((h) => h.status === 'proposed')
      if (candidates.length >= HABIT_CANDIDATE_MAX) {
        const victim = candidates.reduce((a, b) =>
          b.count < a.count || (b.count === a.count && b.updatedAt < a.updatedAt) ? b : a
        )
        store.removeHabit(victim.id, profile)
      }
    }
    const overrides =
      !unclear && item.scope === 'project' && habits.some((h) => h.id === item.overrides && h.scope === 'profile')
        ? item.overrides
        : null
    const habit: Habit = {
      id: randomUUID(),
      rule: item.rule,
      when: item.when,
      scope: item.scope,
      projectOwner,
      projectId,
      overrides,
      status: on ? 'active' : 'proposed',
      origin: on && explicit ? 'explicit' : 'detected',
      sources: sources.slice(-SOURCES_MAX),
      count,
      replaces: item.replaces,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
      invalidatedAt: null
    }
    if (on) activate(store, profile, habit)
    else store.put('habit', profile, habit)
  }
}

/** Rule categories two habits may conflict in; only an ordering hint for choosing `overrides`. */
const HABIT_CATEGORIES: Record<string, RegExp> = {
  length: /짧게|길게|간단히|간단하게|자세히|자세하게|요약|concise|shorter|longer|brief|detail/i,
  layout: /표로|표 형식|비교표|목록|번호|줄바꿈|table|bullet|list/i,
  notation: /latex|수식|공식|코드 ?블록|code ?block|math/i,
  tone: /말투|반말|존댓말|tone/i,
  language: /한국어로|영어로|in english|in korean/i
}

/**
 * Active profile habits a project habit without `overrides` may conflict with: a shared rule
 * category and either both every-answer rules or a shared situation keyword. Never applied
 * automatically ("설명을 자세하게" and "예시를 자세하게" share a category without conflicting).
 */
export function overrideCandidates(h: Habit, globals: Habit[]): string[] {
  if (h.scope !== 'project' || h.overrides !== null) return []
  const categories = Object.values(HABIT_CATEGORIES).filter((re) => re.test(h.rule))
  if (!categories.length) return []
  const keywords = new Set(h.when ? h.when.split(', ').map(normalizeName) : [])
  return globals
    .filter(
      (g) =>
        g.status === 'active' &&
        g.scope === 'profile' &&
        !g.invalidatedAt &&
        categories.some((re) => re.test(g.rule)) &&
        ((!h.when && !g.when) || g.when.split(', ').some((k) => keywords.has(normalizeName(k))))
    )
    .map((g) => g.id)
}

const STATUS_ORDER: Record<Habit['status'], number> = { proposed: 0, active: 1, rejected: 2 }

/**
 * The habit screen. `projects` (this PC's projects plus the visible remote ones) is passed through
 * for the scope picker and labels.
 */
export function listHabits(
  store: PersonalStore,
  profile: string,
  projects: { owner: string; id: string; name: string }[]
): HabitList {
  const habits = live(store, profile).sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || newestFirst(a, b)
  )
  const candidates: Record<string, string[]> = {}
  for (const h of habits) {
    const ids = overrideCandidates(h, habits)
    if (ids.length) candidates[h.id] = ids
  }
  return {
    enabled: store.settings(profile).answerHabits,
    habits,
    projects,
    overrideCandidates: candidates,
    promoteAt: HABIT_PROMOTE_COUNT
  }
}

export function decideHabit(store: PersonalStore, profile: string, id: string, decision: 'active' | 'rejected'): void {
  const now = new Date().toISOString()
  const h = { ...findLive(store, profile, id), updatedAt: now, reviewedAt: now }
  if (decision === 'active') activate(store, profile, h)
  else store.put('habit', profile, { ...h, status: 'rejected' })
}

/**
 * A user-written habit: added active, or an existing one's rule, situation and scope edited. A
 * project habit names a project `projectExists` knows; `overrides` is only what the user chose.
 */
export function saveHabit(
  store: PersonalStore,
  profile: string,
  input: HabitInput,
  projectExists: (owner: string, id: string) => boolean
): string {
  function invalid(): never {
    throw new Error('습관 내용이 잘못되었습니다.')
  }
  if (!input || typeof input !== 'object' || typeof input.rule !== 'string' || typeof input.when !== 'string') invalid()
  const rule = input.rule.trim()
  if (!rule || rule.length > RULE_MAX) invalid()
  const when = normalizeWhen(input.when)
  if (input.when.trim() && !when) invalid()
  if (input.scope !== 'profile' && input.scope !== 'project') invalid()
  const id = input.id === undefined ? undefined : String(input.id)
  const habits = live(store, profile)
  let projectOwner: string | null = null
  let projectId: string | null = null
  let overrides: string | null = null
  if (input.scope === 'project') {
    if (
      typeof input.projectOwner !== 'string' ||
      typeof input.projectId !== 'string' ||
      !projectExists(input.projectOwner, input.projectId)
    )
      invalid()
    projectOwner = input.projectOwner
    projectId = input.projectId
    if (input.overrides !== null && input.overrides !== undefined) {
      if (!habits.some((h) => h.id === input.overrides && h.id !== id && h.scope === 'profile')) invalid()
      overrides = input.overrides
    }
  } else if (input.overrides !== null && input.overrides !== undefined) invalid()
  const key = habitKey(rule, input.scope, projectOwner, projectId)
  if (habits.some((h) => h.id !== id && keyOf(h) === key)) throw new Error('같은 습관이 이미 있습니다.')
  const now = new Date().toISOString()
  if (id !== undefined) {
    const h = findLive(store, profile, id)
    // A habit that stops being profile-wide can no longer be overridden.
    if (input.scope === 'project')
      for (const other of habits)
        if (other.overrides === id) store.put('habit', profile, { ...other, overrides: null })
    return store.put('habit', profile, {
      ...h,
      rule,
      when,
      scope: input.scope,
      projectOwner,
      projectId,
      overrides,
      updatedAt: now,
      reviewedAt: now
    })
  }
  return store.put<Habit>('habit', profile, {
    id: randomUUID(),
    rule,
    when,
    scope: input.scope,
    projectOwner,
    projectId,
    overrides,
    status: 'active',
    origin: 'manual',
    sources: [],
    count: 1,
    replaces: null,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    invalidatedAt: null
  })
}

/**
 * Active habits for an answer in `project` (owning PC's profile id and project id). Habits are
 * few and short, so all of them go when they fit and the answer model judges the situation from
 * the bracketed keywords. The project's own habits rank first, and a profile habit is left out
 * only when an included project habit explicitly `overrides` it; other possible conflicts are
 * settled by habitPrompt's section order. A short budget ranks the rest: up to HABIT_ALWAYS_MAX
 * every-answer rules, then keywords found in `text`, count and recency; one that does not fit is
 * skipped for the next.
 */
export function recallHabits(
  store: PersonalStore,
  p: { profile: string; project: { owner: string; id: string }; text: string }
): Habit[] {
  const ranked = live(store, p.profile)
    .filter(
      (h) =>
        h.status === 'active' &&
        (h.scope === 'profile' || (h.projectOwner === p.project.owner && h.projectId === p.project.id))
    )
    .map((h) => ({ h, matches: whenMatches(h, p.text) }))
    .sort((a, b) => b.matches - a.matches || b.h.count - a.h.count || newestFirst(a.h, b.h))
  const tier = (h: Habit): number => (h.scope === 'project' ? 0 : 1)
  const always = new Set(
    [...ranked]
      .sort((a, b) => tier(a.h) - tier(b.h))
      .filter(({ h }) => !h.when)
      .slice(0, HABIT_ALWAYS_MAX)
      .map(({ h }) => h.id)
  )
  // Array sort is stable: project habits, then always rules, then the rest, each in the ranking above.
  ranked.sort(
    (a, b) => tier(a.h) - tier(b.h) || Number(!always.has(a.h.id)) - Number(!always.has(b.h.id))
  )
  const out: Habit[] = []
  const overridden = new Set<string>()
  let used = 0
  for (const { h } of ranked) {
    if (overridden.has(h.id)) continue
    const size = h.rule.length + h.when.length + 4
    if (used + size > HABIT_PROMPT_CHARS) continue
    used += size
    out.push(h)
    if (h.overrides) overridden.add(h.overrides)
  }
  return out
}

/** Habit lines for the answer prompt. */
export function toLines(habits: Habit[]): HabitLine[] {
  return habits.map((h) => ({ rule: h.rule, when: h.when, project: h.scope === 'project' }))
}

/**
 * The `{{habits}}` text of the answer-habits prompt: project rules first under a heading saying
 * they win a conflict, then the every-project rules; plain lines when there is no project rule.
 */
export function habitPrompt(lines: HabitLine[], lang: 'ko' | 'en'): string {
  const line = (l: HabitLine): string => `- ${l.rule}${l.when ? ` [${l.when}]` : ''}`
  const project = lines.filter((l) => l.project).map(line)
  const rest = lines.filter((l) => !l.project).map(line)
  if (!project.length) return rest.join('\n')
  const [own, every] =
    lang === 'ko'
      ? ['이 프로젝트 전용 규칙 (아래 규칙과 부딪히면 이 규칙을 따른다):', '모든 프로젝트 규칙:']
      : ['Rules for this project only (they win over any rule below they conflict with):', 'Rules for every project:']
  return [own, ...project, ...(rest.length ? [every, ...rest] : [])].join('\n')
}

/**
 * The active habits as a portable file. A habit of one of this PC's projects names its project;
 * a habit of another PC's project stays here (it means nothing without that PC).
 */
export function habitFile(store: PersonalStore, profile: string): string {
  const names = new Map(store.list<Project>('project', profile).map((p) => [p.id, p.name]))
  return JSON.stringify(
    {
      format: 'fask-habits',
      version: 1,
      exportedAt: new Date().toISOString(),
      habits: live(store, profile)
        .filter((h) => h.status === 'active' && (h.scope === 'profile' || h.projectOwner === profile))
        .flatMap((h): { rule: string; when: string; project: string | null }[] => {
          if (h.scope === 'profile') return [{ rule: h.rule, when: h.when, project: null }]
          const name = names.get(h.projectId ?? '')
          return name === undefined ? [] : [{ rule: h.rule, when: h.when, project: name }]
        })
    },
    null,
    2
  )
}

/**
 * Adds a habit file's habits as active. A malformed file is rejected whole; an invalid entry,
 * one naming a project this PC lacks, or one already present is skipped. An older file's
 * `workspace` field is ignored: its habit applies to every project.
 */
export function importHabitFile(store: PersonalStore, profile: string, text: string): { added: number; skipped: number } {
  function bad(): never {
    throw new Error('습관 파일 형식이 잘못되었습니다.')
  }
  if (typeof text !== 'string' || text.length > FILE_MAX) bad()
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    bad()
  }
  const f = file as { format?: unknown; version?: unknown; habits?: unknown } | null
  if (!f || typeof f !== 'object' || f.format !== 'fask-habits' || f.version !== 1) bad()
  const entries = f.habits
  if (!Array.isArray(entries) || entries.length > FILE_HABITS_MAX) bad()
  const projects = store.list<Project>('project', profile)
  const keys = new Set(live(store, profile).map(keyOf))
  let added = 0,
    skipped = 0
  store.db.exec('BEGIN')
  try {
    for (const raw of entries as unknown[]) {
      const e = raw as { rule?: unknown; when?: unknown; project?: unknown } | null
      const rule = e && typeof e === 'object' && typeof e.rule === 'string' ? e.rule.trim() : ''
      if (!rule || rule.length > RULE_MAX || typeof e?.when !== 'string') {
        skipped++
        continue
      }
      let projectId: string | null = null
      if (typeof e.project === 'string') {
        const name = normalizeName(e.project)
        projectId = projects.find((p) => normalizeName(p.name) === name)?.id ?? null
        if (!projectId) {
          skipped++
          continue
        }
      } else if (e.project !== null && e.project !== undefined) {
        skipped++
        continue
      }
      const scope: Habit['scope'] = projectId ? 'project' : 'profile'
      const projectOwner = projectId ? profile : null
      const key = habitKey(rule, scope, projectOwner, projectId)
      if (keys.has(key)) {
        skipped++
        continue
      }
      keys.add(key)
      const now = new Date().toISOString()
      store.put<Habit>('habit', profile, {
        id: randomUUID(),
        rule,
        when: normalizeWhen(e.when),
        scope,
        projectOwner,
        projectId,
        overrides: null,
        status: 'active',
        origin: 'imported',
        sources: [],
        count: 1,
        replaces: null,
        reviewedAt: now,
        createdAt: now,
        updatedAt: now,
        invalidatedAt: null
      })
      added++
    }
    store.db.exec('COMMIT')
  } catch (e) {
    store.db.exec('ROLLBACK')
    throw e
  }
  return { added, skipped }
}

const isIso = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v))

/**
 * Habits of a backup made on the PC whose profile id is `owner` (null for backups before v4).
 * Absent (older backups): none; not an array: null (corrupt backup). Habits are secondary, so a
 * malformed one, or one of the owner's projects missing from the backup, is dropped instead of
 * failing the restore; a habit of another PC's project passes as is. A former workspace habit
 * becomes a profile habit. Sources keep only questions and turns present, and a `replaces` or
 * `overrides` pointing at a dropped habit becomes null. Duplicate ids keep the first.
 */
export function backupHabits(
  raw: unknown,
  projectIds: Set<string>,
  questions: Question[],
  owner: string | null
): Habit[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const turns = new Map(questions.map((q) => [q.id, new Set(q.turns.map((t) => t.id))]))
  const seen = new Set<string>()
  const kept: Habit[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const h = item as Omit<Habit, 'scope'> & { scope: unknown }
    const project = h.scope === 'project'
    if (
      typeof h.id !== 'string' ||
      !h.id ||
      h.id.length > 100 ||
      seen.has(h.id) ||
      typeof h.rule !== 'string' ||
      !h.rule.trim() ||
      h.rule.length > RULE_MAX ||
      typeof h.when !== 'string' ||
      h.when.length > WHEN_MAX ||
      !['proposed', 'active', 'rejected'].includes(h.status) ||
      !['detected', 'explicit', 'manual', 'imported'].includes(h.origin) ||
      (h.scope !== 'profile' && h.scope !== 'workspace' && !project) ||
      (project &&
        (typeof h.projectOwner !== 'string' ||
          typeof h.projectId !== 'string' ||
          (h.projectOwner === owner && !projectIds.has(h.projectId)))) ||
      (h.overrides !== undefined && h.overrides !== null && typeof h.overrides !== 'string') ||
      !Number.isInteger(h.count) ||
      h.count < 0 ||
      (h.replaces !== null && typeof h.replaces !== 'string') ||
      !isIso(h.createdAt) ||
      !isIso(h.updatedAt) ||
      (h.reviewedAt !== null && !isIso(h.reviewedAt)) ||
      (h.invalidatedAt !== null && !isIso(h.invalidatedAt)) ||
      !Array.isArray(h.sources) ||
      h.sources.some(
        (s) =>
          !s ||
          typeof s.questionId !== 'string' ||
          !Array.isArray(s.turnIds) ||
          s.turnIds.some((t) => typeof t !== 'string')
      )
    )
      continue
    seen.add(h.id)
    kept.push({
      id: h.id,
      rule: h.rule,
      when: h.when,
      scope: project ? 'project' : 'profile',
      projectOwner: project ? h.projectOwner : null,
      projectId: project ? h.projectId : null,
      overrides: project ? (h.overrides ?? null) : null,
      status: h.status,
      origin: h.origin,
      sources: h.sources.flatMap((s) => {
        const known = turns.get(s.questionId)
        return known ? [{ questionId: s.questionId, turnIds: s.turnIds.filter((t) => known.has(t)) }] : []
      }),
      count: h.count,
      replaces: h.replaces,
      reviewedAt: h.reviewedAt,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
      invalidatedAt: h.invalidatedAt
    })
  }
  const ids = new Set(kept.map((h) => h.id))
  return kept.map((h) => ({
    ...h,
    replaces: h.replaces && ids.has(h.replaces) ? h.replaces : null,
    overrides: h.overrides && ids.has(h.overrides) ? h.overrides : null
  }))
}

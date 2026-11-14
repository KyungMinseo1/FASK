import { randomUUID } from 'node:crypto'
import type { Habit, HabitInput, HabitList, HabitSource, Question, Workspace } from '../preload/personal'
import type { ExtractedHabit } from './knowledge-response'
import { normalizeName } from './knowledge-search'
import type { PersonalStore } from './personal-store'

/**
 * Answer habits: format rules learned from the user's feedback ("앞으로 표로", "말고 짧게 다시")
 * and applied to later answers. Detection rides on the extraction call; only a habit the user
 * asked for explicitly ("앞으로", "항상"…, checked locally in the user's own words) turns on by
 * itself, everything else waits as a proposal for the user's decision. `count` never activates.
 */

/** Format words; a turn needs one of these to be sent to the model as feedback. */
export const HABIT_FORMAT =
  /표로|표 형식|비교표|코드 ?블록|latex|수식|공식|짧게|길게|간단히|자세히|목록|요약|형식|말투|반말|존댓말|줄바꿈|번호|한국어로|영어로|table|code ?block|shorter|longer|concise|bullet|format|tone|in english|in korean/i
/** Words asking for a lasting change; the only local evidence that may turn a habit on. */
export const HABIT_EXPLICIT = /앞으로|항상|매번|기억해|늘 |from now on|always|every time|remember/i
/** Complaint or correction words. */
export const HABIT_CORRECTION = /다시|말고|대신|불편|힘들|안 ?돼|왜 이렇게|복사|instead|again|don'?t|hard to|copy/i
/** A turn worth asking the model about: a format word plus an explicit or corrective word. */
export function isHabitFeedback(text: string): boolean {
  return HABIT_FORMAT.test(text) && (HABIT_EXPLICIT.test(text) || HABIT_CORRECTION.test(text))
}

/** Feedback turns sent per extraction run (the latest ones). */
export const HABIT_FEEDBACK_MAX = 5
/** Opening of the answer the feedback was about. */
export const HABIT_PREVIOUS_CHARS = 2000
/** Known habits sent with feedback so the model can name the same or a replaced one. */
export const HABIT_SENT_MAX = 30
/** Undecided proposals; a new non-explicit habit beyond this is dropped. */
export const HABIT_PROPOSED_MAX = 5
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

/** Feedback turns among [from, end): finished turns passing the gate, the latest HABIT_FEEDBACK_MAX. */
export function feedbackTurns(
  q: Question,
  from: number,
  end: number
): { turn: number; question: string; previousAnswer?: string }[] {
  const out: { turn: number; question: string; previousAnswer?: string }[] = []
  for (let i = from; i < end; i++) {
    const t = q.turns[i]
    if (!t || (t.status !== 'completed' && t.status !== 'saved')) continue
    const text = (t.refined || t.raw).trim()
    if (!isHabitFeedback(text)) continue
    const previous = q.turns[i - 1]
    out.push({
      turn: i,
      question: text.slice(0, 1000),
      ...(previous?.status === 'completed' && previous.answer
        ? { previousAnswer: previous.answer.slice(0, HABIT_PREVIOUS_CHARS) }
        : {})
    })
  }
  return out.slice(-HABIT_FEEDBACK_MAX)
}

const live = (store: PersonalStore, profile: string): Habit[] =>
  store.list<Habit>('habit', profile).filter((h) => !h.invalidatedAt)
const newestFirst = (a: Habit, b: Habit): number => b.updatedAt.localeCompare(a.updatedAt)
/** Identity of a habit's meaning: normalized rule, scope and workspace. */
const habitKey = (rule: string, scope: Habit['scope'], workspaceId: string | null): string =>
  `${normalizeName(rule)}\u0000${scope}\u0000${scope === 'workspace' ? workspaceId : ''}`
const keyOf = (h: Habit): string => habitKey(h.rule, h.scope, h.workspaceId)

function findLive(store: PersonalStore, profile: string, id: string): Habit {
  const h = live(store, profile).find((x) => x.id === id)
  if (!h) throw new Error('습관을 찾을 수 없습니다.')
  return h
}

/** Habits sent with feedback: the latest-updated HABIT_SENT_MAX that are not superseded. */
export function habitContext(store: PersonalStore, profile: string): Habit[] {
  return live(store, profile).sort(newestFirst).slice(0, HABIT_SENT_MAX)
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

/**
 * Writes the habits the model found in feedback. A known habit (by `same`, else by meaning) gains
 * the source and a count but keeps its status, except a proposal the user explicitly asked for,
 * which turns on. A new one is active when explicit, else a proposal unless HABIT_PROPOSED_MAX
 * proposals are already waiting. `explicit` holds only when a cited turn has an explicit word.
 */
export function applyDetected(
  store: PersonalStore,
  profile: string,
  items: ExtractedHabit[],
  ctx: { questionId: string; workspaceId: string; turns: Question['turns'] }
): void {
  for (const item of items) {
    const now = new Date().toISOString()
    const source: HabitSource = {
      questionId: ctx.questionId,
      turnIds: [...new Set(item.turns.flatMap((i) => ctx.turns[i]?.id ?? []))]
    }
    const explicit =
      item.explicit &&
      item.turns.some((i) => {
        const t = ctx.turns[i]
        return !!t && HABIT_EXPLICIT.test(t.refined || t.raw)
      })
    const workspaceId = item.scope === 'workspace' ? ctx.workspaceId : null
    const habits = live(store, profile)
    const key = habitKey(item.rule, item.scope, workspaceId)
    const known =
      (item.same ? habits.find((h) => h.id === item.same) : undefined) ?? habits.find((h) => keyOf(h) === key)
    if (known) {
      const next: Habit = { ...known, sources: withSource(known.sources, source), count: known.count + 1, updatedAt: now }
      // The user's own lasting request turns a waiting proposal on, still unconfirmed (reviewedAt null).
      if (known.status === 'proposed' && explicit) activate(store, profile, { ...next, origin: 'explicit' })
      else store.put('habit', profile, next)
      continue
    }
    if (!explicit && habits.filter((h) => h.status === 'proposed').length >= HABIT_PROPOSED_MAX) continue
    const habit: Habit = {
      id: randomUUID(),
      rule: item.rule,
      when: item.when,
      scope: item.scope,
      workspaceId,
      status: explicit ? 'active' : 'proposed',
      origin: explicit ? 'explicit' : 'detected',
      sources: [source],
      count: 1,
      replaces: item.replaces,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
      invalidatedAt: null
    }
    if (explicit) activate(store, profile, habit)
    else store.put('habit', profile, habit)
  }
}

const STATUS_ORDER: Record<Habit['status'], number> = { proposed: 0, active: 1, rejected: 2 }

export function listHabits(store: PersonalStore, profile: string): HabitList {
  return {
    enabled: store.settings(profile).answerHabits,
    habits: live(store, profile).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || newestFirst(a, b)),
    workspaces: store.list<Workspace>('workspace', profile).map((w) => ({ id: w.id, name: w.name }))
  }
}

export function decideHabit(store: PersonalStore, profile: string, id: string, decision: 'active' | 'rejected'): void {
  const now = new Date().toISOString()
  const h = { ...findLive(store, profile, id), updatedAt: now, reviewedAt: now }
  if (decision === 'active') activate(store, profile, h)
  else store.put('habit', profile, { ...h, status: 'rejected' })
}

/** A user-written habit: added active, or an existing one's rule, situation and scope edited. */
export function saveHabit(store: PersonalStore, profile: string, input: HabitInput): string {
  function invalid(): never {
    throw new Error('습관 내용이 잘못되었습니다.')
  }
  if (!input || typeof input !== 'object' || typeof input.rule !== 'string' || typeof input.when !== 'string') invalid()
  const rule = input.rule.trim()
  if (!rule || rule.length > RULE_MAX) invalid()
  const when = normalizeWhen(input.when)
  if (input.when.trim() && !when) invalid()
  if (input.scope !== 'profile' && input.scope !== 'workspace') invalid()
  let workspaceId: string | null = null
  if (input.scope === 'workspace') {
    if (typeof input.workspaceId !== 'string') invalid()
    try {
      store.record('workspace', input.workspaceId, profile)
    } catch {
      invalid()
    }
    workspaceId = input.workspaceId
  }
  const id = input.id === undefined ? undefined : String(input.id)
  const key = habitKey(rule, input.scope, workspaceId)
  if (live(store, profile).some((h) => h.id !== id && keyOf(h) === key)) throw new Error('같은 습관이 이미 있습니다.')
  const now = new Date().toISOString()
  if (id !== undefined) {
    const h = findLive(store, profile, id)
    return store.put('habit', profile, { ...h, rule, when, scope: input.scope, workspaceId, updatedAt: now, reviewedAt: now })
  }
  return store.put<Habit>('habit', profile, {
    id: randomUUID(),
    rule,
    when,
    scope: input.scope,
    workspaceId,
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
 * Active habits for an answer in `workspaceId`. Habits are few and short, so all of them go when
 * they fit and the answer model judges the situation from the bracketed keywords. Only a short
 * budget ranks them: up to HABIT_ALWAYS_MAX every-answer rules first, then by keywords found in
 * `text`, count and recency; one that does not fit is skipped for the next.
 */
export function recallHabits(store: PersonalStore, p: { profile: string; workspaceId: string; text: string }): Habit[] {
  const ranked = live(store, p.profile)
    .filter((h) => h.status === 'active' && (h.scope === 'profile' || h.workspaceId === p.workspaceId))
    .map((h) => ({ h, matches: whenMatches(h, p.text) }))
    .sort((a, b) => b.matches - a.matches || b.h.count - a.h.count || newestFirst(a.h, b.h))
  const always = new Set(ranked.filter(({ h }) => !h.when).slice(0, HABIT_ALWAYS_MAX).map(({ h }) => h.id))
  // Array sort is stable: within each tier (first always rules, then the rest) the ranking above holds.
  ranked.sort((a, b) => Number(!always.has(a.h.id)) - Number(!always.has(b.h.id)))
  const out: Habit[] = []
  let used = 0
  for (const { h } of ranked) {
    const size = h.rule.length + h.when.length + 4
    if (used + size > HABIT_PROMPT_CHARS) continue
    used += size
    out.push(h)
  }
  return out
}

/** The active habits as a portable file; a workspace habit names its workspace. */
export function habitFile(store: PersonalStore, profile: string): string {
  const names = new Map(store.list<Workspace>('workspace', profile).map((w) => [w.id, w.name]))
  return JSON.stringify(
    {
      format: 'fask-habits',
      version: 1,
      exportedAt: new Date().toISOString(),
      habits: live(store, profile)
        .filter((h) => h.status === 'active')
        .map((h) => ({
          rule: h.rule,
          when: h.when,
          workspace: h.scope === 'workspace' ? (names.get(h.workspaceId ?? '') ?? null) : null
        }))
    },
    null,
    2
  )
}

/**
 * Adds a habit file's habits as active. A malformed file is rejected whole; an invalid entry,
 * one naming a workspace this profile lacks, or one already present is skipped.
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
  const workspaces = store.list<Workspace>('workspace', profile)
  const keys = new Set(live(store, profile).map(keyOf))
  let added = 0,
    skipped = 0
  store.db.exec('BEGIN')
  try {
    for (const raw of entries as unknown[]) {
      const e = raw as { rule?: unknown; when?: unknown; workspace?: unknown } | null
      const rule = e && typeof e === 'object' && typeof e.rule === 'string' ? e.rule.trim() : ''
      if (!rule || rule.length > RULE_MAX || typeof e?.when !== 'string') {
        skipped++
        continue
      }
      let workspaceId: string | null = null
      if (typeof e.workspace === 'string') {
        const name = normalizeName(e.workspace)
        workspaceId = workspaces.find((w) => normalizeName(w.name) === name)?.id ?? null
        if (!workspaceId) {
          skipped++
          continue
        }
      } else if (e.workspace !== null && e.workspace !== undefined) {
        skipped++
        continue
      }
      const scope: Habit['scope'] = workspaceId ? 'workspace' : 'profile'
      const key = habitKey(rule, scope, workspaceId)
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
        workspaceId,
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
 * Habits of a backup. Absent (older backups): none; not an array: null (corrupt backup). Habits
 * are secondary, so a malformed one, or one scoped to a workspace missing from the backup, is
 * dropped instead of failing the restore; sources keep only questions and turns present, and a
 * `replaces` pointing at a dropped habit becomes null. Duplicate ids keep the first.
 */
export function backupHabits(raw: unknown, workspaceIds: Set<string>, questions: Question[]): Habit[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const turns = new Map(questions.map((q) => [q.id, new Set(q.turns.map((t) => t.id))]))
  const seen = new Set<string>()
  const kept: Habit[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const h = item as Habit
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
      (h.scope !== 'profile' && h.scope !== 'workspace') ||
      (h.scope === 'workspace' && (typeof h.workspaceId !== 'string' || !workspaceIds.has(h.workspaceId))) ||
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
      ...h,
      workspaceId: h.scope === 'workspace' ? h.workspaceId : null,
      sources: h.sources.flatMap((s) => {
        const known = turns.get(s.questionId)
        return known ? [{ questionId: s.questionId, turnIds: s.turnIds.filter((t) => known.has(t)) }] : []
      })
    })
  }
  const ids = new Set(kept.map((h) => h.id))
  return kept.map((h) => (h.replaces && !ids.has(h.replaces) ? { ...h, replaces: null } : h))
}

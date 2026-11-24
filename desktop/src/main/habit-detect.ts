import type { Question, Turn } from '../preload/personal'
import {
  HABIT_FEEDBACK_MAX,
  applyDetected,
  feedbackTurns,
  habitContext,
  type FeedbackTurn,
  type HabitRef
} from './habits'
import { parseHabits } from './knowledge-response'
import type { PersonalStore } from './personal-store'
import { prompt } from './prompts'

/** Job key of the local batch; any other key is a remote question id. */
const LOCAL = '*local'

/**
 * Answer-habit detection, a model call of its own on this PC with this PC's model (never another
 * PC's): only this profile's requests are sent. In a local question those are the turns no linked
 * PC asked (`author.peer` unset); in another PC's question, the turns this profile asked. Local
 * requests are batched across questions: a call runs once HABIT_FEEDBACK_MAX unchecked requests
 * are pending, else once no answer completed for `extractDelaySec`, and leftovers run at startup.
 * Each call holds one project's requests and sees only the profile habits and that project's.
 * The checked-turn watermark is `Question.habitTurns` for local questions and the store's habit
 * marks for remote ones. Jobs run one at a time. Habit data never leaves this PC.
 */
export class HabitDetector {
  /** Remote questions' debounces. */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<void>>()
  /** One follow-up run per key requested while it was running or queued. */
  private readonly again = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private localTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    private readonly deps: {
      store: PersonalStore
      chat: (instruction: string, input: string, signal: AbortSignal) => Promise<string>
      /** Another PC's question visible now, with that PC's profile id. */
      remoteQuestion: (id: string) => { question: Question; owner: string } | undefined
      changed: () => void
    }
  ) {}

  /** (Re)starts a remote question's debounce. */
  schedule(questionId: string, delayMs: number): void {
    if (this.closed) return
    clearTimeout(this.timers.get(questionId))
    const timer = setTimeout(
      () => {
        this.timers.delete(questionId)
        void this.run(questionId)
      },
      Math.max(0, delayMs)
    )
    this.timers.set(questionId, timer)
  }

  /** Runs a scheduled remote question now; nothing when none is scheduled. */
  runNow(questionId: string): void {
    const timer = this.timers.get(questionId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(questionId)
    void this.run(questionId)
  }

  /**
   * Local questions with unchecked requests of this profile: each question's checked range ends
   * at its first running turn.
   */
  pendingLocal(): { q: Question; end: number; turns: FeedbackTurn[] }[] {
    const out: { q: Question; end: number; turns: FeedbackTurn[] }[] = []
    for (const q of this.deps.store.list<Question>('question')) {
      const from = Math.min(q.habitTurns ?? 0, q.turns.length)
      const running = q.turns.findIndex((t, i) => i >= from && t.status === 'running')
      const end = running < 0 ? q.turns.length : running
      const turns = feedbackTurns(q, from, end, localOwn)
      if (turns.length) out.push({ q, end, turns })
    }
    return out
  }

  /**
   * A local answer completed: the batch runs now once HABIT_FEEDBACK_MAX requests are pending,
   * else after `extractDelaySec` without another completion.
   */
  completed(): void {
    const s = this.deps.store.settings()
    if (this.closed || !s.answerHabits) return
    clearTimeout(this.localTimer)
    this.localTimer = undefined
    const total = this.pendingLocal().reduce((n, p) => n + p.turns.length, 0)
    if (total >= HABIT_FEEDBACK_MAX) void this.run(LOCAL)
    else if (total > 0)
      this.localTimer = setTimeout(
        () => {
          this.localTimer = undefined
          void this.run(LOCAL)
        },
        Math.max(0, s.extractDelaySec * 1000)
      )
  }

  /** Startup or profile merge: pending local requests of this profile run now. */
  scanLocal(): void {
    if (this.closed || !this.deps.store.settings().answerHabits || !this.pendingLocal().length) return
    clearTimeout(this.localTimer)
    this.localTimer = undefined
    void this.run(LOCAL)
  }

  /**
   * Remote questions with unchecked requests this profile asked get a debounce unless one is
   * already waiting. Older turns without an author are never this profile's.
   */
  scanRemote(questions: Question[]): void {
    const { store } = this.deps
    const s = store.settings()
    if (this.closed || !s.answerHabits) return
    const own = (t: Turn): boolean => t.author?.profileId === store.active
    for (const q of questions) {
      if (this.timers.has(q.id)) continue
      if (feedbackTurns(q, Math.min(store.habitMark(q.id), q.turns.length), q.turns.length, own).length)
        this.schedule(q.id, s.extractDelaySec * 1000)
    }
  }

  /** Drops scheduled and follow-up runs of the questions (a linked PC's data was purged). */
  forget(questionIds: string[]): void {
    for (const id of questionIds) {
      clearTimeout(this.timers.get(id))
      this.timers.delete(id)
      this.again.delete(id)
    }
  }

  /** Resolves when every running and queued detection has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    clearTimeout(this.localTimer)
    this.localTimer = undefined
    this.again.clear()
  }

  /** Jobs run one after another; a call while a key runs or waits queues exactly one follow-up. */
  private run(key: string): Promise<void> {
    const current = this.running.get(key)
    if (current) {
      this.again.add(key)
      return current
    }
    const job = this.queue
      .then(() => (key === LOCAL ? this.detectLocal() : this.detectRemote(key)))
      .catch(() => {
        /* Locked profile or model failure: the watermark stays; the next completion or scan retries. */
      })
      .finally(() => {
        this.running.delete(key)
        if (this.again.delete(key) && !this.closed) void this.run(key)
      })
    this.queue = job
    this.running.set(key, job)
    return job
  }

  /**
   * The pending local requests, grouped by project (earliest request first), oldest first within a
   * project, HABIT_FEEDBACK_MAX per call. A failed call stops the run; the rest stays unchecked.
   */
  private async detectLocal(): Promise<void> {
    const { store } = this.deps
    const s = store.settings()
    if (this.closed || !s.answerHabits) return
    const owner = store.active
    const pending = this.pendingLocal()
    type Entry = { q: Question; t: FeedbackTurn }
    const groups = new Map<string, Entry[]>()
    for (const { q, turns } of pending)
      for (const t of turns) {
        const group = groups.get(q.projectId)
        if (group) group.push({ q, t })
        else groups.set(q.projectId, [{ q, t }])
      }
    const byTime = (a: Entry, b: Entry): number =>
      a.t.createdAt.localeCompare(b.t.createdAt) || a.q.id.localeCompare(b.q.id) || a.t.index - b.t.index
    const ordered = [...groups]
      .map(([projectId, entries]) => ({ projectId, entries: entries.sort(byTime) }))
      .sort((a, b) => a.entries[0].t.createdAt.localeCompare(b.entries[0].t.createdAt))
    for (const { projectId, entries } of ordered)
      for (let i = 0; i < entries.length; i += HABIT_FEEDBACK_MAX) {
        if (this.closed) return
        const chunk = entries.slice(i, i + HABIT_FEEDBACK_MAX)
        await this.ask(
          chunk.map(({ q, t }) => ({ questionId: q.id, t })),
          { owner, id: projectId },
          s.promptLanguage
        )
        const checked = new Map<string, number>()
        for (const { q, t } of chunk) checked.set(q.id, Math.max(checked.get(q.id) ?? 0, t.index + 1))
        for (const [id, upTo] of checked) this.markLocal(id, upTo)
        this.deps.changed()
      }
    for (const { q, end } of pending) this.markLocal(q.id, end)
  }

  /** Another PC's question: this profile's requests in it, HABIT_FEEDBACK_MAX per call. */
  private async detectRemote(questionId: string): Promise<void> {
    const { store } = this.deps
    const s = store.settings()
    if (this.closed || !s.answerHabits) return
    const found = this.deps.remoteQuestion(questionId)
    if (!found) return
    const { question: q, owner } = found
    const from = Math.min(store.habitMark(questionId), q.turns.length)
    const running = q.turns.findIndex((t, i) => i >= from && t.status === 'running')
    const end = running < 0 ? q.turns.length : running
    const turns = feedbackTurns(q, from, end, (t) => t.author?.profileId === store.active)
    for (let i = 0; i < turns.length; i += HABIT_FEEDBACK_MAX) {
      if (this.closed) return
      const chunk = turns.slice(i, i + HABIT_FEEDBACK_MAX)
      // Habits belong to the project the request was made in, even if the question moved since.
      await this.ask(
        chunk.map((t) => ({ questionId, t })),
        { owner, id: q.projectId },
        s.promptLanguage
      )
      const upTo = chunk[chunk.length - 1].index + 1
      if (store.habitMark(questionId) < upTo) store.setHabitMark(questionId, upTo)
    }
    if (store.habitMark(questionId) < end) store.setHabitMark(questionId, end)
    if (turns.length) this.deps.changed()
  }

  /**
   * One model call over requests of one project, numbered 0..n-1 in order; `conversation` numbers
   * the distinct questions in first-appearance order.
   */
  private async ask(
    chunk: { questionId: string; t: FeedbackTurn }[],
    project: { owner: string; id: string },
    lang: Parameters<typeof prompt>[0]
  ): Promise<void> {
    const { store } = this.deps
    const conversations: string[] = []
    const refs = new Map<number, HabitRef>()
    const feedback = chunk.map(({ questionId, t }, n) => {
      if (!conversations.includes(questionId)) conversations.push(questionId)
      refs.set(n, { questionId, turnId: t.turnId, project })
      return {
        turn: n,
        conversation: conversations.indexOf(questionId),
        question: t.question,
        previousAnswer: t.previousAnswer
      }
    })
    // Recomputed per call so a habit an earlier call created is matched, not created twice.
    const sent = habitContext(store, store.active, project)
    const input = JSON.stringify({
      feedback,
      habits: sent.map(({ id, rule, when, status, scope, overrides }) => ({ id, rule, when, status, scope, overrides }))
    })
    const text = await this.deps.chat(prompt(lang, 'habits'), input, AbortSignal.timeout(120000))
    applyDetected(store, store.active, parseHabits(text, new Set(sent.map((h) => h.id)), new Set(refs.keys())), refs)
  }

  /** Raises a local question's checked-turn watermark to `upTo`. */
  private markLocal(questionId: string, upTo: number): void {
    const { store } = this.deps
    const q = store.record<Question>('question', questionId)
    if ((q.habitTurns ?? 0) < upTo) store.put('question', store.active, { ...q, habitTurns: upTo })
  }
}

/** A local question's turn this profile asked: not one a linked PC asked. */
const localOwn = (t: Turn): boolean => !t.author?.peer

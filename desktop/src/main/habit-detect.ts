import type { Question, Turn } from '../preload/personal'
import { applyDetected, feedbackTurns, habitContext } from './habits'
import { parseHabits } from './knowledge-response'
import type { PersonalStore } from './personal-store'
import { prompt } from './prompts'

/**
 * Answer-habit detection, a model call of its own on this PC with this PC's model (never another
 * PC's): only this profile's turns are feedback. In a local question those are the turns no
 * linked PC asked (`author.peer` unset); in another PC's question, the turns this profile asked.
 * The checked-turn watermark is `Question.habitTurns` for local questions and the store's habit
 * marks for remote ones. Habit data never leaves this PC.
 */
export class HabitDetector {
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; remote: boolean }>()
  private readonly running = new Map<string, Promise<void>>()
  /** One follow-up run per question requested while it was running; the value is `remote`. */
  private readonly again = new Map<string, boolean>()
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

  /** (Re)starts the question's debounce. */
  schedule(questionId: string, remote: boolean, delayMs: number): void {
    if (this.closed) return
    clearTimeout(this.timers.get(questionId)?.timer)
    const timer = setTimeout(
      () => {
        this.timers.delete(questionId)
        void this.run(questionId, remote)
      },
      Math.max(0, delayMs)
    )
    this.timers.set(questionId, { timer, remote })
  }

  /** Runs a scheduled question now; nothing when none is scheduled. */
  runNow(questionId: string): void {
    const pending = this.timers.get(questionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.timers.delete(questionId)
    void this.run(questionId, pending.remote)
  }

  /** Startup: local questions with unchecked feedback of this profile run now. */
  scanLocal(): void {
    const { store } = this.deps
    if (this.closed || !store.settings().answerHabits) return
    for (const q of store.list<Question>('question'))
      if (feedbackTurns(q, Math.min(q.habitTurns ?? 0, q.turns.length), q.turns.length, localOwn).length)
        this.schedule(q.id, false, 0)
  }

  /**
   * Remote questions with unchecked feedback this profile asked get a debounce unless one is
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
        this.schedule(q.id, true, s.extractDelaySec * 1000)
    }
  }

  /** Drops scheduled and follow-up runs of the questions (a linked PC's data was purged). */
  forget(questionIds: string[]): void {
    for (const id of questionIds) {
      clearTimeout(this.timers.get(id)?.timer)
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
    for (const { timer } of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.again.clear()
  }

  /** One run per question at a time; a call during a run queues exactly one follow-up. */
  private run(questionId: string, remote: boolean): Promise<void> {
    const current = this.running.get(questionId)
    if (current) {
      this.again.set(questionId, remote)
      return current
    }
    const job = this.detect(questionId, remote)
      .catch(() => {
        /* Locked profile or model failure: the watermark stays; the next completion or scan retries. */
      })
      .finally(() => {
        this.running.delete(questionId)
        const next = this.again.get(questionId)
        this.again.delete(questionId)
        if (next !== undefined && !this.closed) void this.run(questionId, next)
      })
    this.running.set(questionId, job)
    return job
  }

  private async detect(questionId: string, remote: boolean): Promise<void> {
    const { store } = this.deps
    const s = store.settings()
    if (!s.answerHabits) return
    let q: Question
    let owner: string
    if (remote) {
      const found = this.deps.remoteQuestion(questionId)
      if (!found) return
      q = found.question
      owner = found.owner
    } else {
      q = store.record<Question>('question', questionId)
      owner = store.active
    }
    const from = Math.min(remote ? store.habitMark(questionId) : (q.habitTurns ?? 0), q.turns.length)
    const running = q.turns.findIndex((t, i) => i >= from && t.status === 'running')
    const end = running < 0 ? q.turns.length : running
    const own = remote ? (t: Turn): boolean => t.author?.profileId === store.active : localOwn
    const feedback = feedbackTurns(q, from, end, own)
    if (feedback.length) {
      const sent = habitContext(store, store.active)
      const input = JSON.stringify({
        feedback,
        habits: sent.map(({ id, rule, when, status, scope, overrides }) => ({ id, rule, when, status, scope, overrides }))
      })
      const text = await this.deps.chat(prompt(s.promptLanguage, 'habits'), input, AbortSignal.timeout(120000))
      // Habits belong to the project the feedback was given in, even if the question moved since.
      applyDetected(
        store,
        store.active,
        parseHabits(text, new Set(sent.map((h) => h.id)), new Set(feedback.map((f) => f.turn))),
        { questionId, project: { owner, id: q.projectId }, turns: q.turns }
      )
    }
    if (remote) {
      if (store.habitMark(questionId) < end) store.setHabitMark(questionId, end)
    } else {
      const fresh = store.record<Question>('question', questionId)
      if ((fresh.habitTurns ?? 0) < end) store.put('question', store.active, { ...fresh, habitTurns: end })
    }
    if (feedback.length) this.deps.changed()
  }
}

/** A local question's turn this profile asked: not one a linked PC asked. */
const localOwn = (t: Turn): boolean => !t.author?.peer

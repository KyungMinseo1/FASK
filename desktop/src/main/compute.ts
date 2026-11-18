// Delegated compute: the PC that owns a workspace (H) builds prompts and stores results, while the
// PC that asked (C) runs every model and Jev call with its own keys. H → C requests travel on the
// SSE `/events` stream, C → H replies on the `compute-reply` RPC.
//
// Security boundary:
// - C runs only requests carrying a ticket it issued for work it started, within the ticket's op
//   kinds, counts, input budget, pinned model and question binding. H never chooses a URL, header
//   or (for answers) model, so it cannot point C's keys anywhere else.
// - H accepts only text and a re-validated Jev response back, and parses them before storing.
// Prompts, responses, keys and tickets are never logged.
import { randomBytes, randomUUID } from 'node:crypto'
import type { ReasoningEffort } from '../preload/personal'
import type { JevCall, JevQuestion, JevRequest, JevResponse } from './jev-api'
import type { WireMessage } from './local-api'

export type Executor = { kind: 'local' } | { kind: 'peer'; peerId: string; ticket: string }
export const LOCAL: Executor = { kind: 'local' }
export type ComputeOp =
  | { kind: 'chat'; role: 'fast' | 'organize'; messages: WireMessage[] }
  | { kind: 'stream'; model: string; messages: WireMessage[]; reasoningEffort?: ReasoningEffort }
  | { kind: 'jev'; request: JevRequest }
export interface ComputeRequest {
  id: string
  ticket: string
  op: ComputeOp
}
type ReplyBody =
  | { ack: true }
  | { delta: string; actualModel?: string }
  | { done: true; text?: string; response?: JevResponse }
  | { error: string }
export type ComputeReply = { id: string; seq: number } & ReplyBody
export type TicketKind = 'ask' | 'extract' | 'tidy'

export const COMPUTE_UNREACHABLE = '요청한 PC에 연결할 수 없습니다.'
export const COMPUTE_TIMEOUT = '요청한 PC가 응답하지 않습니다.'
export const COMPUTE_DENIED = '허용되지 않은 계산 요청입니다.'
export const COMPUTE_BUSY = '요청한 PC가 바쁩니다. 잠시 후 다시 시도해 주세요.'
export const COMPUTE_TOO_LARGE = '요청한 PC의 응답이 너무 큽니다.'
export const PEER_OUTDATED = '연결된 PC를 최신 버전으로 업데이트해 주세요.'
export const SHARE_REVOKED = '공유가 해제되어 작업을 중단했습니다.'
const CANCELLED = '요청을 취소했습니다.'
const EMPTY_JEV_KEY = 'Jev API 키를 설정해 주세요.'
const BAD_JEV = 'Jev 응답 형식이 잘못되었습니다.'

export const TICKET = /^[A-Za-z0-9_-]{24}$/
export const REQUEST_ID = /^[0-9a-f-]{36}$/
/** Text total of one request, and accumulated text of one reply. */
export const MAX_TEXT_CHARS = 1_000_000
/** One image data URL. */
export const MAX_IMAGE_CHARS = 20_000_000
/** `JSON.stringify(request)` of one Jev request. */
export const MAX_JEV_CHARS = 500_000
export const MAX_RUNNING_PER_PEER = 6

const MAX_MESSAGES = 40
const MAX_PARTS = 64
const MAX_JEV_QUESTIONS = 100
const MAX_ERROR_CHARS = 300
const ACK_MS = 15_000
const IDLE_MS = 200_000
const DELTA_BATCH_MS = 100
const IMAGE_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/
const ROLES = new Set(['system', 'user', 'assistant'])
const EFFORTS = new Set(['low', 'medium', 'high'])

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Rebuilds model messages from untrusted input; null on any violation. */
export function sanitizeMessages(v: unknown): WireMessage[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_MESSAGES) return null
  let text = 0
  let images = 0
  const out: WireMessage[] = []
  for (const m of v) {
    if (!isObject(m) || typeof m.role !== 'string' || !ROLES.has(m.role)) return null
    const role = m.role as WireMessage['role']
    if (typeof m.content === 'string') {
      text += m.content.length
      out.push({ role, content: m.content })
    } else if (Array.isArray(m.content) && m.content.length >= 1 && m.content.length <= MAX_PARTS) {
      const parts: Exclude<WireMessage['content'], string> = []
      for (const p of m.content) {
        if (!isObject(p)) return null
        if (p.type === 'text' && typeof p.text === 'string') {
          text += p.text.length
          parts.push({ type: 'text', text: p.text })
        } else if (p.type === 'image_url' && isObject(p.image_url) && typeof p.image_url.url === 'string') {
          const url = p.image_url.url
          if (++images > 1 || url.length > MAX_IMAGE_CHARS || !IMAGE_URL.test(url)) return null
          parts.push({ type: 'image_url', image_url: { url } })
        } else return null
      }
      out.push({ role, content: parts })
    } else return null
    if (text > MAX_TEXT_CHARS) return null
  }
  return out
}

function stringRecord(v: unknown, min: number): Record<string, string> | null {
  if (!isObject(v)) return null
  const entries = Object.entries(v)
  if (entries.length < min || entries.some(([, s]) => typeof s !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

/** Rebuilds a Jev request as `{ state, questions }` only (drops `model` and any other key); null on violation. */
export function sanitizeJevRequest(v: unknown): JevRequest | null {
  if (!isObject(v) || !isObject(v.questions)) return null
  const entries = Object.entries(v.questions)
  if (entries.length < 1 || entries.length > MAX_JEV_QUESTIONS) return null
  const questions: [string, JevQuestion][] = []
  for (const [name, q] of entries) {
    if (!isObject(q) || typeof q.instructions !== 'string') return null
    if (q.type === 'noul') {
      if (q.criteria === undefined) questions.push([name, { type: 'noul', instructions: q.instructions }])
      else {
        if (!isObject(q.criteria)) return null
        const { true: yes, false: no } = q.criteria
        if ((yes !== undefined && typeof yes !== 'string') || (no !== undefined && typeof no !== 'string')) return null
        questions.push([
          name,
          {
            type: 'noul',
            instructions: q.instructions,
            criteria: { ...(yes !== undefined ? { true: yes } : {}), ...(no !== undefined ? { false: no } : {}) }
          }
        ])
      }
    } else if (q.type === 'choice') {
      const criteria = stringRecord(q.criteria, 1)
      if (!criteria) return null
      questions.push([name, { type: 'choice', instructions: q.instructions, criteria }])
    } else return null
  }
  const request: JevRequest = { state: v.state, questions: Object.fromEntries(questions) }
  let size: number
  try {
    size = JSON.stringify(request).length
  } catch {
    return null
  }
  return size <= MAX_JEV_CHARS ? request : null
}

function messageChars(messages: WireMessage[]): number {
  let n = 0
  for (const m of messages)
    if (typeof m.content === 'string') n += m.content.length
    else for (const p of m.content) if (p.type === 'text') n += p.text?.length ?? 0
  return n
}

function lastUserText(messages: WireMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    return typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n')
  }
  return ''
}

type Pending = {
  peerId: string
  op: ComputeOp
  seq: number
  text: string
  timer: NodeJS.Timeout
  onDelta?: (delta: string, actualModel?: string) => void
  resolve: (r: { text: string; response?: JevResponse }) => void
  reject: (e: Error) => void
  detach: () => void
}

/** H side: sends compute requests to the PC that asked and collects its replies. */
export class ComputeBroker {
  private pending = new Map<string, Pending>()

  constructor(
    private send: (peerId: string, event: 'compute' | 'compute-cancel', data: unknown) => boolean,
    private validJev: (body: unknown, request: JevRequest) => boolean
  ) {}

  run(
    executor: Extract<Executor, { kind: 'peer' }>,
    op: ComputeOp,
    signal: AbortSignal,
    onDelta?: (delta: string, actualModel?: string) => void
  ): Promise<{ text: string; response?: JevResponse }> {
    if (signal.aborted) return Promise.reject(new Error(CANCELLED))
    const id = randomUUID()
    const { peerId, ticket } = executor
    const { promise, resolve, reject } = Promise.withResolvers<{ text: string; response?: JevResponse }>()
    const request: ComputeRequest = { id, ticket, op }
    if (!this.send(peerId, 'compute', request)) return Promise.reject(new Error(COMPUTE_UNREACHABLE))
    const abort = (): void => this.cancel(id, CANCELLED)
    signal.addEventListener('abort', abort, { once: true })
    this.pending.set(id, {
      peerId,
      op,
      seq: 0,
      text: '',
      timer: setTimeout(() => this.cancel(id, COMPUTE_UNREACHABLE), ACK_MS),
      onDelta,
      resolve,
      reject,
      detach: () => signal.removeEventListener('abort', abort)
    })
    return promise
  }

  /** Handles one `compute-reply` from an authenticated PC; anything malformed, foreign or replayed is ignored. */
  reply(peerId: string, raw: unknown): void {
    if (!isObject(raw) || typeof raw.id !== 'string' || !REQUEST_ID.test(raw.id)) return
    if (typeof raw.seq !== 'number' || !Number.isSafeInteger(raw.seq)) return
    const entry = this.pending.get(raw.id)
    if (!entry || entry.peerId !== peerId || raw.seq <= entry.seq) return
    const id = raw.id
    const shaped =
      raw.ack === true ||
      (typeof raw.delta === 'string' && (raw.actualModel === undefined || typeof raw.actualModel === 'string')) ||
      (raw.done === true && (raw.text === undefined || typeof raw.text === 'string')) ||
      typeof raw.error === 'string'
    if (!shaped) return
    entry.seq = raw.seq
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.cancel(id, COMPUTE_TIMEOUT), IDLE_MS)
    if (typeof raw.delta === 'string') {
      entry.text += raw.delta
      if (entry.text.length > MAX_TEXT_CHARS) return this.cancel(id, COMPUTE_TOO_LARGE)
      entry.onDelta?.(raw.delta, raw.actualModel as string | undefined)
    } else if (raw.done === true) {
      if (entry.op.kind === 'jev') {
        if (!this.validJev(raw.response, entry.op.request)) return this.finish(id, new Error(BAD_JEV))
        return this.finish(id, null, { text: '', response: raw.response as JevResponse })
      }
      const text = typeof raw.text === 'string' ? raw.text : entry.text
      if (text.length > MAX_TEXT_CHARS) return this.finish(id, new Error(COMPUTE_TOO_LARGE))
      this.finish(id, null, { text })
    } else if (typeof raw.error === 'string') this.finish(id, new Error(raw.error.slice(0, MAX_ERROR_CHARS)))
  }

  dropPeer(peerId: string): void {
    for (const [id, entry] of this.pending) if (entry.peerId === peerId) this.finish(id, new Error(COMPUTE_UNREACHABLE))
  }

  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, new Error(COMPUTE_UNREACHABLE))
  }

  /** Tells the PC to stop, then fails the request locally. */
  private cancel(id: string, message: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.send(entry.peerId, 'compute-cancel', { id })
    this.finish(id, new Error(message))
  }

  private finish(id: string, error: Error | null, result?: { text: string; response?: JevResponse }): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.detach()
    if (error) entry.reject(error)
    else entry.resolve(result!)
  }
}

type Ticket = {
  peerId: string
  kind: TicketKind
  expires: number
  model?: string
  question?: string
  used: { stream: number; fast: number; organize: number; jev: number }
  inputChars: number
  seen: Set<string>
}

type Limits = { ttl: number; stream: number; fast: number; organize: number; jev: number; input: number }
const LIMITS: Record<TicketKind, Limits> = {
  ask: { ttl: 15 * 60_000, stream: 1, fast: 2, organize: 0, jev: 64, input: 2_000_000 },
  extract: { ttl: 10 * 60_000, stream: 0, fast: 0, organize: 1, jev: 0, input: 1_000_000 },
  tidy: { ttl: 60 * 60_000, stream: 0, fast: 0, organize: 500, jev: 0, input: 10_000_000 }
}

type Running = { peerId: string; ticket: string; controller: AbortController }

/** C side: runs compute requests from a host, only within tickets this PC issued. */
export class ComputeRunner {
  private tickets = new Map<string, Ticket>()
  private running = new Map<string, Running>()

  constructor(
    private deps: {
      chat(role: 'fast' | 'organize', messages: WireMessage[], signal: AbortSignal): Promise<string>
      stream(
        model: string,
        messages: WireMessage[],
        effort: ReasoningEffort | undefined,
        signal: AbortSignal,
        delta: (d: string, m?: string) => void
      ): Promise<void>
      jev(): JevCall | undefined
      reply(peerId: string, reply: ComputeReply): Promise<void>
    },
    private now = Date.now
  ) {}

  issue(peerId: string, kind: TicketKind, bind?: { model: string; question: string }): string {
    this.sweep()
    const ticket = randomBytes(18).toString('base64url')
    this.tickets.set(ticket, {
      peerId,
      kind,
      expires: this.now() + LIMITS[kind].ttl,
      ...(bind ? { model: bind.model, question: bind.question } : {}),
      used: { stream: 0, fast: 0, organize: 0, jev: 0 },
      inputChars: 0,
      seen: new Set()
    })
    return ticket
  }

  expireSoon(ticket: string, ms: number): void {
    const t = this.tickets.get(ticket)
    if (t) t.expires = Math.min(t.expires, this.now() + ms)
  }

  revoke(ticket: string): void {
    this.tickets.delete(ticket)
    for (const [key, r] of this.running) if (r.ticket === ticket) this.stop(key)
  }

  dropPeer(peerId: string): void {
    for (const [ticket, t] of this.tickets) if (t.peerId === peerId) this.revoke(ticket)
    for (const [key, r] of this.running) if (r.peerId === peerId) this.stop(key)
  }

  abortAll(): void {
    for (const key of [...this.running.keys()]) this.stop(key)
  }

  cancel(peerId: string, raw: unknown): void {
    if (!isObject(raw) || typeof raw.id !== 'string') return
    this.stop(`${peerId}\u0000${raw.id}`)
  }

  handle(peerId: string, raw: unknown): void {
    if (!isObject(raw) || typeof raw.id !== 'string' || raw.id.length > 100) return
    const id = raw.id
    let seq = 0
    let chain = Promise.resolve()
    const send = (body: ReplyBody): void => {
      const reply: ComputeReply = { id, seq: ++seq, ...body }
      chain = chain.then(() => this.deps.reply(peerId, reply)).catch(() => {})
    }
    const deny = (message = COMPUTE_DENIED): void => send({ error: message })

    const ticketId = typeof raw.ticket === 'string' ? raw.ticket : ''
    const ticket = this.tickets.get(ticketId)
    if (!REQUEST_ID.test(id) || !ticket || ticket.peerId !== peerId || this.now() >= ticket.expires) return deny()
    // A retransmission or a duplicate while two event streams overlap: never run or bill twice.
    if (ticket.seen.has(id)) return
    ticket.seen.add(id)
    let count = 0
    for (const r of this.running.values()) if (r.peerId === peerId) count++
    if (count >= MAX_RUNNING_PER_PEER) return deny(COMPUTE_BUSY)

    const prepared = this.check(ticket, raw.op)
    if (!prepared) return deny()
    const limits = LIMITS[ticket.kind]
    if (ticket.inputChars + prepared.chars > limits.input) return deny()
    ticket.inputChars += prepared.chars
    ticket.used[prepared.slot]++

    const key = `${peerId}\u0000${id}`
    const controller = new AbortController()
    this.running.set(key, { peerId, ticket: ticketId, controller })
    send({ ack: true })
    void this.execute(prepared.op, controller.signal, send).finally(() => {
      if (this.running.get(key)?.controller === controller) this.running.delete(key)
    })
  }

  /** Validates an op against the ticket; returns the sanitized op, its budget slot and input size. */
  private check(
    ticket: Ticket,
    raw: unknown
  ): { op: ComputeOp; slot: keyof Ticket['used']; chars: number } | null {
    if (!isObject(raw)) return null
    const limits = LIMITS[ticket.kind]
    const question = ticket.kind === 'ask' ? (ticket.question ?? '').trim().slice(0, 200) : ''
    if (raw.kind === 'chat') {
      if (raw.role !== 'fast' && raw.role !== 'organize') return null
      const role = raw.role
      if (ticket.used[role] >= limits[role]) return null
      const messages = sanitizeMessages(raw.messages)
      if (!messages) return null
      if (question && role === 'fast' && !lastUserText(messages).includes(question)) return null
      return { op: { kind: 'chat', role, messages }, slot: role, chars: messageChars(messages) }
    }
    if (raw.kind === 'stream') {
      if (ticket.used.stream >= limits.stream || typeof raw.model !== 'string' || raw.model !== ticket.model) return null
      const messages = sanitizeMessages(raw.messages)
      if (!messages) return null
      if (question && !lastUserText(messages).includes(question)) return null
      const effort =
        typeof raw.reasoningEffort === 'string' && EFFORTS.has(raw.reasoningEffort)
          ? (raw.reasoningEffort as ReasoningEffort)
          : undefined
      return {
        op: { kind: 'stream', model: raw.model, messages, ...(effort ? { reasoningEffort: effort } : {}) },
        slot: 'stream',
        chars: messageChars(messages)
      }
    }
    if (raw.kind === 'jev') {
      if (ticket.used.jev >= limits.jev) return null
      const request = sanitizeJevRequest(raw.request)
      if (!request) return null
      if (question) {
        const query = isObject(request.state) ? request.state.query : undefined
        if (typeof query !== 'string' || !query.includes(question)) return null
      }
      return { op: { kind: 'jev', request }, slot: 'jev', chars: JSON.stringify(request).length }
    }
    return null
  }

  private async execute(op: ComputeOp, signal: AbortSignal, send: (body: ReplyBody) => void): Promise<void> {
    let pending = ''
    let model: string | undefined
    let timer: NodeJS.Timeout | null = null
    const flush = (): void => {
      clearTimeout(timer ?? undefined)
      timer = null
      if (!pending || signal.aborted) return
      send({ delta: pending, ...(model ? { actualModel: model } : {}) })
      pending = ''
    }
    try {
      if (op.kind === 'chat') {
        const text = await this.deps.chat(op.role, op.messages, signal)
        if (signal.aborted) throw new Error(CANCELLED)
        send({ done: true, text })
      } else if (op.kind === 'stream') {
        await this.deps.stream(op.model, op.messages, op.reasoningEffort, signal, (d, m) => {
          if (signal.aborted) return
          pending += d
          if (m) model = m
          timer ??= setTimeout(flush, DELTA_BATCH_MS)
        })
        if (signal.aborted) throw new Error(CANCELLED)
        flush()
        send({ done: true })
      } else {
        const call = this.deps.jev()
        if (!call) throw new Error(EMPTY_JEV_KEY)
        const response = await call(op.request, signal)
        if (signal.aborted) throw new Error(CANCELLED)
        send({ done: true, response })
      }
    } catch (e) {
      clearTimeout(timer ?? undefined)
      const message = signal.aborted ? CANCELLED : e instanceof Error && e.message ? e.message : COMPUTE_UNREACHABLE
      send({ error: message.slice(0, MAX_ERROR_CHARS) })
    }
  }

  private stop(key: string): void {
    const r = this.running.get(key)
    if (!r) return
    this.running.delete(key)
    r.controller.abort(new Error(CANCELLED))
  }

  private sweep(): void {
    const now = this.now()
    for (const [ticket, t] of this.tickets) if (now >= t.expires) this.tickets.delete(ticket)
  }
}

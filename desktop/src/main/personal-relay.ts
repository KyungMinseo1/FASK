// Relay path for the mobile hub: the PC registers with a blind byte relay and serves each phone
// connection it announces as a byte stream carrying the hub's own end-to-end TLS session.
import { createHash } from 'node:crypto'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'

export type RelayState = 'off' | 'connecting' | 'online' | 'error'

/** Credit window per direction: a sender keeps at most this many DATA payload bytes unacked. */
export const RELAY_WINDOW = 262144
export const RELAY_CHUNK = 16384
export const RELAY_ACK_EVERY = 65536

const DATA = Buffer.from([0])
const ACK = 1
const PAIR_ID = /^[A-Za-z0-9_-]{22}$/
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
const PING_MS = 30000
const PONG_DEADLINE_MS = 70000

export const RELAY_REPLACED =
  '다른 PC가 같은 중계 연결을 사용하고 있습니다. 이 PC로 전환하려면 모바일 연결을 껐다 켜세요.'
const RELAY_BAD_URL = '중계 서버 주소를 확인하세요.'
const RELAY_RETRYING = '중계 서버에 연결할 수 없습니다. 다시 시도하는 중입니다.'

/** The relay room is derived from the host key, so only the room is shared through the QR. */
export function relayRoom(key: string): string {
  return createHash('sha256').update(key).digest('base64url')
}

/** `wss://host[:port]`, or `ws://` for loopback development relays; anything else is rejected. */
export function normalizeRelayUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) return null
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  return `${url.protocol}//${url.host}`
}

/**
 * One relayed connection as a byte stream. DATA = 0x00 + payload, ACK = 0x01 + uint32 BE credit.
 * Outbound bytes wait for credit; inbound bytes are credited only once the reader has consumed them.
 */
export class RelayStream extends Duplex {
  private sent = 0
  private peakUnacked = 0
  private biggestFrame = 0
  private received = 0
  private acked = 0
  private parked: (() => void) | null = null

  constructor(private ws: WebSocket) {
    super({ readableHighWaterMark: 65536, writableHighWaterMark: 65536, allowHalfOpen: false })
    ws.on('message', (data, isBinary) => this.frame(data, isBinary))
    ws.on('close', () => {
      this.push(null)
      this.destroy()
    })
    ws.on('error', (err) => this.destroy(err))
  }

  get unacked(): number {
    return this.sent
  }
  get maxUnacked(): number {
    return this.peakUnacked
  }
  get maxFrameSent(): number {
    return this.biggestFrame
  }

  private violate(): void {
    this.ws.close(4400, 'protocol')
    this.destroy(new Error('relay protocol'))
  }

  private frame(data: WebSocket.RawData, isBinary: boolean): void {
    if (!isBinary) return this.violate()
    const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (frame[0] === DATA[0] && frame.length > 1) {
      this.received += frame.length - 1
      if (this.received - this.acked > RELAY_WINDOW) return this.violate()
      this.push(frame.subarray(1))
      this.credit()
    } else if (frame[0] === ACK && frame.length === 5) {
      const n = frame.readUInt32BE(1)
      if (n < 1 || n > this.sent) return this.violate()
      this.sent -= n
      const parked = this.parked
      this.parked = null
      parked?.()
    } else this.violate()
  }

  /** Acks what the reader has taken out of the readable buffer, in batches of RELAY_ACK_EVERY. */
  private credit(): void {
    const consumed = this.received - this.readableLength - this.acked
    if (consumed < RELAY_ACK_EVERY || this.ws.readyState !== WebSocket.OPEN) return
    this.acked += consumed
    const ack = Buffer.alloc(5)
    ack[0] = ACK
    ack.writeUInt32BE(consumed, 1)
    this.ws.send(ack, (err) => err && this.destroy(err))
  }

  override _read(): void {
    this.credit()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let offset = 0
    const next = (): void => {
      while (offset < chunk.length) {
        const n = Math.min(RELAY_CHUNK, chunk.length - offset)
        if (this.sent + n > RELAY_WINDOW) {
          this.parked = next
          return
        }
        const slice = chunk.subarray(offset, offset + n)
        offset += n
        this.sent += n
        this.peakUnacked = Math.max(this.peakUnacked, this.sent)
        this.biggestFrame = Math.max(this.biggestFrame, n + 1)
        this.ws.send(Buffer.concat([DATA, slice]), (err) => err && this.destroy(err))
      }
      callback()
    }
    next()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.ws.close(1000)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.parked = null
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate()
    callback(error)
  }
}

/** Keeps the PC registered as the relay host and turns every announced phone connection into a stream. */
export class HubRelay {
  private control: WebSocket | null = null
  private dataSockets = new Set<WebSocket>()
  private retry: NodeJS.Timeout | null = null
  private pinger: NodeJS.Timeout | null = null
  private attempt = 0
  private url = ''
  private key = ''
  private currentState: RelayState = 'off'
  private currentError = ''

  constructor(private accept: (stream: Duplex) => void) {}

  get state(): RelayState {
    return this.currentState
  }
  get error(): string {
    return this.currentError
  }

  start(url: string, key: string): void {
    this.stop()
    this.url = url
    this.key = key
    this.attempt = 0
    this.currentState = 'connecting'
    this.connect()
  }

  stop(): void {
    clearTimeout(this.retry ?? undefined)
    clearInterval(this.pinger ?? undefined)
    this.retry = this.pinger = null
    const sockets = [...this.dataSockets]
    if (this.control) sockets.push(this.control)
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'host stopped')
      else ws.terminate()
    }
    this.control = null
    this.dataSockets.clear()
    this.currentState = 'off'
    this.currentError = ''
  }

  private connect(): void {
    const headers = { Authorization: `Bearer ${this.key}` }
    const ws = new WebSocket(`${this.url}/v1/host`, { headers, maxPayload: 65536, perMessageDeflate: false })
    this.control = ws
    let lastSeen = Date.now()
    let failure = RELAY_RETRYING
    ws.on('error', () => {})
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      if (status >= 400 && status < 500 && status !== 429) failure = RELAY_BAD_URL
      ws.terminate()
    })
    ws.on('open', () => {
      if (ws !== this.control) return
      this.currentState = 'online'
      this.currentError = ''
      this.attempt = 0
      lastSeen = Date.now()
      this.pinger = setInterval(() => {
        if (Date.now() - lastSeen > PONG_DEADLINE_MS) ws.terminate()
        else ws.ping()
      }, PING_MS)
    })
    ws.on('pong', () => (lastSeen = Date.now()))
    ws.on('message', (data, isBinary) => {
      if (!isBinary && ws === this.control) this.open(String(data), headers)
    })
    ws.on('close', (code) => {
      if (ws !== this.control) return
      clearInterval(this.pinger ?? undefined)
      this.pinger = null
      this.control = null
      this.currentState = 'error'
      if (code === 4001) {
        this.currentError = RELAY_REPLACED
        return
      }
      this.currentError = failure
      this.retry = setTimeout(() => this.connect(), BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)])
    })
  }

  private open(text: string, headers: Record<string, string>): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message && message.type === 'open') ||
      !('id' in message && typeof message.id === 'string' && PAIR_ID.test(message.id))
    )
      return
    // TLS ciphertext does not compress; deflate would only grow full frames past maxPayload.
    const ws = new WebSocket(`${this.url}/v1/accept/${message.id}`, {
      headers,
      maxPayload: 16385,
      perMessageDeflate: false
    })
    this.dataSockets.add(ws)
    ws.on('error', () => {})
    ws.on('close', () => this.dataSockets.delete(ws))
    ws.once('open', () => this.accept(new RelayStream(ws)))
  }
}

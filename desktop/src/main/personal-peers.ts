// Client side of a linked PC: pinned TLS to its hub over Tailscale or the relay, RPC + SSE forwarding.
// Host data is never stored here; the last snapshot is kept in memory only.
import { createHash, X509Certificate } from 'node:crypto'
import { Agent, request, type ClientRequest, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import WebSocket from 'ws'
import { RelayStream, relayRoom } from './personal-relay'
import {
  PAIR_CERT_CHANGED,
  pairRelayKey,
  runPairClient,
  normalizePairCode,
  type PairPost
} from '../shared/pair-code'
import type { Snapshot, StreamEvent, PeerStatus } from '../preload/personal'

export const HUB_PORT = 47615
export interface PeerLink {
  id: string
  name: string
  fingerprint: string
  certPem: string
  token: string
  addresses: string[]
  relay: { url: string; room: string } | null
}
export type DialTarget =
  | { kind: 'direct'; address: string; port?: number }
  | { kind: 'relay'; url: string; room: string }
  | { kind: 'stream'; stream: Duplex }

export const PEER_OFFLINE = '외부 PC가 오프라인입니다.'
export const PEER_UNREACHABLE = '외부 PC에 연결할 수 없습니다.'
export const PEER_REVOKED = '외부 PC에서 연결이 해제되었습니다.'
export const PEER_BLOCKED = '상대 PC 인증서가 바뀌었습니다. 다시 연결해 주세요.'
const RELAY_BUSY = '릴레이 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
const RELAY_READY_MS = 15_000
const DIAL_MS = 8_000
const RPC_MS = 15_000
const RELAY_STAGGER_MS = 2_000
const PROBE_MS = 30_000
const RETRY_MS = [1000, 2000, 5000, 10000]

const fingerprintOf = (raw: Buffer): string => createHash('sha256').update(raw).digest('base64url')

/** Waits for the relay's text `ready` before handing the socket to RelayStream (text frames are violations there). */
function relayStream(url: string, room: string): Promise<Duplex> {
  const { promise, resolve, reject } = Promise.withResolvers<Duplex>()
  const ws = new WebSocket(`${url}/v1/connect/${room}`, { perMessageDeflate: false, maxPayload: 16385 })
  const timer = setTimeout(() => {
    ws.terminate()
    reject(new Error(PEER_OFFLINE))
  }, RELAY_READY_MS)
  const done = (error?: Error): void => {
    clearTimeout(timer)
    ws.removeAllListeners()
    if (error) {
      ws.on('error', () => {})
      ws.terminate()
      reject(error)
    } else resolve(new RelayStream(ws))
  }
  ws.on('error', () => done(new Error(PEER_UNREACHABLE)))
  ws.on('unexpected-response', (_req, res) => {
    const status = res.statusCode ?? 0
    done(new Error(status === 429 ? RELAY_BUSY : status === 503 ? PEER_OFFLINE : PEER_UNREACHABLE))
  })
  ws.on('close', (code) => done(new Error(code === 4503 || code === 4504 ? PEER_OFFLINE : PEER_UNREACHABLE)))
  ws.on('message', (data, isBinary) => {
    if (!isBinary && String(data) === 'ready') done()
    else done(new Error(PEER_UNREACHABLE))
  })
  return promise
}

/**
 * Opens TLS to a hub. With `pin`, a certificate whose SHA-256 differs fails with `PIN_MISMATCH`
 * before any byte of the request is written; without it, the observed fingerprint is reported.
 */
export async function dial(target: DialTarget, pin?: string): Promise<{ socket: TLSSocket; fingerprint: string }> {
  const base =
    target.kind === 'direct'
      ? { host: target.address, port: target.port ?? HUB_PORT, servername: undefined }
      : { socket: target.kind === 'relay' ? await relayStream(target.url, target.room) : target.stream }
  const socket = tlsConnect({ ...base, rejectUnauthorized: false, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
  const { promise, resolve, reject } = Promise.withResolvers<{ socket: TLSSocket; fingerprint: string }>()
  const timer = setTimeout(() => {
    socket.destroy()
    reject(new Error(PEER_UNREACHABLE))
  }, DIAL_MS)
  socket.once('error', (e) => {
    clearTimeout(timer)
    reject(e)
  })
  socket.once('secureConnect', () => {
    clearTimeout(timer)
    const fingerprint = fingerprintOf(socket.getPeerCertificate().raw)
    if (pin !== undefined && fingerprint !== pin) {
      socket.destroy()
      return reject(new Error('PIN_MISMATCH'))
    }
    resolve({ socket, fingerprint })
  })
  return promise
}

function send(
  socket: Duplex,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; body: unknown }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: unknown }>()
  const req = request(
    { method, path, headers: { Host: 'hub', ...headers }, createConnection: () => socket, timeout: RPC_MS },
    (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          // Non-JSON body: status alone decides.
        }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
      res.on('error', reject)
    }
  )
  req.on('timeout', () => req.destroy(new Error(PEER_UNREACHABLE)))
  req.on('error', reject)
  req.end(body)
  return promise
}

export type PairTarget = { kind: 'direct'; address: string; port?: number } | { kind: 'relay'; url: string } | { kind: 'stream'; open: () => Duplex }

/** Pairs this PC with a host through its one-time code; every step runs over a fresh TLS connection. */
export async function pairWithHost(target: PairTarget, code: string, clientName: string): Promise<PeerLink> {
  const { rendezvous } = normalizePairCode(code)
  const room = target.kind === 'relay' ? relayRoom(await pairRelayKey(rendezvous)) : ''
  const post: PairPost = async (path, body) => {
    const { socket, fingerprint } = await dial(
      target.kind === 'relay'
        ? { kind: 'relay', url: target.url, room }
        : target.kind === 'stream'
          ? { kind: 'stream', stream: target.open() }
          : target
    )
    try {
      const res = await send(socket, 'POST', path, { 'Content-Type': 'application/json', Connection: 'close' }, JSON.stringify(body))
      return { ...res, fingerprint }
    } finally {
      socket.destroy()
    }
  }
  const { payload, fingerprint } = await runPairClient(post, code, 'pc', clientName)
  if (payload.kind !== 'pc') throw new Error('요청 형식이 잘못되었습니다.')
  let certFingerprint = ''
  try {
    certFingerprint = fingerprintOf(new X509Certificate(payload.certPem).raw)
  } catch {
    // Unparseable certificate counts as a mismatch.
  }
  if (certFingerprint !== fingerprint) throw new Error(PAIR_CERT_CHANGED)
  return {
    id: payload.peerId,
    name: payload.hostName,
    fingerprint,
    certPem: payload.certPem,
    token: payload.token,
    addresses: payload.addresses.filter((a) => typeof a === 'string'),
    relay: payload.relay
  }
}

type Path = { kind: 'direct'; address: string } | { kind: 'relay' }

/** HTTP agent whose connections are pinned TLS sockets on one path. */
class PathAgent extends Agent {
  constructor(private open: () => Promise<TLSSocket>) {
    super({ keepAlive: true, maxSockets: 4 })
  }
  override createConnection(
    _options: unknown,
    callback?: (err: Error | null, stream: Duplex) => void
  ): undefined {
    this.open().then(
      (socket) => callback?.(null, socket),
      (err: Error) => callback?.(err, undefined as unknown as Duplex)
    )
    return undefined
  }
}

export class PeerConnection {
  status: PeerStatus = 'offline'
  snapshot: Snapshot | null = null
  private closed = false
  private agents = new Map<string, PathAgent>()
  private current: Path | null = null
  private events: { req: ClientRequest; path: Path } | null = null
  private retry: NodeJS.Timeout | null = null
  private probe: NodeJS.Timeout | null = null
  private attempt = 0
  private seen = new Map<string, number>()
  private refreshing: Promise<void> | null = null

  constructor(
    readonly link: PeerLink,
    private onChange: () => void,
    private onStream: (event: StreamEvent) => void,
    private port = HUB_PORT
  ) {
    this.connect()
  }

  private paths(): Path[] {
    return [
      ...this.link.addresses.map((address): Path => ({ kind: 'direct', address })),
      ...(this.link.relay ? [{ kind: 'relay' } as Path] : [])
    ]
  }

  private agent(path: Path): PathAgent {
    const key = path.kind === 'direct' ? `d:${path.address}` : 'relay'
    let agent = this.agents.get(key)
    if (!agent) {
      const relay = this.link.relay
      agent = new PathAgent(async () => {
        try {
          return (
            await dial(
              path.kind === 'direct'
                ? { kind: 'direct', address: path.address, port: this.port }
                : { kind: 'relay', url: relay!.url, room: relay!.room },
              this.link.fingerprint
            )
          ).socket
        } catch (e) {
          if (e instanceof Error && e.message === 'PIN_MISMATCH') this.block()
          throw e
        }
      })
      this.agents.set(key, agent)
    }
    return agent
  }

  private http(
    path: Path,
    method: string,
    url: string,
    body?: string,
    timeout = RPC_MS
  ): Promise<{ status: number; body: unknown }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: unknown }>()
    const req = request(
      {
        method,
        path: url,
        agent: this.agent(path),
        timeout,
        headers: {
          Host: 'hub',
          Authorization: `Bearer ${this.link.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            // Status alone decides.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(PEER_UNREACHABLE)))
    req.on('error', reject)
    req.end(body)
    return promise
  }

  private block(): void {
    if (this.status === 'blocked') return
    this.status = 'blocked'
    this.stopTransport()
    this.onChange()
  }

  private revoke(): void {
    if (this.status === 'revoked') return
    this.status = 'revoked'
    this.stopTransport()
    this.onChange()
  }

  private stopTransport(): void {
    clearTimeout(this.retry ?? undefined)
    clearInterval(this.probe ?? undefined)
    this.retry = this.probe = null
    this.events?.req.destroy()
    this.events = null
    this.current = null
    for (const agent of this.agents.values()) agent.destroy()
    this.agents.clear()
  }

  private get terminal(): boolean {
    return this.closed || this.status === 'revoked' || this.status === 'blocked'
  }

  /** First path that answers /health wins: direct addresses in order, relay after a short stagger. */
  private async findPath(): Promise<Path> {
    const paths = this.paths()
    if (!paths.length) throw new Error(PEER_UNREACHABLE)
    const health = async (path: Path): Promise<Path> => {
      const res = await this.http(path, 'GET', '/health', undefined, DIAL_MS)
      if (res.status === 401) this.revoke()
      if (res.status === 403) {
        // The host refused this network path (not Tailscale); say so instead of "unreachable".
        const error = (res.body as { error?: unknown } | null)?.error
        throw Object.assign(new Error(typeof error === 'string' ? error : PEER_UNREACHABLE), { http: true })
      }
      if (res.status !== 200) throw new Error(PEER_UNREACHABLE)
      return path
    }
    const direct = paths.filter((p) => p.kind === 'direct')
    const sequential = (async () => {
      let last: unknown = new Error(PEER_UNREACHABLE)
      for (const p of direct) {
        try {
          return await health(p)
        } catch (e) {
          last = e
        }
      }
      throw last
    })()
    const relay = paths.some((p) => p.kind === 'relay')
      ? (async () => {
          if (direct.length) await new Promise((r) => setTimeout(r, RELAY_STAGGER_MS))
          return health({ kind: 'relay' })
        })()
      : Promise.reject(new Error(PEER_UNREACHABLE))
    try {
      return await Promise.any([sequential, relay])
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e]
      throw errors.find((x) => x instanceof Error && x.message === 'PIN_MISMATCH') ?? errors[0]
    }
  }

  private connect(): void {
    if (this.terminal) return
    clearTimeout(this.retry ?? undefined)
    this.retry = null
    void this.findPath().then(
      (path) => {
        if (this.terminal) return
        this.current = path
        this.openEvents(path)
      },
      () => this.lost()
    )
  }

  private lost(): void {
    if (this.terminal) return
    this.events?.req.destroy()
    this.events = null
    this.current = null
    clearInterval(this.probe ?? undefined)
    this.probe = null
    if (this.status !== 'offline') {
      this.status = 'offline'
      this.onChange()
    }
    clearTimeout(this.retry ?? undefined)
    this.retry = setTimeout(() => this.connect(), RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)])
  }

  private openEvents(path: Path, replacing?: ClientRequest): void {
    const req = request({
      method: 'GET',
      path: '/events',
      agent: this.agent(path),
      headers: { Host: 'hub', Authorization: `Bearer ${this.link.token}`, Accept: 'text/event-stream' }
    })
    const entry = { req, path }
    req.on('response', (res: IncomingMessage) => {
      if (res.statusCode === 401) return this.revoke()
      if (res.statusCode !== 200) {
        res.resume()
        return req.destroy(new Error(PEER_UNREACHABLE))
      }
      // Make-before-break: the old stream closes only once the new one answered.
      replacing?.destroy()
      this.events = entry
      this.current = path
      this.attempt = 0
      if (path.kind === 'relay' && this.link.addresses.length) this.startProbe()
      else {
        clearInterval(this.probe ?? undefined)
        this.probe = null
      }
      void this.refresh()
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          let event = 'message'
          const data: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
          }
          if (data.length) this.event(event, data.join('\n'))
        }
      })
      res.on('close', () => {
        if (this.events === entry) this.lost()
      })
    })
    req.on('error', (e) => {
      if (e.message === 'PIN_MISMATCH') return this.block()
      if (this.events === entry || (!replacing && this.events === null)) this.lost()
    })
    req.end()
  }

  private startProbe(): void {
    if (this.probe) return
    this.probe = setInterval(() => {
      if (this.terminal || this.current?.kind !== 'relay') return
      void (async () => {
        for (const address of this.link.addresses) {
          const path: Path = { kind: 'direct', address }
          try {
            if ((await this.http(path, 'GET', '/health', undefined, DIAL_MS)).status === 200) {
              if (this.current?.kind === 'relay' && this.events) this.openEvents(path, this.events.req)
              return
            }
          } catch {
            // Still unreachable directly.
          }
        }
      })()
    }, PROBE_MS)
  }

  private event(event: string, data: string): void {
    if (event === 'changed') return void this.refresh()
    if (event !== 'stream') return
    let parsed: StreamEvent
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    // Revisions only grow within a turn, so anything at or below the last one is a replay.
    const last = this.seen.get(parsed.turnId)
    if (last !== undefined && parsed.revision <= last) return
    if (parsed.done) this.seen.delete(parsed.turnId)
    else this.seen.set(parsed.turnId, parsed.revision)
    this.onStream(parsed)
  }

  private refresh(): Promise<void> {
    // Coalesce bursts of `changed` into one snapshot read.
    this.refreshing ??= (async () => {
      try {
        this.snapshot = (await this.rpc('snapshot', [], { retry: true })) as Snapshot
        this.status = 'online'
      } catch {
        // rpc already set the status.
      } finally {
        this.refreshing = null
      }
      this.onChange()
    })()
    return this.refreshing
  }

  async rpc(name: string, args: unknown[], options: { retry?: boolean } = {}): Promise<unknown> {
    if (this.status === 'revoked') throw new Error(PEER_REVOKED)
    if (this.status === 'blocked') throw new Error(PEER_BLOCKED)
    if (this.closed) throw new Error(PEER_UNREACHABLE)
    let tries = options.retry ? 2 : 1
    for (;;) {
      try {
        const path = this.current ?? (this.current = await this.findPath())
        const res = await this.http(path, 'POST', `/rpc/${name}`, JSON.stringify({ args }))
        const error = (res.body as { error?: unknown } | null)?.error
        if (res.status === 200) return (res.body as { result?: unknown } | null)?.result ?? null
        if (res.status === 401) {
          this.revoke()
          throw new Error(PEER_REVOKED)
        }
        throw Object.assign(new Error(typeof error === 'string' ? error : `HTTP ${res.status}`), { http: true })
      } catch (e) {
        if (e instanceof Error && e.message === 'PIN_MISMATCH') {
          this.block()
          throw new Error(PEER_BLOCKED)
        }
        if (e instanceof Error && ('http' in e || e.message === PEER_REVOKED)) throw e
        this.current = null
        if (--tries > 0 && !this.terminal) continue
        if (!this.terminal) this.lost()
        const status = this.status as PeerStatus
        throw new Error(status === 'blocked' ? PEER_BLOCKED : status === 'revoked' ? PEER_REVOKED : PEER_UNREACHABLE)
      }
    }
  }

  close(): void {
    this.closed = true
    this.stopTransport()
  }
}

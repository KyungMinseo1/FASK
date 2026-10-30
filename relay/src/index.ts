// Blind byte relay between the PC hub and the phone. Every payload is end-to-end TLS ciphertext;
// the relay only pairs sockets, enforces size and credit limits, and forwards binary frames.
import { DurableObject } from 'cloudflare:workers'

const MAX_CLIENTS = 32
const MAX_PENDING = 8
const PENDING_MS = 15000
const MAX_FRAME = 16385
const WINDOW = 262144
const HOST_PER_MIN = 10
const CONNECT_PER_MIN = 120
const MINUTE = 60000

const DATA = 0
const ACK = 1

const KEY = /^[A-Za-z0-9_-]{43}$/
const PAIR_ID = /^[A-Za-z0-9_-]{22}$/

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function text(status: number, body = ''): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}

async function allowed(limit: RateLimit, key: string): Promise<boolean> {
  return (await limit.limit({ key })).success
}

export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname
    // Bindings are typed as present, but a deployment can lack them; fail closed when it does.
    const rateLimit = !!(env.IP_LIMIT && env.HOST_LIMIT && env.CONNECT_LIMIT)
    if (path === '/v1/health') {
      if (req.method !== 'GET') return text(405)
      return Response.json(
        { ok: rateLimit || env.RATE_LIMIT_MODE === 'off', rateLimit },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }
    const accept = /^\/v1\/accept\/([^/]*)$/.exec(path)
    const connect = /^\/v1\/connect\/([^/]*)$/.exec(path)
    if (path !== '/v1/host' && !accept && !connect) return text(404)
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text(426, 'websocket required')
    if (accept && !PAIR_ID.test(accept[1])) return text(400)
    if (connect && !KEY.test(connect[1])) return text(400)

    let room: string
    if (connect) room = connect[1]
    else {
      const key = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') ?? '')?.[1]
      if (!key) return text(401)
      room = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))))
    }

    if (rateLimit) {
      if (!(await allowed(env.IP_LIMIT, req.headers.get('cf-connecting-ip') ?? 'unknown'))) return text(429)
      const scoped = connect || accept
        ? await allowed(env.CONNECT_LIMIT, `connect:${room}`)
        : await allowed(env.HOST_LIMIT, `host:${room}`)
      if (!scoped) return text(429)
    } else if (env.RATE_LIMIT_MODE !== 'off') return text(503, 'rate limiting unavailable')

    const target = accept ? `accept/${accept[1]}` : connect ? 'connect' : 'host'
    return env.ROOMS.getByName(room).fetch(
      new Request(`https://room/${target}`, { headers: { Upgrade: 'websocket' } })
    )
  }
} satisfies ExportedHandler<Env>

function close(ws: WebSocket | undefined, code: number, reason: string): void {
  if (!ws) return
  try {
    ws.close(code, reason)
  } catch {
    // Already closed.
  }
}

/** Sliding one-minute window; records the hit only when it is allowed. */
function hit(times: number[], limit: number, now: number): boolean {
  while (times.length && times[0] <= now - MINUTE) times.shift()
  if (times.length >= limit) return false
  times.push(now)
  return true
}

export class Room extends DurableObject<Env> {
  // In-memory only: lost on hibernation, which only happens when the room is quiet.
  private hostTimes: number[] = []
  private connectTimes: number[] = []
  /** Unacked DATA bytes per pair: up = client→host, down = host→client. */
  private windows = new Map<string, { up: number; down: number }>()

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/host') return this.registerHost()
    if (path === '/connect') return this.openClient()
    const accept = /^\/accept\/([A-Za-z0-9_-]{22})$/.exec(path)
    if (accept) return this.acceptClient(accept[1])
    return text(404)
  }

  private upgrade(tags: string[], attachment?: unknown): { server: WebSocket; response: Response } {
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, tags)
    if (attachment !== undefined) server.serializeAttachment(attachment)
    return { server, response: new Response(null, { status: 101, webSocket: client }) }
  }

  private openHost(except?: WebSocket): WebSocket | undefined {
    return this.ctx.getWebSockets('host').find((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
  }

  private pairId(ws: WebSocket): { role: 'client' | 'data' | 'host'; id: string } {
    for (const tag of this.ctx.getTags(ws)) {
      if (tag === 'host') return { role: 'host', id: '' }
      if (tag.startsWith('c:')) return { role: 'client', id: tag.slice(2) }
      if (tag.startsWith('d:')) return { role: 'data', id: tag.slice(2) }
    }
    return { role: 'host', id: '' }
  }

  private paired(id: string): boolean {
    return this.ctx.getWebSockets(`d:${id}`).length > 0
  }

  private unpairedClients(): WebSocket[] {
    return this.ctx.getWebSockets('client').filter((ws) => !this.paired(this.pairId(ws).id))
  }

  private registerHost(): Response {
    if (!hit(this.hostTimes, HOST_PER_MIN, Date.now())) return text(429)
    const old = this.ctx.getWebSockets('host')
    if (old.length) {
      for (const ws of old) close(ws, 4001, 'replaced')
      for (const ws of this.ctx.getWebSockets('client')) close(ws, 4001, 'replaced')
      for (const ws of this.ctx.getWebSockets('data')) close(ws, 4001, 'replaced')
      this.windows.clear()
    }
    return this.upgrade(['host']).response
  }

  private async openClient(): Promise<Response> {
    const host = this.openHost()
    if (!host) return text(503)
    const now = Date.now()
    if (!hit(this.connectTimes, CONNECT_PER_MIN, now)) return text(429)
    if (this.ctx.getWebSockets('client').length >= MAX_CLIENTS) return text(429)
    if (this.unpairedClients().length >= MAX_PENDING) return text(429)
    const id = base64url(crypto.getRandomValues(new Uint8Array(16)))
    const { response } = this.upgrade(['client', `c:${id}`], { at: now })
    try {
      host.send(JSON.stringify({ type: 'open', id }))
    } catch {
      // The host is going away; the pending alarm or host close cleans the client up.
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + PENDING_MS)
    return response
  }

  private acceptClient(id: string): Response {
    const client = this.ctx.getWebSockets(`c:${id}`)[0]
    if (!client) return text(404)
    if (this.paired(id)) return text(409)
    const { response } = this.upgrade(['data', `d:${id}`])
    this.windows.set(id, { up: 0, down: 0 })
    try {
      client.send('ready')
    } catch {
      // The client left; its close handler tears the pair down.
    }
    return response
  }

  private peerOf(role: 'client' | 'data', id: string): WebSocket | undefined {
    return this.ctx.getWebSockets(role === 'client' ? `d:${id}` : `c:${id}`)[0]
  }

  private closePair(ws: WebSocket, peer: WebSocket | undefined, id: string, code: number, reason: string): void {
    close(ws, code, reason)
    close(peer, code, reason)
    this.windows.delete(id)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { role, id } = this.pairId(ws)
    if (role === 'host') return
    const peer = this.peerOf(role, id)
    if (typeof message === 'string') return this.closePair(ws, peer, id, 4400, 'protocol')
    const bytes = new Uint8Array(message)
    if (bytes.length > MAX_FRAME) return this.closePair(ws, peer, id, 1009, 'too big')
    if (!peer || bytes.length === 0) return this.closePair(ws, peer, id, 4400, 'protocol')
    let window = this.windows.get(id)
    if (!window) this.windows.set(id, (window = { up: 0, down: 0 }))
    const upward = role === 'client'
    if (bytes[0] === DATA) {
      if (bytes.length < 2) return this.closePair(ws, peer, id, 4400, 'protocol')
      if (upward) window.up += bytes.length - 1
      else window.down += bytes.length - 1
      if (window.up > WINDOW || window.down > WINDOW) return this.closePair(ws, peer, id, 4400, 'window')
    } else if (bytes[0] === ACK) {
      if (bytes.length !== 5) return this.closePair(ws, peer, id, 4400, 'protocol')
      const n = new DataView(message).getUint32(1)
      if (n < 1 || n > WINDOW) return this.closePair(ws, peer, id, 4400, 'protocol')
      // Counters reset on hibernation, so clamp instead of rejecting.
      if (upward) window.down = Math.max(0, window.down - n)
      else window.up = Math.max(0, window.up - n)
    } else return this.closePair(ws, peer, id, 4400, 'protocol')
    try {
      peer.send(message)
    } catch {
      this.closePair(ws, peer, id, 1011, 'send failed')
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  private gone(ws: WebSocket): void {
    const { role, id } = this.pairId(ws)
    if (role === 'host') {
      // A replaced host closes after its successor is already open; that successor keeps its clients.
      if (!this.openHost(ws)) for (const client of this.unpairedClients()) close(client, 4503, 'host offline')
    } else {
      close(this.peerOf(role, id), 1000, 'peer closed')
      this.windows.delete(id)
    }
    close(ws, 1000, 'closed')
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let earliest = Infinity
    for (const client of this.unpairedClients()) {
      const at = (client.deserializeAttachment() as { at?: number } | null)?.at ?? 0
      if (at + PENDING_MS <= now) close(client, 4504, 'host timeout')
      else earliest = Math.min(earliest, at)
    }
    if (earliest !== Infinity) await this.ctx.storage.setAlarm(earliest + PENDING_MS)
  }
}

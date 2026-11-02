// Mobile hub: HTTPS with a self-signed certificate the phone pins through the pairing QR.
// Clients authenticate with a bearer token sent only in the Authorization header.
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
// @peculiar/x509 resolves its ASN.1 services through tsyringe, which needs the Reflect polyfill.
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import type { HubAddress } from '../preload/personal'

export interface HubTls {
  cert: string
  key: string
  /** SHA-256 of the certificate DER, base64url. */
  fingerprint: string
}
export interface HubListenResult {
  address: string
  port: number
  error: string
}
/** Bounds for relayed connections, which anyone holding the relay room id can open. */
export interface HubLimits {
  relayHandshakeMs: number
  /** A relayed connection must send an authorized request this long after its TLS handshake. */
  relayAuthMs: number
  relayMaxStreams: number
  relayMaxUnauthenticated: number
}
export const DEFAULT_HUB_LIMITS: HubLimits = {
  relayHandshakeMs: 10000,
  relayAuthMs: 10000,
  relayMaxStreams: 32,
  relayMaxUnauthenticated: 8
}

const ALLOWED_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/
const MAX_BODY = 40 * 1024 * 1024
const MAX_PAIR_BODY = 16 * 1024
const PAIR_SOCKET_MS = 30_000
const PING_MS = 25000
export const PEER_NETWORK_ERROR = 'Tailscale 또는 릴레이로만 PC 연결을 할 수 있습니다.'

export type HubCaller = { kind: 'mobile' } | { kind: 'peer'; id: string }

export function addressKind(address: string): HubAddress['kind'] {
  const [a, b] = address.split('.').map(Number)
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
  return 'other'
}

export async function createHubCertificate(): Promise<HubTls> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])
  const now = new Date()
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      // Leading 0x01 keeps the INTEGER positive and minimally encoded for BoringSSL.
      serialNumber: `01${randomBytes(15).toString('hex')}`,
      name: 'CN=FASK Hub',
      notBefore: now,
      notAfter: new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      keys,
      // Electron's BoringSSL rejects a certificate whose extensions field is present but empty.
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)
      ]
    },
    webcrypto as Crypto
  )
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  return {
    cert: cert.toString('pem'),
    key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').replace(/.{64}/g, '$&\n').trimEnd()}\n-----END PRIVATE KEY-----\n`,
    fingerprint: createHash('sha256').update(Buffer.from(cert.rawData)).digest('base64url')
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>()
  const chunks: Buffer[] = []
  if (Number(req.headers['content-length'] ?? 0) > max) {
    resolve(null)
    return promise
  }
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > max) {
      req.removeAllListeners('data')
      resolve(null)
    } else chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', () => resolve(null))
  return promise
}

export class PersonalHub {
  private servers: Server[] = []
  private events = new Map<ServerResponse, HubCaller>()
  private ping: NodeJS.Timeout | null = null
  private auth: (bearer: string) => HubCaller | null = () => null
  /** Never listen; relayed byte streams are handed to them as connections. */
  private relayServer: Server | null = null
  private pairServer: Server | null = null
  private injected = new Set<Duplex>()
  private relaySockets = new Set<TLSSocket>()
  /** Relayed sockets from the pairing rendezvous room: /pair/* only. */
  private pairSockets = new WeakSet<TLSSocket>()
  private relayAuthed = new WeakSet<TLSSocket>()
  private relayAuthedCount = 0
  constructor(
    private invoke: (caller: HubCaller, name: string, args: unknown[]) => Promise<unknown>,
    private methods: ReadonlySet<string>,
    private version: string,
    private pair: { ke1(body: unknown): Promise<unknown>; ke3(body: unknown): Promise<unknown> },
    private limits: HubLimits = DEFAULT_HUB_LIMITS,
    private isTailscale: (address: string) => boolean = (a) => addressKind(a) === 'tailscale'
  ) {}
  get running(): boolean {
    return this.servers.length > 0
  }
  /** Binds each address separately; one failing address does not stop the others. */
  async start(
    addresses: string[],
    port: number,
    auth: (bearer: string) => HubCaller | null,
    tls: HubTls
  ): Promise<HubListenResult[]> {
    await this.stop()
    this.auth = auth
    // Node enforces headersTimeout/requestTimeout only for listening servers, so relayed sockets get
    // their own deadline: authenticate within relayAuthMs of the handshake or be dropped.
    const pair = createServer(
      { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', handshakeTimeout: this.limits.relayHandshakeMs },
      (req, res) => void this.handle(req, res)
    )
    pair.on('secureConnection', (socket: TLSSocket) => {
      this.relaySockets.add(socket)
      this.pairSockets.add(socket)
      const deadline = setTimeout(() => socket.destroy(), PAIR_SOCKET_MS)
      socket.once('close', () => {
        clearTimeout(deadline)
        this.relaySockets.delete(socket)
      })
    })
    this.pairServer = pair
    const relay = createServer(
      { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', handshakeTimeout: this.limits.relayHandshakeMs },
      (req, res) => void this.handle(req, res)
    )
    relay.on('secureConnection', (socket: TLSSocket) => {
      this.relaySockets.add(socket)
      const deadline = setTimeout(() => {
        if (!this.relayAuthed.has(socket)) socket.destroy()
      }, this.limits.relayAuthMs)
      socket.once('close', () => {
        clearTimeout(deadline)
        this.relaySockets.delete(socket)
        if (this.relayAuthed.has(socket)) this.relayAuthedCount--
      })
    })
    this.relayServer = relay
    const results: HubListenResult[] = []
    for (const address of addresses) {
      const server = createServer(
        { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' },
        (req, res) => void this.handle(req, res)
      )
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, address, () => {
            server.off('error', reject)
            resolve()
          })
        })
        this.servers.push(server)
        const bound = server.address()
        results.push({ address, port: typeof bound === 'object' && bound ? bound.port : port, error: '' })
      } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined
        results.push({
          address,
          port,
          error:
            code === 'EADDRINUSE'
              ? `${address}: 포트 ${port}을 사용할 수 없습니다.`
              : code === 'EADDRNOTAVAIL'
                ? `${address}: 현재 네트워크에 없는 주소입니다.`
                : `${address}: ${e instanceof Error ? e.message : String(e)}`
        })
      }
    }
    this.ping = setInterval(() => {
      for (const res of this.events.keys()) res.write(': ping\n\n')
    }, PING_MS)
    return results
  }
  /** Drops open event streams so clients notice and reconnect. */
  async stop(): Promise<void> {
    clearInterval(this.ping ?? undefined)
    this.ping = null
    for (const res of this.events.keys()) res.destroy()
    this.events.clear()
    for (const stream of this.injected) stream.destroy()
    this.injected.clear()
    for (const socket of this.relaySockets) socket.destroy()
    this.relayServer = null
    this.pairServer = null
    const servers = this.servers
    this.servers = []
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          })
      )
    )
  }
  /** Serves one relayed byte stream (TLS inside) like a freshly accepted TCP connection. */
  inject(stream: Duplex, mode: 'hub' | 'pair' = 'hub'): void {
    const relay = mode === 'pair' ? this.pairServer : this.relayServer
    const unauthenticated = this.injected.size - this.relayAuthedCount
    if (
      !relay ||
      this.injected.size >= this.limits.relayMaxStreams ||
      unauthenticated >= this.limits.relayMaxUnauthenticated
    ) {
      stream.destroy()
      return
    }
    this.injected.add(stream)
    stream.once('close', () => this.injected.delete(stream))
    relay.emit('connection', stream)
  }
  /** Peers never receive events that this PC itself relays from its own linked PCs. */
  broadcast(event: 'stream' | 'changed', data: unknown, origin: 'local' | 'remote' = 'local'): void {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const [res, caller] of this.events)
      if (origin === 'local' || caller.kind !== 'peer') res.write(chunk)
  }
  /** Ends a revoked peer's event streams; its token already fails auth. */
  disconnect(peerId: string): void {
    for (const [res, caller] of this.events)
      if (caller.kind === 'peer' && caller.id === peerId) {
        this.events.delete(res)
        res.destroy()
      }
  }
  private tailscaleSocket(req: IncomingMessage): boolean {
    return this.isTailscale((req.socket.localAddress ?? '').replace(/^::ffff:/, ''))
  }
  private caller(req: IncomingMessage): HubCaller | null {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) return null
    return this.auth(header.slice(7))
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Browser dev mode only; native clients send no Origin.
    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!ALLOWED_ORIGIN.test(origin)) return json(res, 403, { error: '허용되지 않은 출처입니다.' })
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const socket = req.socket as TLSSocket
    const relayed = this.relaySockets.has(socket)
    const path = new URL(req.url ?? '/', 'https://hub').pathname
    const pairRoute = /^\/pair\/(ke1|ke3)$/.exec(path)
    if (pairRoute) {
      if (!relayed && !this.tailscaleSocket(req)) return json(res, 403, { error: PEER_NETWORK_ERROR })
      if (req.method !== 'POST') return json(res, 404, { error: '찾을 수 없습니다.' })
      const body = await readBody(req, MAX_PAIR_BODY)
      if (body === null) {
        res.setHeader('Connection', 'close')
        res.on('finish', () => req.destroy())
        return json(res, 413, { error: '요청이 너무 큽니다.' })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return json(res, 400, { error: '요청 형식이 잘못되었습니다.' })
      }
      try {
        return json(res, 200, await (pairRoute[1] === 'ke1' ? this.pair.ke1(parsed) : this.pair.ke3(parsed)))
      } catch (e) {
        const status = e && typeof e === 'object' && 'status' in e && typeof e.status === 'number' ? e.status : 400
        return json(res, status, { error: e instanceof Error ? e.message : '요청이 실패했습니다.' })
      }
    }
    if (this.pairSockets.has(socket)) {
      res.setHeader('Connection', 'close')
      return json(res, 404, { error: '찾을 수 없습니다.' })
    }
    // Query-string credentials are ignored on purpose; only the header counts.
    const caller = this.caller(req)
    if (!caller) {
      // A relayed connection gets one attempt; it must reconnect to try again.
      if (relayed) res.setHeader('Connection', 'close')
      return json(res, 401, { error: '인증이 필요합니다.' })
    }
    if (caller.kind === 'peer' && !relayed && !this.tailscaleSocket(req))
      return json(res, 403, { error: PEER_NETWORK_ERROR })
    if (relayed && !this.relayAuthed.has(socket)) {
      this.relayAuthed.add(socket)
      this.relayAuthedCount++
    }
    if (req.method === 'GET' && path === '/health')
      return json(res, 200, { app: 'fask', version: this.version })
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      res.write(': connected\n\n')
      this.events.set(res, caller)
      res.on('close', () => this.events.delete(res))
      return
    }
    const rpc = /^\/rpc\/([a-z-]+)$/.exec(path)
    if (req.method !== 'POST' || !rpc || !this.methods.has(rpc[1])) {
      res.setHeader('Connection', 'close')
      return json(res, 404, { error: '찾을 수 없습니다.' })
    }
    const body = await readBody(req, MAX_BODY)
    if (body === null) {
      res.setHeader('Connection', 'close')
      res.on('finish', () => req.destroy())
      return json(res, 413, { error: '요청이 너무 큽니다.' })
    }
    let args: unknown
    try {
      const parsed: unknown = JSON.parse(body)
      args = parsed && typeof parsed === 'object' && 'args' in parsed ? parsed.args : undefined
    } catch {
      args = undefined
    }
    if (!Array.isArray(args)) return json(res, 400, { error: '요청 형식이 잘못되었습니다.' })
    try {
      json(res, 200, { result: (await this.invoke(caller, rpc[1], args)) ?? null })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : '요청이 실패했습니다.' })
    }
  }
}

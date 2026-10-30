// Mobile hub: HTTPS with a self-signed certificate the phone pins through the pairing QR.
// Clients authenticate with a bearer token sent only in the Authorization header.
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { createHash, randomBytes, timingSafeEqual, webcrypto } from 'node:crypto'
// @peculiar/x509 resolves its ASN.1 services through tsyringe, which needs the Reflect polyfill.
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'

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
const PING_MS = 25000

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

export class PersonalHub {
  private servers: Server[] = []
  private events = new Set<ServerResponse>()
  private ping: NodeJS.Timeout | null = null
  private token = ''
  /** Never listens; relayed byte streams are handed to it as connections. */
  private relayServer: Server | null = null
  private injected = new Set<Duplex>()
  private relaySockets = new Set<TLSSocket>()
  private relayAuthed = new WeakSet<TLSSocket>()
  private relayAuthedCount = 0
  constructor(
    private invoke: (name: string, args: unknown[]) => Promise<unknown>,
    private methods: ReadonlySet<string>,
    private version: string,
    private limits: HubLimits = DEFAULT_HUB_LIMITS
  ) {}
  get running(): boolean {
    return this.servers.length > 0
  }
  /** Binds each address separately; one failing address does not stop the others. */
  async start(
    addresses: string[],
    port: number,
    token: string,
    tls: HubTls
  ): Promise<HubListenResult[]> {
    await this.stop()
    this.token = token
    // Node enforces headersTimeout/requestTimeout only for listening servers, so relayed sockets get
    // their own deadline: authenticate within relayAuthMs of the handshake or be dropped.
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
      for (const res of this.events) res.write(': ping\n\n')
    }, PING_MS)
    return results
  }
  /** Drops open event streams so clients notice and reconnect. */
  async stop(): Promise<void> {
    clearInterval(this.ping ?? undefined)
    this.ping = null
    for (const res of this.events) res.destroy()
    this.events.clear()
    for (const stream of this.injected) stream.destroy()
    this.injected.clear()
    for (const socket of this.relaySockets) socket.destroy()
    this.relayServer = null
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
  inject(stream: Duplex): void {
    const relay = this.relayServer
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
  broadcast(event: 'stream' | 'changed', data: unknown): void {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.events) res.write(chunk)
  }
  private authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    return !!this.token && given.length === expected.length && timingSafeEqual(given, expected)
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
    // Query-string credentials are ignored on purpose; only the header counts.
    const socket = req.socket as TLSSocket
    const relayed = this.relaySockets.has(socket)
    if (!this.authorized(req)) {
      // A relayed connection gets one attempt; it must reconnect to try again.
      if (relayed) res.setHeader('Connection', 'close')
      return json(res, 401, { error: '인증이 필요합니다.' })
    }
    if (relayed && !this.relayAuthed.has(socket)) {
      this.relayAuthed.add(socket)
      this.relayAuthedCount++
    }
    const path = new URL(req.url ?? '/', 'https://hub').pathname
    if (req.method === 'GET' && path === '/health')
      return json(res, 200, { app: 'fask', version: this.version })
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      res.write(': connected\n\n')
      this.events.add(res)
      res.on('close', () => this.events.delete(res))
      return
    }
    const rpc = /^\/rpc\/([a-z-]+)$/.exec(path)
    if (req.method !== 'POST' || !rpc || !this.methods.has(rpc[1])) {
      res.setHeader('Connection', 'close')
      return json(res, 404, { error: '찾을 수 없습니다.' })
    }
    const body = await new Promise<string | null>((resolve) => {
      const chunks: Buffer[] = []
      let size = Number(req.headers['content-length'] ?? 0)
      if (size > MAX_BODY) return resolve(null)
      size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY) {
          req.removeAllListeners('data')
          resolve(null)
        } else chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(null))
    })
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
      json(res, 200, { result: (await this.invoke(rpc[1], args)) ?? null })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : '요청이 실패했습니다.' })
    }
  }
}

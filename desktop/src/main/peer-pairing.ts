// Host side of code pairing: one short-lived OPAQUE registration per code, held in memory only.
import { randomBytes } from 'node:crypto'
import {
  KE1,
  KE3,
  OpaqueClient,
  OpaqueServer,
  RegistrationRequest,
  RegistrationResponse,
  type ExpectedAuthResult,
  type RegistrationRecord
} from '@cloudflare/opaque-ts'
import {
  generatePairCode,
  PAIR_CLIENT_ID,
  PAIR_CREDENTIAL,
  PAIR_SERVER_ID,
  PAIR_WRONG_CODE,
  pairConfig,
  pairContext,
  sealPairPayload,
  type PairKind,
  type PairPayload
} from '../shared/pair-code'

export const PAIR_TTL_MS = 5 * 60_000
export const PAIR_MAX_ATTEMPTS = 5
export const PAIR_SESSION_MS = 30_000
const GONE = '연결 코드가 없거나 만료되었습니다.'
const BAD = '요청 형식이 잘못되었습니다.'

export class PairError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

interface ActiveCode {
  code: string
  expiresAt: number
  fingerprint: string
  server: OpaqueServer
  record: RegistrationRecord
}
interface Pending {
  sessionId: string
  expected: ExpectedAuthResult
  name: string
  kind: PairKind
  expires: number
  code: ActiveCode
}

/** Builds the sealed payload for a successful pairing; may throw PairError. */
export type PairPayloadBuilder = (kind: PairKind, name: string) => Promise<PairPayload> | PairPayload

export class PairingHost {
  private active: ActiveCode | null = null
  private pending: Pending | null = null
  private attempts = 0
  constructor(
    private hostName: string,
    private now: () => number = Date.now
  ) {}

  get attemptCount(): number {
    return this.attempts
  }

  async begin(fingerprint: string): Promise<{ code: string; rendezvous: string; expiresAt: number }> {
    this.cancel()
    const cfg = pairConfig()
    const code = generatePairCode()
    const secret = code.slice(3)
    const server = new OpaqueServer(
      cfg,
      cfg.prng.random(cfg.hash.Nh),
      await cfg.ake.generateAuthKeyPair(),
      PAIR_SERVER_ID
    )
    const client = new OpaqueClient(cfg)
    const request = await client.registerInit(secret)
    if (request instanceof Error) throw request
    const response = await server.registerInit(
      RegistrationRequest.deserialize(cfg, request.serialize()),
      PAIR_CREDENTIAL
    )
    if (response instanceof Error) throw response
    const done = await client.registerFinish(
      RegistrationResponse.deserialize(cfg, response.serialize()),
      PAIR_SERVER_ID,
      PAIR_CLIENT_ID
    )
    if (done instanceof Error) throw done
    // A begin() racing this one wins by being later; the previous code stays discarded.
    this.cancel()
    const expiresAt = this.now() + PAIR_TTL_MS
    this.active = { code, expiresAt, fingerprint, server, record: done.record }
    return { code, rendezvous: code.slice(0, 3), expiresAt }
  }

  cancel(): void {
    this.active = null
    this.pending = null
    this.attempts = 0
  }

  status(): { code: string; expiresAt: number } | null {
    const a = this.active
    if (!a) return null
    if (a.expiresAt <= this.now()) {
      this.cancel()
      return null
    }
    return { code: a.code, expiresAt: a.expiresAt }
  }

  async ke1(body: unknown): Promise<{ sessionId: string; ke2: number[]; name: string }> {
    const b = body as { ke1?: unknown; name?: unknown; kind?: unknown } | null
    if (
      !b ||
      typeof b !== 'object' ||
      (b.kind !== 'pc' && b.kind !== 'mobile') ||
      !Array.isArray(b.ke1) ||
      typeof b.name !== 'string'
    )
      throw new PairError(400, BAD)
    // Synchronous gate: every concurrent request is counted before any await.
    const active = this.active
    if (!active || active.expiresAt <= this.now()) {
      this.cancel()
      throw new PairError(410, GONE)
    }
    if (this.attempts >= PAIR_MAX_ATTEMPTS) {
      this.cancel()
      throw new PairError(410, GONE)
    }
    this.attempts++
    if (this.pending && this.pending.expires > this.now())
      throw new PairError(409, '다른 연결 시도가 진행 중입니다. 잠시 후 다시 시도해 주세요.')
    const slot: Pending = {
      sessionId: randomBytes(16).toString('base64url'),
      expected: undefined as unknown as ExpectedAuthResult,
      name: b.name.slice(0, 80),
      kind: b.kind,
      expires: this.now() + PAIR_SESSION_MS,
      code: active
    }
    this.pending = slot
    const cfg = pairConfig()
    let ke1: KE1
    try {
      ke1 = KE1.deserialize(cfg, b.ke1 as number[])
    } catch {
      if (this.pending === slot) this.pending = null
      throw new PairError(400, BAD)
    }
    const init = await active.server.authInit(
      ke1,
      active.record,
      PAIR_CREDENTIAL,
      PAIR_CLIENT_ID,
      pairContext(active.fingerprint)
    )
    if (init instanceof Error) {
      if (this.pending === slot) this.pending = null
      throw new PairError(400, BAD)
    }
    if (this.pending !== slot) throw new PairError(410, GONE)
    slot.expected = init.expected
    return { sessionId: slot.sessionId, ke2: init.ke2.serialize(), name: this.hostName }
  }

  async ke3(body: unknown, build: PairPayloadBuilder): Promise<{ iv: string; sealed: string }> {
    const b = body as { sessionId?: unknown; ke3?: unknown } | null
    if (!b || typeof b !== 'object' || typeof b.sessionId !== 'string' || !Array.isArray(b.ke3))
      throw new PairError(400, BAD)
    const pending = this.pending
    if (
      !pending ||
      pending.sessionId !== b.sessionId ||
      pending.expires <= this.now() ||
      !pending.expected ||
      this.active !== pending.code ||
      pending.code.expiresAt <= this.now()
    )
      throw new PairError(410, GONE)
    const cfg = pairConfig()
    let finish: { session_key: number[] } | Error
    try {
      finish = pending.code.server.authFinish(KE3.deserialize(cfg, b.ke3 as number[]), pending.expected)
    } catch {
      finish = new Error('bad ke3')
    }
    if (finish instanceof Error) {
      this.pending = null
      throw new PairError(403, PAIR_WRONG_CODE)
    }
    // Single use: the code is gone before the payload is built.
    this.cancel()
    const payload = await build(pending.kind, pending.name)
    return sealPairPayload(finish.session_key, pending.sessionId, JSON.stringify(payload))
  }
}

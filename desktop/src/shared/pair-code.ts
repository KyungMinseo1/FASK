// Device pairing code format and client-side OPAQUE (RFC 9807) steps.
// WebCrypto only, so it runs in the Electron main process and in the mobile WebView.
import { getOpaqueConfig, KE2, OpaqueClient, OpaqueID, type Config } from '@cloudflare/opaque-ts'

export const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIR_SERVER_ID = 'fask-host'
export const PAIR_CLIENT_ID = 'fask-peer'
export const PAIR_CREDENTIAL = 'pair'
export const PAIR_FORMAT_ERROR = '연결 코드 형식이 올바르지 않습니다.'
export const PAIR_WRONG_CODE = '연결 코드가 올바르지 않습니다.'
export const PAIR_CERT_CHANGED = '상대 PC 인증서가 바뀌었습니다.'

export type PairKind = 'pc' | 'mobile'
export type PairPayload =
  | {
      kind: 'pc'
      peerId: string
      token: string
      certPem: string
      hostName: string
      addresses: string[]
      relay: { url: string; room: string } | null
    }
  | { kind: 'mobile'; pairing: string }

export const pairConfig = (): Config => getOpaqueConfig(OpaqueID.OPAQUE_P256)
export const pairContext = (fingerprint: string): string => 'fask-pair-v1:' + fingerprint

const enc = new TextEncoder()

export function b64u(bytes: Uint8Array | number[]): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64u(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

export function generatePairCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(raw, (b) => PAIR_ALPHABET[b & 31]).join('')
}

export const formatPairCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

export function normalizePairCode(input: string): { rendezvous: string; secret: string } {
  const code = String(input ?? '')
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (code.length !== 8 || [...code].some((c) => !PAIR_ALPHABET.includes(c)))
    throw new Error(PAIR_FORMAT_ERROR)
  return { rendezvous: code.slice(0, 3), secret: code.slice(3) }
}

/** Public relay room key for the rendezvous value (matches relay KEY: 43 base64url chars). */
export async function pairRelayKey(rendezvous: string): Promise<string> {
  return b64u(await sha256('fask-pair-room-v1:' + rendezvous))
}

async function sealKey(sessionKey: number[] | Uint8Array, sessionId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(sessionKey), 'HKDF', false, [
    'deriveBits'
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: unb64u(sessionId) as BufferSource,
      info: enc.encode('fask-pair-v1 seal')
    },
    ikm,
    256
  )
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function sealPairPayload(
  sessionKey: number[] | Uint8Array,
  sessionId: string,
  json: string
): Promise<{ iv: string; sealed: string }> {
  const key = await sealKey(sessionKey, sessionId)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(json))
  return { iv: b64u(iv), sealed: b64u(new Uint8Array(sealed)) }
}

export async function unsealPairPayload(
  sessionKey: number[] | Uint8Array,
  sessionId: string,
  box: { iv: string; sealed: string }
): Promise<string> {
  const key = await sealKey(sessionKey, sessionId)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(box.iv) as BufferSource },
    key,
    unb64u(box.sealed) as BufferSource
  )
  return new TextDecoder().decode(plain)
}

export type PairPost = (
  path: '/pair/ke1' | '/pair/ke3',
  body: unknown
) => Promise<{ status: number; body: unknown; fingerprint: string }>

function failure(res: { status: number; body: unknown }): Error {
  const error = (res.body as { error?: unknown } | null)?.error
  return new Error(typeof error === 'string' ? error : `HTTP ${res.status}`)
}

/** Runs the client side of the OPAQUE login against /pair/ke1 and /pair/ke3. */
export async function runPairClient(
  post: PairPost,
  code: string,
  kind: PairKind,
  name: string
): Promise<{ payload: PairPayload; fingerprint: string; hostName: string }> {
  const { secret } = normalizePairCode(code)
  const cfg = pairConfig()
  const client = new OpaqueClient(cfg)
  const ke1 = await client.authInit(secret)
  if (ke1 instanceof Error) throw ke1
  const first = await post('/pair/ke1', { ke1: ke1.serialize(), name, kind })
  if (first.status !== 200) throw failure(first)
  const r1 = first.body as { sessionId?: unknown; ke2?: unknown; name?: unknown }
  if (typeof r1?.sessionId !== 'string' || !Array.isArray(r1.ke2))
    throw new Error('요청 형식이 잘못되었습니다.')
  const fingerprint = first.fingerprint
  const finish = await client.authFinish(
    KE2.deserialize(cfg, r1.ke2 as number[]),
    PAIR_SERVER_ID,
    PAIR_CLIENT_ID,
    pairContext(fingerprint)
  )
  if (finish instanceof Error) {
    // Tell the host now so the next try is not refused while this session waits out its timeout.
    await post('/pair/ke3', { sessionId: r1.sessionId, ke3: [] }).catch(() => undefined)
    throw new Error(PAIR_WRONG_CODE)
  }
  const second = await post('/pair/ke3', { sessionId: r1.sessionId, ke3: finish.ke3.serialize() })
  if (second.fingerprint !== fingerprint) throw new Error(PAIR_CERT_CHANGED)
  if (second.status !== 200) throw failure(second)
  const box = second.body as { iv?: unknown; sealed?: unknown }
  if (typeof box?.iv !== 'string' || typeof box.sealed !== 'string')
    throw new Error('요청 형식이 잘못되었습니다.')
  let json: string
  try {
    json = await unsealPairPayload(finish.session_key, r1.sessionId, {
      iv: box.iv,
      sealed: box.sealed
    })
  } catch {
    throw new Error(PAIR_WRONG_CODE)
  }
  const payload = JSON.parse(json) as PairPayload
  if (payload?.kind !== kind) throw new Error('요청 형식이 잘못되었습니다.')
  return { payload, fingerprint, hostName: typeof r1.name === 'string' ? r1.name : '' }
}

export function isTailscaleTarget(address: string): boolean {
  const a = address.trim().toLowerCase()
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (m) {
    const n = m.slice(1).map(Number)
    return n.every((x) => x <= 255) && n[0] === 100 && n[1] >= 64 && n[1] <= 127
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(a)
}
export const TAILSCALE_ADDRESS_ERROR = 'Tailscale 주소(100.x 또는 *.ts.net)를 입력해 주세요.'

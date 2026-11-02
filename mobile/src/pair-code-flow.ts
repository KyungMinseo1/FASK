// Pairs with a PC by its 8-character device code instead of the QR: an OPAQUE login over an
// unpinned TLS request whose observed certificate fingerprint is bound into the exchange.
import {
  b64u,
  isTailscaleTarget,
  normalizePairCode,
  PAIR_CERT_CHANGED,
  pairRelayKey,
  runPairClient,
  sha256,
  TAILSCALE_ADDRESS_ERROR
} from '@desktop/shared/pair-code'
import { parsePairing } from './hub'
import { pairPost, parseRelayUrl, RELAY_ADDRESS, type PairEndpoint, type PairResponse } from './transport'
import { t } from '@desktop/shared/i18n'

export type CodeTarget = { kind: 'direct'; address: string } | { kind: 'relay' }

/** Build-time relay for code pairing; null hides the relay option. */
export const PAIR_RELAY_URL: string | null = parseRelayUrl(import.meta.env.VITE_FASK_RELAY_URL)

export interface PairCodeDeps {
  post: (endpoint: PairEndpoint, path: string, body: unknown) => Promise<PairResponse>
  relayUrl: string | null
}

/** Resolves to the PC's `fask://pair?...` URI, ready for the QR flow's connect(). */
export async function pairWithCode(
  target: CodeTarget,
  code: string,
  deps: PairCodeDeps = { post: pairPost, relayUrl: PAIR_RELAY_URL }
): Promise<string> {
  const { rendezvous } = normalizePairCode(code)
  let endpoint: PairEndpoint
  if (target.kind === 'direct') {
    const address = target.address.trim().toLowerCase()
    if (!isTailscaleTarget(address)) throw new Error(TAILSCALE_ADDRESS_ERROR)
    endpoint = { address }
  } else {
    if (!deps.relayUrl) throw new Error(t('이 빌드에는 릴레이 주소가 설정되어 있지 않습니다.'))
    // Same derivation as the PC's relayRoom(key): base64url(sha256(key)).
    const room = b64u(await sha256(await pairRelayKey(rendezvous)))
    endpoint = { address: RELAY_ADDRESS, relay: { url: deps.relayUrl, room } }
  }
  const { payload, fingerprint } = await runPairClient(
    (path, body) => deps.post(endpoint, path, body),
    code,
    'mobile',
    '휴대폰'
  )
  if (payload.kind !== 'mobile') throw new Error(t('요청 형식이 잘못되었습니다.'))
  if (parsePairing(payload.pairing).fingerprint !== fingerprint) throw new Error(PAIR_CERT_CHANGED)
  return payload.pairing
}

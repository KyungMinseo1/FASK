import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { normalizePairCode, pairRelayKey } from '@desktop/shared/pair-code'
import { PairError, PairingHost } from '@desktop/main/peer-pairing'
import { pairWithCode, type PairCodeDeps } from '../src/pair-code-flow'
import { RELAY_ADDRESS, type PairEndpoint } from '../src/transport'

const fp = 'F'.repeat(43)
const uri = (fingerprint = fp): string =>
  `fask://pair?v=1&a=100.64.0.1&p=47615&fp=${fingerprint}&t=${'T'.repeat(43)}`

/** Serves /pair/* from a real PairingHost; `seen` overrides the fingerprint reported per call. */
async function hostPost(
  pairing: string,
  seen: (path: string) => string = () => fp
): Promise<{ code: string; host: PairingHost; deps: PairCodeDeps; endpoints: PairEndpoint[] }> {
  const host = new PairingHost('PC-A')
  const { code } = await host.begin(fp)
  const endpoints: PairEndpoint[] = []
  const deps: PairCodeDeps = {
    relayUrl: 'wss://relay.example',
    post: async (endpoint, path, body) => {
      endpoints.push(endpoint)
      try {
        const res =
          path === '/pair/ke1'
            ? await host.ke1(body)
            : await host.ke3(body, (kind) => {
                if (kind !== 'mobile') throw new PairError(400, 'unexpected')
                return { kind: 'mobile', pairing }
              })
        return { status: 200, body: res, fingerprint: seen(path) }
      } catch (e) {
        if (!(e instanceof PairError)) throw e
        return { status: e.status, body: { error: e.message }, fingerprint: seen(path) }
      }
    }
  }
  return { code, host, deps, endpoints }
}

describe('normalizePairCode', () => {
  it('normalizes case, separators and look-alike letters', () => {
    expect(normalizePairCode('abc-1o2l3')).toEqual({ rendezvous: 'ABC', secret: '10213' })
  })
  it('rejects malformed codes', () => {
    expect(() => normalizePairCode('ABC-123')).toThrow('연결 코드 형식이 올바르지 않습니다.')
  })
})

describe('pairWithCode', () => {
  it('returns the host pairing URI for the correct code over Tailscale', async () => {
    const { code, deps, endpoints } = await hostPost(uri())
    await expect(pairWithCode({ kind: 'direct', address: ' 100.100.1.2 ' }, code, deps)).resolves.toBe(uri())
    expect(endpoints).toEqual([{ address: '100.100.1.2' }, { address: '100.100.1.2' }])
  })

  it('uses the relay room derived like the PC relayRoom(pairRelayKey(R))', async () => {
    const { code, deps, endpoints } = await hostPost(uri())
    await expect(pairWithCode({ kind: 'relay' }, code, deps)).resolves.toBe(uri())
    const room = createHash('sha256')
      .update(await pairRelayKey(code.slice(0, 3)))
      .digest('base64url')
    expect(endpoints[0]).toEqual({ address: RELAY_ADDRESS, relay: { url: 'wss://relay.example', room } })
  })

  it('rejects the relay target when the build has no relay URL', async () => {
    const { code, deps } = await hostPost(uri())
    await expect(pairWithCode({ kind: 'relay' }, code, { ...deps, relayUrl: null })).rejects.toThrow()
  })

  it('rejects non-Tailscale addresses before any request', async () => {
    const { code, deps, endpoints } = await hostPost(uri())
    await expect(pairWithCode({ kind: 'direct', address: '192.168.0.5' }, code, deps)).rejects.toThrow(
      'Tailscale 주소(100.x 또는 *.ts.net)를 입력해 주세요.'
    )
    expect(endpoints).toEqual([])
  })

  it('rejects a wrong secret', async () => {
    const { code, deps } = await hostPost(uri())
    const wrong = code.slice(0, 3) + (code[3] === '0' ? '1' : '0') + code.slice(4)
    await expect(pairWithCode({ kind: 'direct', address: '100.64.0.1' }, wrong, deps)).rejects.toThrow(
      '연결 코드가 올바르지 않습니다.'
    )
  })

  it('rejects a certificate that changes between ke1 and ke3', async () => {
    const { code, deps } = await hostPost(uri(), (path) => (path === '/pair/ke1' ? fp : 'G'.repeat(43)))
    await expect(pairWithCode({ kind: 'direct', address: '100.64.0.1' }, code, deps)).rejects.toThrow(
      '상대 PC 인증서가 바뀌었습니다.'
    )
  })

  it('rejects a pairing URI whose fingerprint differs from the observed one', async () => {
    const { code, deps } = await hostPost(uri('G'.repeat(43)))
    await expect(pairWithCode({ kind: 'direct', address: '100.64.0.1' }, code, deps)).rejects.toThrow(
      '상대 PC 인증서가 바뀌었습니다.'
    )
  })

  it('surfaces host errors such as a used code', async () => {
    const { code, deps } = await hostPost(uri())
    await pairWithCode({ kind: 'direct', address: '100.64.0.1' }, code, deps)
    await expect(pairWithCode({ kind: 'direct', address: '100.64.0.1' }, code, deps)).rejects.toThrow(
      '연결 코드가 없거나 만료되었습니다.'
    )
  })
})

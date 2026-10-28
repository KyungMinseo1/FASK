import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerTypeHint
} from '@capacitor/barcode-scanner'
import { errorText } from '@desktop/renderer/src/personal/common'
import { parsePairing } from './hub'
import { savePairing, snapshotCache } from './storage'
import { stopOverlay } from './overlay/control'
import { HubError, transport, type Pairing } from './transport'

const SCAN_INSTRUCTIONS = 'PC FASK 설정 > 모바일 연결의 QR을 비춰 주세요.'
// The QR is the only key channel in release builds; manual entry exists for dev/emulator tests.
const MANUAL_ENTRY = import.meta.env.DEV || import.meta.env.MODE === 'pairing-test'

async function scanQr(): Promise<string | null> {
  const scan = (zxing: boolean): Promise<string> =>
    CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: SCAN_INSTRUCTIONS,
      ...(zxing
        ? { android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING } }
        : {})
    }).then((r) => r.ScanResult)
  const cancelled = (e: unknown): boolean => e instanceof Error && /cancel/i.test(e.message)
  try {
    return await scan(false)
  } catch (e) {
    if (cancelled(e)) return null
  }
  // The default ML Kit scanner needs Google Play services; ZXing works without them.
  try {
    return await scan(true)
  } catch (e) {
    if (cancelled(e)) return null
    throw new Error('QR 스캔을 사용할 수 없습니다. 카메라 권한과 Google Play 서비스를 확인해 주세요.')
  }
}

export default function Pair({
  notice,
  onPaired
}: {
  notice: string
  onPaired: (p: Pairing) => void
}): React.JSX.Element {
  const [link, setLink] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const connect = async (text: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const pairing = parsePairing(text)
      const failures: string[] = []
      let lastError = ''
      for (const address of pairing.addresses) {
        try {
          const res = await transport.request(pairing, address, 'GET', '/health', undefined, 10000)
          const body: unknown = JSON.parse(res.body)
          if (res.status !== 200 || !body || typeof body !== 'object' || !('app' in body) || body.app !== 'fask')
            throw new Error('FASK 허브가 아닙니다.')
          // A new PC: the previous PC's encrypted cache and its key go first.
          await snapshotCache.clear()
          const paired = {
            ...pairing,
            addresses: [address, ...pairing.addresses.filter((a) => a !== address)]
          }
          // A running screen session still holds the previous pairing's token.
          await stopOverlay()
          await savePairing(paired)
          onPaired(paired)
          return
        } catch (e) {
          failures.push(e instanceof HubError ? e.code : 'OTHER')
          lastError = errorText(e)
        }
      }
      setError(
        failures.every((f) => f === 'PIN_MISMATCH')
          ? '인증서가 일치하지 않습니다. PC에서 QR을 새로 열어 주세요.'
          : lastError
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mobile-pair">
      <span className="eyebrow">FASK MOBILE</span>
      <h1>PC와 연결</h1>
      <p>
        PC의 FASK에서 설정 → 모바일 연결을 켜고 주소를 선택한 뒤 표시되는 QR을 스캔하세요. 같은
        Wi‑Fi 또는 Tailscale에서 연결됩니다.
      </p>
      {notice && <p className="notice">{notice}</p>}
      {Capacitor.isNativePlatform() && (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void scanQr()
              .then((text) => (text ? connect(text) : undefined))
              .catch((e) => setError(errorText(e)))
          }
        >
          QR 코드 스캔
        </button>
      )}
      {MANUAL_ENTRY && (
        <label className="pair-link">
          페어링 링크
          <textarea
            aria-label="페어링 링크"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="fask://pair?v=1&…"
          />
          <button disabled={busy || !link.trim()} onClick={() => void connect(link)}>
            연결
          </button>
        </label>
      )}
      {busy && <p>PC에 연결하는 중…</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

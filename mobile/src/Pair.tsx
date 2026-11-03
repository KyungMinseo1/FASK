import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerTypeHint
} from '@capacitor/barcode-scanner'
import { errorText } from '@desktop/renderer/src/personal/common'
import { parsePairing, staggered } from './hub'
import { PAIR_RELAY_URL, pairWithCode } from './pair-code-flow'
import { savePairing, snapshotCache } from './storage'
import { overlayPreviewAvailable, previewOverlay, stopOverlay } from './overlay/control'
import { demoAvailable } from './demo-hub'
import { HubError, RELAY_ADDRESS, transport, type Pairing } from './transport'
import { t } from '@desktop/shared/i18n'
import { useT } from '@desktop/shared/i18n/react'

// The QR is the only key channel in release builds; manual entry exists for dev/emulator tests.
const MANUAL_ENTRY = import.meta.env.DEV || import.meta.env.MODE === 'pairing-test'

async function scanQr(): Promise<string | null> {
  const scan = (zxing: boolean): Promise<string> =>
    CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: t('PC FASK 설정 > 모바일 연결의 QR을 비춰 주세요.'),
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
    throw new Error(t('QR 스캔을 사용할 수 없습니다. 카메라 권한과 Google Play 서비스를 확인해 주세요.'))
  }
}

export default function Pair({
  notice,
  onPaired,
  onDemo
}: {
  notice: string
  onPaired: (p: Pairing) => void
  /** Test builds: opens the in-memory demo hub instead of a PC. */
  onDemo?: () => void
}): React.JSX.Element {
  useT()
  const [link, setLink] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [via, setVia] = useState<'direct' | 'relay'>('direct'),
    [address, setAddress] = useState(''),
    [code, setCode] = useState('')
  const connect = async (text: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const pairing = parsePairing(text)
      const healthy = async (address: string): Promise<void> => {
        const res = await transport.request(pairing, address, 'GET', '/health', undefined, 10000)
        const body: unknown = JSON.parse(res.body)
        if (res.status !== 200 || !body || typeof body !== 'object' || !('app' in body) || body.app !== 'fask')
          throw new Error(t('FASK 허브가 아닙니다.'))
      }
      let address: string
      try {
        address = (await staggered(pairing.addresses, healthy, () => {}, () => false)).address
      } catch (e) {
        const errors: unknown[] =
          e && typeof e === 'object' && 'errors' in e && Array.isArray(e.errors) ? e.errors : []
        const failures = errors.filter((x) => x !== undefined)
        setError(
          failures.length && failures.every((f) => f instanceof HubError && f.code === 'PIN_MISMATCH')
            ? t('인증서가 일치하지 않습니다. PC에서 QR을 새로 열어 주세요.')
            : errorText(failures.at(-1))
        )
        return
      }
      // A new PC: the previous PC's encrypted cache and its key go first.
      await snapshotCache.clear()
      // The relay stays last so a direct path is always tried first.
      const paired =
        address === RELAY_ADDRESS
          ? pairing
          : { ...pairing, addresses: [address, ...pairing.addresses.filter((a) => a !== address)] }
      // A running screen session still holds the previous pairing's token.
      await stopOverlay()
      await savePairing(paired)
      onPaired(paired)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const connectWithCode = async (): Promise<void> => {
    setBusy(true)
    setError('')
    let uri: string
    try {
      uri = await pairWithCode(via === 'relay' ? { kind: 'relay' } : { kind: 'direct', address }, code)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
      return
    }
    await connect(uri)
  }
  return (
    <section className="mobile-pair">
      <span className="eyebrow">FASK MOBILE</span>
      <h1>{t('PC와 연결')}</h1>
      <p>
        {t(
          'PC의 FASK에서 설정 → 모바일 연결을 켜고 주소를 선택한 뒤 표시되는 QR을 스캔하세요. 같은 Wi‑Fi, Tailscale 또는 중계 서버로 연결됩니다.'
        )}
      </p>
      {notice && <p className="notice">{notice}</p>}
      {onDemo && demoAvailable() && (
        <button disabled={busy} onClick={onDemo}>
          {t('PC 없이 데모로 둘러보기 (테스트)')}
        </button>
      )}
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
          {t('QR 코드 스캔')}
        </button>
      )}
      <fieldset className="pair-link" disabled={busy}>
        <legend>{t('코드로 연결')}</legend>
        <p>{t('PC의 FASK에서 “기기 연결 코드 만들기”로 표시된 8자리 코드를 입력하세요.')}</p>
        <label>
          <input type="radio" name="pair-via" checked={via === 'direct'} onChange={() => setVia('direct')} />
          {t('Tailscale 주소')}
        </label>
        {via === 'direct' && (
          <input
            aria-label={t('Tailscale 주소')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('100.x.y.z 또는 이름.ts.net')}
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="url"
          />
        )}
        {PAIR_RELAY_URL && (
          <label>
            <input type="radio" name="pair-via" checked={via === 'relay'} onChange={() => setVia('relay')} />
            {t('릴레이')}
          </label>
        )}
        <input
          aria-label={t('연결 코드')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          disabled={busy || !code.trim() || (via === 'direct' && !address.trim())}
          onClick={() => void connectWithCode()}
        >
          {t('연결')}
        </button>
      </fieldset>
      {MANUAL_ENTRY && (
        <label className="pair-link">
          {t('페어링 링크')}
          <textarea
            aria-label={t('페어링 링크')}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="fask://pair?v=1&…"
          />
          <button disabled={busy || !link.trim()} onClick={() => void connect(link)}>
            {t('연결')}
          </button>
        </label>
      )}
      {overlayPreviewAvailable() && (
        <button disabled={busy} onClick={() => void previewOverlay().catch((e) => setError(errorText(e)))}>
          {t('오버레이 미리보기 (테스트)')}
        </button>
      )}
      {busy && <p>{t('PC에 연결하는 중…')}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

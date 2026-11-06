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
import { Wordmark } from '@desktop/renderer/src/personal/Wordmark'
import { Chevron } from '@desktop/renderer/src/personal/ToolbarIcons'
import { Icon } from './icons'

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
    // Which path started the attempt, so its progress and error show next to it.
    [from, setFrom] = useState<'scan' | 'code' | 'link'>('scan'),
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
  // Release builds without a relay offer only Tailscale; test builds show the relay choice disabled.
  const showVia = PAIR_RELAY_URL !== null || MANUAL_ENTRY
  let step = 0
  const status = (where: typeof from): React.JSX.Element | null =>
    from === where && (busy || error) ? (
      <>
        {busy && <p className="pair-status">{t('PC에 연결하는 중…')}</p>}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </>
    ) : null
  return (
    <section className="mobile-pair">
      <header className="pair-hero">
        <div className="mobile-pair-brand">
          <Wordmark />
          <span>{t('모바일')}</span>
        </div>
        <h1>{t('PC와 연결')}</h1>
        <p>{t('휴대폰에서 PC의 FASK로 질문하고 답변을 받아 보세요.')}</p>
      </header>
      {notice && <p className="notice">{notice}</p>}
      <section className="pair-scan" aria-labelledby="pair-scan-title">
        <svg className="pair-scan-art" viewBox="0 0 120 120" aria-hidden="true">
          <path
            className="pair-scan-frame"
            d="M14 34V22a8 8 0 0 1 8-8h12M86 14h12a8 8 0 0 1 8 8v12M106 86v12a8 8 0 0 1-8 8H86M34 106H22a8 8 0 0 1-8-8V86"
          />
          <g className="pair-scan-code">
            <rect x="33.5" y="33.5" width="17" height="17" rx="3" />
            <rect x="69.5" y="33.5" width="17" height="17" rx="3" />
            <rect x="33.5" y="69.5" width="17" height="17" rx="3" />
          </g>
          <g className="pair-scan-dots">
            <rect x="39" y="39" width="6" height="6" rx="1" />
            <rect x="75" y="39" width="6" height="6" rx="1" />
            <rect x="39" y="75" width="6" height="6" rx="1" />
            <rect x="57" y="33" width="6" height="6" rx="1" />
            <rect x="57" y="45" width="6" height="6" rx="1" />
            <rect x="69" y="69" width="6" height="6" rx="1" />
            <rect x="81" y="75" width="6" height="6" rx="1" />
            <rect x="57" y="81" width="6" height="6" rx="1" />
            <rect x="75" y="81" width="6" height="6" rx="1" />
          </g>
          <path className="pair-scan-line" d="M24 60h72" />
        </svg>
        <h2 id="pair-scan-title">{t('QR 코드로 연결')}</h2>
        <ol className="pair-guide">
          <li>
            <span className="pair-n">1</span>
            {t('PC에서 FASK 설정을 엽니다.')}
          </li>
          <li>
            <span className="pair-n">2</span>
            {t('모바일 연결을 켜고 주소를 고릅니다.')}
          </li>
          <li>
            <span className="pair-n">3</span>
            {t('표시된 QR을 이 휴대폰으로 스캔합니다.')}
          </li>
        </ol>
        {Capacitor.isNativePlatform() && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setFrom('scan')
              void scanQr()
                .then((text) => (text ? connect(text) : undefined))
                .catch((e) => setError(errorText(e)))
            }}
          >
            <Icon name="scan" />
            {t('QR 코드 스캔')}
          </button>
        )}
        {status('scan')}
      </section>
      <section className="pair-code" aria-labelledby="pair-code-title">
        <h2 id="pair-code-title">{t('코드로 연결')}</h2>
        <p className="pair-help">{t('QR을 스캔할 수 없을 때 PC에 표시된 연결 코드로 연결합니다.')}</p>
        <fieldset disabled={busy}>
          {showVia && (
            <div className="pair-step" role="radiogroup" aria-labelledby="pair-via-label">
              <span id="pair-via-label" className="pair-step-label">
                <span className="pair-n">{++step}</span>
                {t('연결 방식')}
              </span>
              <div className="pair-seg">
                <label className={via === 'direct' ? 'on' : ''}>
                  <input type="radio" name="pair-via" checked={via === 'direct'} onChange={() => setVia('direct')} />
                  {t('Tailscale 주소')}
                </label>
                <label className={via === 'relay' ? 'on' : PAIR_RELAY_URL ? '' : 'off'}>
                  <input
                    type="radio"
                    name="pair-via"
                    checked={via === 'relay'}
                    disabled={!PAIR_RELAY_URL}
                    aria-describedby={PAIR_RELAY_URL ? undefined : 'pair-relay-missing'}
                    onChange={() => setVia('relay')}
                  />
                  {t('중계 서버')}
                </label>
              </div>
              {!PAIR_RELAY_URL ? (
                <small id="pair-relay-missing" className="pair-help">
                  {t('중계 서버 주소가 이 빌드에 설정되지 않았습니다.')}
                </small>
              ) : (
                via === 'relay' && (
                  <small className="pair-help">{t('PC의 모바일 연결에서 중계 서버를 켠 경우에 사용합니다.')}</small>
                )
              )}
            </div>
          )}
          {via === 'direct' && (
            <div className="pair-step">
              <label htmlFor="pair-address" className="pair-step-label">
                <span className="pair-n">{++step}</span>
                {t('PC 주소')}
              </label>
              <input
                id="pair-address"
                aria-describedby="pair-address-help"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t('100.x.y.z 또는 이름.ts.net')}
                autoCapitalize="none"
                autoCorrect="off"
                inputMode="url"
              />
              <small id="pair-address-help" className="pair-help">
                {t('PC 설정 > 모바일 연결의 주소 목록에서 Tailscale로 표시된 주소를 입력하세요.')}
              </small>
            </div>
          )}
          <div className="pair-step">
            <label htmlFor="pair-code" className="pair-step-label">
              <span className="pair-n">{++step}</span>
              {t('연결 코드')}
            </label>
            <input
              id="pair-code"
              aria-describedby="pair-code-help"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <small id="pair-code-help" className="pair-help">
              {t('PC 설정 > 모바일 연결의 ‘기기 연결 코드 만들기’에 표시되는 8자리 코드입니다.')}
            </small>
          </div>
          <button
            disabled={busy || !code.trim() || (via === 'direct' && !address.trim())}
            onClick={() => {
              setFrom('code')
              void connectWithCode()
            }}
          >
            {t('연결')}
          </button>
        </fieldset>
        {status('code')}
      </section>
      {MANUAL_ENTRY && (
        <details className="pair-alt">
          <summary>
            {t('페어링 링크 붙여넣기')}
            <Chevron />
          </summary>
          <div className="pair-step">
            <label htmlFor="pair-link" className="pair-step-label">
              {t('페어링 링크')}
            </label>
            <textarea
              id="pair-link"
              aria-describedby="pair-link-help"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="fask://pair?v=1&…"
            />
            <small id="pair-link-help" className="pair-help">
              {t('PC에서 복사한 fask://pair 링크로 바로 연결합니다.')}
            </small>
            <button
              disabled={busy || !link.trim()}
              onClick={() => {
                setFrom('link')
                void connect(link)
              }}
            >
              {t('연결')}
            </button>
          </div>
          {status('link')}
        </details>
      )}
      {((onDemo && demoAvailable()) || overlayPreviewAvailable()) && (
        <div className="pair-test">
          {onDemo && demoAvailable() && (
            <button disabled={busy} onClick={onDemo}>
              {t('PC 없이 데모로 둘러보기 (테스트)')}
            </button>
          )}
          {overlayPreviewAvailable() && (
            <button disabled={busy} onClick={() => void previewOverlay().catch((e) => setError(errorText(e)))}>
              {t('오버레이 미리보기 (테스트)')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

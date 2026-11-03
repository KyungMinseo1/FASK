import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { CapacitorShareTarget } from '@capgo/capacitor-share-target'
import { ApiContext } from '@desktop/renderer/src/personal/api'
import { dateLabel, useSnapshot } from '@desktop/renderer/src/personal/common'
import { MobileContext, type PendingShare } from './context'
import { createHubClient, type HubClient, type HubConn } from './hub'
import { createDemoHub, DEMO_PAIRING } from './demo-hub'
import { downscaleToFile } from './media'
import Pair from './Pair'
import Settings from './screens/Settings'
import Home from './screens/Home'
import NewQuestion from './screens/NewQuestion'
import ProjectScreen from './screens/ProjectScreen'
import Share from './screens/Share'
import { clearPairing, loadPairing, snapshotCache } from './storage'
import { isDevWeb, transport, type Pairing } from './transport'
import { t } from '@desktop/shared/i18n'
import { useT } from '@desktop/shared/i18n/react'
import { onOverlayRevoked, overlayRevoked, stopOverlay } from './overlay/control'

export default function MobileApp(): React.JSX.Element {
  const navigate = useNavigate()
  useT()
  // undefined: still reading secure storage.
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined)
  // Test builds only: an in-memory hub replaces the PC until the user leaves the demo.
  const [demo, setDemo] = useState(false)
  const demoRef = useRef(demo)
  demoRef.current = demo
  const [client, setClient] = useState<HubClient | null>(null)
  const [clientDemo, setClientDemo] = useState(false)
  const [conn, setConn] = useState<HubConn>({ state: 'online' })
  const [notice, setNotice] = useState('')
  const [share, setShare] = useState<PendingShare | null>(null)
  const clientRef = useRef<HubClient | null>(null)

  const unpair = useCallback(
    async (message: string) => {
      if (demoRef.current) {
        // The demo never touched the stored pairing or cache; just drop back to the real state.
        setDemo(false)
        setNotice(message)
        navigate('/', { replace: true })
        return
      }
      // The service holds its own copy of the token; end it before the pairing disappears.
      await stopOverlay()
      // Close first so no late response can repopulate the cache that is cleared next.
      clientRef.current?.close()
      clientRef.current = null
      await clearPairing()
      await snapshotCache.clear()
      setPairing(null)
      setNotice(message)
      navigate('/pair', { replace: true })
    },
    [navigate]
  )
  const unpairRef = useRef(unpair)
  unpairRef.current = unpair

  useEffect(() => {
    void loadPairing()
      .then(async (p) => {
        // A screen-question session saw this token revoked while the app was away.
        if (p && (await overlayRevoked(p.fingerprint))) {
          await unpairRef.current(t('페어링이 해제되었습니다. 다시 연결해 주세요.'))
          return
        }
        setPairing(p)
      })
      .catch(() => setPairing(null))
  }, [])
  useEffect(() => {
    if (!pairing && !demo) return
    const c = demo
      ? createDemoHub()
      : createHubClient(pairing!, {
          transport,
          cache: snapshotCache,
          onStatus: setConn,
          onUnpaired: (message) => void unpairRef.current(message)
        })
    clientRef.current = c
    setConn({ state: 'online' })
    setClient(c)
    setClientDemo(demo)
    return () => {
      c.close()
      if (clientRef.current === c) clientRef.current = null
      setClient(null)
    }
  }, [pairing, demo])
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const handle = CapacitorShareTarget.addListener('shareReceived', (event) => {
      void (async () => {
        const files: File[] = []
        const errors: string[] = []
        for (const f of event.files ?? []) {
          try {
            const blob = await (await fetch(Capacitor.convertFileSrc(f.uri))).blob()
            files.push(
              f.mimeType.startsWith('image/')
                ? await downscaleToFile(blob, f.name)
                : new File([blob], f.name, { type: f.mimeType })
            )
          } catch {
            errors.push(t('{{name}}: 공유 파일을 읽을 수 없습니다.', { name: f.name }))
          }
        }
        setShare({ id: crypto.randomUUID(), raw: (event.texts ?? []).join('\n'), files })
        setNotice(errors.join('\n'))
        navigate('/share')
      })()
    })
    return () => void handle.then((h) => h.remove())
  }, [navigate])

  // Until the effect swaps clients, the previous hub must not render under the new mode.
  if (pairing === undefined || ((pairing || demo) && (!client || clientDemo !== demo)))
    return <div className="fask-loading">{t('FASK를 여는 중…')}</div>
  if (!client || (!pairing && !demo))
    return (
      <div className="fask-app fask-mobile">
        {isDevWeb && <DevBanner />}
        <Pair
          notice={notice}
          onDemo={() => {
            setNotice('')
            setDemo(true)
            navigate('/', { replace: true })
          }}
          onPaired={(p) => {
            clientRef.current?.close()
            setNotice('')
            setPairing(p)
            navigate('/', { replace: true })
          }}
        />
      </div>
    )
  return (
    <ApiContext.Provider value={client}>
      <Shell
        // Remount on demo switch so no screen state or profile tracking crosses hubs.
        key={demo ? 'demo' : 'hub'}
        client={client}
        pairing={demo ? DEMO_PAIRING : pairing!}
        demo={demo}
        enterDemo={() => {
          setDemo(true)
          navigate('/', { replace: true })
        }}
        conn={conn}
        share={share}
        notice={notice}
        setNotice={setNotice}
        unpair={unpair}
      />
    </ApiContext.Provider>
  )
}

function DevBanner(): React.JSX.Element {
  const t = useT()
  return <div className="mobile-banner dev">{t('개발 모드: 인증서 고정 없이 연결합니다')}</div>
}

function Shell({
  client,
  pairing,
  demo,
  enterDemo,
  conn,
  share,
  notice,
  setNotice,
  unpair
}: {
  client: HubClient
  pairing: Pairing
  demo: boolean
  enterDemo: () => void
  conn: HubConn
  share: PendingShare | null
  notice: string
  setNotice: (n: string) => void
  unpair: (message: string) => Promise<void>
}): React.JSX.Element {
  const navigate = useNavigate()
  const t = useT()
  const { data, refresh, error } = useSnapshot()
  const lastProfile = useRef('')
  useEffect(() => {
    if (!data) return
    // Old screens hold IDs from the previous profile; send the user back to the start.
    if (lastProfile.current && lastProfile.current !== data.activeProfileId) {
      navigate('/', { replace: true })
      setNotice(t('PC에서 프로필이 바뀌어 처음 화면으로 이동했습니다.'))
    }
    lastProfile.current = data.activeProfileId
  }, [data, navigate, setNotice, t])
  useEffect(() => {
    const check = async (): Promise<boolean> => {
      if (demo || !(await overlayRevoked(pairing.fingerprint))) return false
      await unpair(t('페어링이 해제되었습니다. 다시 연결해 주세요.'))
      return true
    }
    const handle = App.addListener('resume', () => {
      void check().then((revoked) => {
        if (revoked) return
        client.reconnect()
        void refresh()
      })
    })
    const offRevoked = onOverlayRevoked(() => void check())
    return () => {
      void handle.then((h) => h.remove())
      offRevoked()
    }
  }, [client, refresh, pairing, unpair, demo])
  const [retrying, setRetrying] = useState(false)
  useEffect(() => setRetrying(false), [conn])
  // Safety net: never leave the button stuck if no status change arrives.
  useEffect(() => {
    if (!retrying) return
    const timer = setTimeout(() => setRetrying(false), 15000)
    return () => clearTimeout(timer)
  }, [retrying])
  const retry = (): void => {
    setRetrying(true)
    client.reconnect()
  }
  const retryButton = (
    <button disabled={retrying} onClick={retry}>
      {retrying && <span className="mobile-spinner" aria-hidden />}
      {retrying ? t('연결 중…') : t('다시 시도')}
    </button>
  )

  const banner =
    conn.state === 'offline' ? (
      <div className="mobile-banner offline" role="status">
        {conn.savedAt
          ? t('PC에 연결할 수 없습니다 · {{date}} 기록을 표시합니다', { date: dateLabel(conn.savedAt) })
          : t('PC에 연결할 수 없습니다 · 저장된 기록을 표시합니다')}
        {retryButton}
      </div>
    ) : conn.state === 'blocked' ? (
      <div className="mobile-banner blocked" role="alert">
        {t('인증서가 일치하지 않는 연결을 차단했습니다. PC에서 연결을 초기화했다면 새 QR로 다시 연결해 주세요.')}
        {retryButton}
        <button onClick={() => navigate('/pair')}>{t('다시 연결')}</button>
      </div>
    ) : null
  return (
    <div className="fask-app fask-mobile">
      {isDevWeb && <DevBanner />}
      {demo && (
        <div className="mobile-banner offline" role="status">
          {t('데모 모드: PC 없이 샘플 데이터로 동작합니다. 변경 내용은 저장되지 않습니다.')}
          <button onClick={() => void unpair('')}>{t('데모 종료')}</button>
        </div>
      )}
      {banner}
      {notice && (
        <div className="notice mobile-notice" role="status">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {!data ? (
        <div className="fask-loading">{error || t('PC의 기록을 불러오는 중…')}</div>
      ) : (
        <MobileContext.Provider value={{ data, refresh, client, pairing, conn, share, unpair, demo, enterDemo }}>
          {/* Remount everything when the PC switches profile so no stale draft or ID survives. */}
          <Routes key={data.activeProfileId}>
            <Route path="/" element={<Home />} />
            <Route path="/p/:projectId" element={<ProjectScreen />} />
            <Route path="/p/:projectId/q/:questionId" element={<ProjectScreen />} />
            <Route path="/p/:projectId/new" element={<NewQuestion />} />
            <Route path="/share" element={<Share />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/pair"
              element={
                <Pair
                  notice=""
                  onPaired={() => {
                    // A fresh pairing was saved; reload so the new client replaces this one.
                    location.hash = '#/'
                    location.reload()
                  }}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </MobileContext.Provider>
      )}
    </div>
  )
}

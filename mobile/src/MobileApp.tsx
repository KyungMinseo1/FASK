import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { CapacitorShareTarget } from '@capgo/capacitor-share-target'
import { ApiContext } from '@desktop/renderer/src/personal/api'
import { dateLabel, useSnapshot } from '@desktop/renderer/src/personal/common'
import { MobileContext, type PendingShare } from './context'
import { createHubClient, type HubClient, type HubConn } from './hub'
import { downscaleToFile } from './media'
import Pair from './Pair'
import Connection from './screens/Connection'
import Home from './screens/Home'
import NewQuestion from './screens/NewQuestion'
import ProjectScreen from './screens/ProjectScreen'
import Share from './screens/Share'
import { clearPairing, loadPairing, snapshotCache } from './storage'
import { isDevWeb, transport, type Pairing } from './transport'
import { onOverlayRevoked, overlayRevoked, stopOverlay } from './overlay/control'

export default function MobileApp(): React.JSX.Element {
  const navigate = useNavigate()
  // undefined: still reading secure storage.
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined)
  const [client, setClient] = useState<HubClient | null>(null)
  const [conn, setConn] = useState<HubConn>({ state: 'online' })
  const [notice, setNotice] = useState('')
  const [share, setShare] = useState<PendingShare | null>(null)
  const clientRef = useRef<HubClient | null>(null)

  const unpair = useCallback(
    async (message: string) => {
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
          await unpairRef.current('페어링이 해제되었습니다. 다시 연결해 주세요.')
          return
        }
        setPairing(p)
      })
      .catch(() => setPairing(null))
  }, [])
  useEffect(() => {
    if (!pairing) return
    const c = createHubClient(pairing, {
      transport,
      cache: snapshotCache,
      onStatus: setConn,
      onUnpaired: (message) => void unpairRef.current(message)
    })
    clientRef.current = c
    setConn({ state: 'online' })
    setClient(c)
    return () => {
      c.close()
      if (clientRef.current === c) clientRef.current = null
      setClient(null)
    }
  }, [pairing])
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
            errors.push(`${f.name}: 공유 파일을 읽을 수 없습니다.`)
          }
        }
        setShare({ id: crypto.randomUUID(), raw: (event.texts ?? []).join('\n'), files })
        setNotice(errors.join('\n'))
        navigate('/share')
      })()
    })
    return () => void handle.then((h) => h.remove())
  }, [navigate])

  if (pairing === undefined) return <div className="fask-loading">FASK를 여는 중…</div>
  if (!pairing || !client)
    return (
      <div className="fask-app fask-mobile">
        {isDevWeb && <DevBanner />}
        <Pair
          notice={notice}
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
        client={client}
        pairing={pairing}
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
  return <div className="mobile-banner dev">개발 모드: 인증서 고정 없이 연결합니다</div>
}

function Shell({
  client,
  pairing,
  conn,
  share,
  notice,
  setNotice,
  unpair
}: {
  client: HubClient
  pairing: Pairing
  conn: HubConn
  share: PendingShare | null
  notice: string
  setNotice: (n: string) => void
  unpair: (message: string) => Promise<void>
}): React.JSX.Element {
  const navigate = useNavigate()
  const { data, refresh, error } = useSnapshot()
  const lastProfile = useRef('')
  useEffect(() => {
    if (!data) return
    // Old screens hold IDs from the previous profile; send the user back to the start.
    if (lastProfile.current && lastProfile.current !== data.activeProfileId) {
      navigate('/', { replace: true })
      setNotice('PC에서 프로필이 바뀌어 처음 화면으로 이동했습니다.')
    }
    lastProfile.current = data.activeProfileId
  }, [data, navigate, setNotice])
  useEffect(() => {
    const check = async (): Promise<boolean> => {
      if (!(await overlayRevoked(pairing.fingerprint))) return false
      await unpair('페어링이 해제되었습니다. 다시 연결해 주세요.')
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
  }, [client, refresh, pairing, unpair])

  const banner =
    conn.state === 'offline' ? (
      <div className="mobile-banner offline" role="status">
        PC에 연결할 수 없습니다 · {conn.savedAt ? dateLabel(conn.savedAt) : '저장된'} 기록을
        표시합니다
        <button onClick={() => client.reconnect()}>다시 시도</button>
      </div>
    ) : conn.state === 'blocked' ? (
      <div className="mobile-banner blocked" role="alert">
        인증서가 일치하지 않는 연결을 차단했습니다. PC에서 연결을 초기화했다면 새 QR로 다시
        연결해 주세요.
        <button onClick={() => client.reconnect()}>다시 시도</button>
        <button onClick={() => navigate('/pair')}>다시 연결</button>
      </div>
    ) : null
  return (
    <div className="fask-app fask-mobile">
      {isDevWeb && <DevBanner />}
      {banner}
      {notice && (
        <div className="notice mobile-notice" role="status">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {!data ? (
        <div className="fask-loading">{error || 'PC의 기록을 불러오는 중…'}</div>
      ) : (
        <MobileContext.Provider value={{ data, refresh, client, pairing, conn, share, unpair }}>
          {/* Remount everything when the PC switches profile so no stale draft or ID survives. */}
          <Routes key={data.activeProfileId}>
            <Route path="/" element={<Home />} />
            <Route path="/p/:projectId" element={<ProjectScreen />} />
            <Route path="/p/:projectId/q/:questionId" element={<ProjectScreen />} />
            <Route path="/p/:projectId/new" element={<NewQuestion />} />
            <Route path="/share" element={<Share />} />
            <Route path="/connection" element={<Connection />} />
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

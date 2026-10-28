import '../index.css'
import '@desktop/renderer/src/personal/personal.css'
import '../mobile.css'
import './overlay.css'

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Snapshot } from '@desktop/preload/personal'
import { ApiContext } from '@desktop/renderer/src/personal/api'
import { errorText } from '@desktop/renderer/src/personal/common'
import { createHubClient, type HubConn } from '../hub'
import { createBridge, type Bootstrap, type Port } from './bridge'
import OverlayPanel from './OverlayPanel'
import { bridgeTransport } from './transport'

const root = createRoot(document.getElementById('root')!)
const fatal = (message: string): void =>
  root.render(<p className="notice error screen-q-fatal">{message}</p>)

// Status changes arrive outside React; the shell subscribes once.
const statusSubs = new Set<(s: HubConn) => void>()
const unpairSubs = new Set<(m: string) => void>()

function Shell({
  boot,
  initial,
  bridge
}: {
  boot: Bootstrap
  initial: Snapshot
  bridge: ReturnType<typeof createBridge>
}): React.JSX.Element {
  const [conn, setConn] = useState<HubConn>({ state: 'online' })
  const [unpaired, setUnpaired] = useState('')
  useEffect(() => {
    statusSubs.add(setConn)
    unpairSubs.add(setUnpaired)
    return () => {
      statusSubs.delete(setConn)
      unpairSubs.delete(setUnpaired)
    }
  }, [])
  return <OverlayPanel bridge={bridge} boot={boot} initial={initial} conn={conn} unpaired={unpaired} />
}

async function start(): Promise<void> {
  const port = (window as unknown as { FaskOverlayBridge?: Port }).FaskOverlayBridge
  if (!port) {
    fatal('Android System WebView를 업데이트해 주세요.')
    return
  }
  const bridge = createBridge(port)
  const boot = await bridge.bootstrap()
  // One client per session: no cache, token stays native, never replaced on hide/show.
  const client = createHubClient(boot.identity, {
    transport: bridgeTransport(bridge),
    onStatus: (s) => statusSubs.forEach((cb) => cb(s)),
    onUnpaired: (m) => unpairSubs.forEach((cb) => cb(m))
  })
  bridge.onPush((p) => {
    if (p.event === 'sessionInvalidated') client.close()
  })
  const initial = await client.snapshot()
  root.render(
    <ApiContext.Provider value={client}>
      <Shell boot={boot} initial={initial} bridge={bridge} />
    </ApiContext.Provider>
  )
}

start().catch((e) => fatal(errorText(e)))

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
import { i18n, t } from '@desktop/shared/i18n'
import { applyOverlayTheme, createBridge, type Bootstrap, type Port, type OverlayState } from './bridge'
import OverlayPanel from './OverlayPanel'
import { bridgeTransport } from './transport'
import { createPreviewClient } from './preview'

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

/** The app sends its resolved language natively; missing means Korean. */
function applyLanguage(state: OverlayState): void {
  const lang = state.lang === 'en' ? 'en' : 'ko'
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

async function start(): Promise<void> {
  const port = (window as unknown as { FaskOverlayBridge?: Port }).FaskOverlayBridge
  if (!port) {
    fatal(t('Android System WebView를 업데이트해 주세요.'))
    return
  }
  const bridge = createBridge(port)
  const boot = await bridge.bootstrap()
  applyLanguage(boot)
  applyOverlayTheme(boot)
  // One client per session: no cache, token stays native, never replaced on hide/show.
  const client = boot.preview
    ? createPreviewClient(boot)
    : createHubClient(boot.identity, {
        transport: bridgeTransport(bridge),
        onStatus: (s) => statusSubs.forEach((cb) => cb(s)),
        onUnpaired: (m) => unpairSubs.forEach((cb) => cb(m))
      })
  bridge.onPush((p) => {
    if (p.event === 'sessionInvalidated') client.close()
    else if (p.event === 'overlayState') applyLanguage(p.payload)
  })
  const initial = await client.snapshot()
  root.render(
    <ApiContext.Provider value={client}>
      <Shell boot={boot} initial={initial} bridge={bridge} />
    </ApiContext.Provider>
  )
}

start().catch((e) => fatal(errorText(e)))

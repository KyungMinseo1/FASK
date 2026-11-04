import './index.css'
import '@xyflow/react/dist/style.css'
import '@desktop/renderer/src/personal/personal.css'
import './mobile.css'

import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import MobileApp from './MobileApp'
import { initTheme, readTheme } from '@desktop/renderer/src/personal/theme'
import { initLanguage, resolveLanguage } from '@desktop/shared/i18n'
import { syncOverlayAnswerBlink, syncOverlayLanguage, syncOverlayTheme } from './overlay/control'
import { readAnswerBlink } from '@desktop/renderer/src/personal/answer-blink'

initTheme()
syncOverlayTheme(readTheme())
syncOverlayAnswerBlink(readAnswerBlink())
initLanguage()
syncOverlayLanguage(resolveLanguage())

// No StrictMode: its double-mounted effects would open a second hub event stream in dev.
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <MobileApp />
  </HashRouter>
)

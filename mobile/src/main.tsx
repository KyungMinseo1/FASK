import './index.css'
import '@xyflow/react/dist/style.css'
import '@desktop/renderer/src/personal/personal.css'
import './mobile.css'

import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import MobileApp from './MobileApp'

// No StrictMode: its double-mounted effects would open a second hub event stream in dev.
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <MobileApp />
  </HashRouter>
)

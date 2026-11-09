import './index.css'
import '@xyflow/react/dist/style.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import App from './App'
import { ApiContext } from './personal/api'
import { NotificationsProvider } from './personal/notifications'
import { initTheme } from './personal/theme'
import { initLanguage, resolveLanguage } from '../../shared/i18n'

initTheme()
initLanguage()
void window.fask?.setUiLanguage?.(resolveLanguage())
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiContext.Provider value={window.fask}>
      <NotificationsProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </NotificationsProvider>
    </ApiContext.Provider>
  </StrictMode>
)

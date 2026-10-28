import './index.css'
import '@xyflow/react/dist/style.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import App from './App'
import { ApiContext } from './personal/api'
import { initTheme } from './personal/theme'

initTheme()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiContext.Provider value={window.fask}>
      <HashRouter>
        <App />
      </HashRouter>
    </ApiContext.Provider>
  </StrictMode>
)

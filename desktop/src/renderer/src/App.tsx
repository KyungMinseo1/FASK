import { Route, Routes } from 'react-router'
import PersonalDashboard from './personal/Dashboard'
import PersonalOverlay from './personal/Overlay'
import CaptureEditor from './personal/CaptureEditor'
import { LockGate } from './personal/LockScreen'
import PurgeListener from './personal/PurgeListener'

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/capture-editor" element={<CaptureEditor />} />
      <Route path="/personal-overlay" element={<PersonalOverlay />} />
      <Route
        path="*"
        element={
          <LockGate>
            <PurgeListener />
            <PersonalDashboard />
          </LockGate>
        }
      />
    </Routes>
  )
}

import { Route, Routes } from 'react-router'
import PersonalDashboard from './personal/Dashboard'
import PersonalOverlay from './personal/Overlay'
import CaptureEditor from './personal/CaptureEditor'

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/capture-editor" element={<CaptureEditor />} />
      <Route path="/personal-overlay" element={<PersonalOverlay />} />
      <Route path="*" element={<PersonalDashboard />} />
    </Routes>
  )
}

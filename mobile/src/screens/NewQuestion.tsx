import { useNavigate, useParams } from 'react-router'
import Composer from '@desktop/renderer/src/personal/Composer'
import { useMobile } from '../context'
import { mediaActions } from '../media'

export default function NewQuestion(): React.JSX.Element {
  const { projectId = '' } = useParams()
  const { data, refresh } = useMobile()
  const navigate = useNavigate()
  const project = data.projects.find((p) => p.id === projectId)
  return (
    <>
      <header className="mobile-top">
        <button aria-label="뒤로" onClick={() => navigate(`/p/${projectId}`)}>
          ←
        </button>
        <h1>{project?.name ?? '새 질문'}</h1>
        <span />
      </header>
      <main className="mobile-body">
        <Composer
          projectId={projectId}
          profileId={data.activeProfileId}
          settings={data.settings}
          mediaActions={mediaActions}
          persistDraft={false}
          // Refresh first so the detail screen already has the new question when it mounts.
          onSaved={(id) =>
            void refresh().then(() => navigate(`/p/${projectId}/q/${id}`, { replace: true }))
          }
        />
      </main>
    </>
  )
}

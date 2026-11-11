import { useNavigate, useParams } from 'react-router'
import Composer from '@desktop/renderer/src/personal/Composer'
import { projectHostName } from '@desktop/renderer/src/personal/questionTree'
import { useMobile } from '../context'
import { mediaActions } from '../media'
import { Icon } from '../icons'
import { useT } from '@desktop/shared/i18n/react'

export default function NewQuestion(): React.JSX.Element {
  const { projectId = '' } = useParams()
  const { data, refresh } = useMobile()
  const navigate = useNavigate()
  const t = useT()
  const project = data.projects.find((p) => p.id === projectId)
  return (
    <>
      <header className="mobile-top">
        <button aria-label={t('뒤로')} onClick={() => navigate(`/p/${projectId}`)}>
          <Icon name="back" />
        </button>
        <h1>{project?.name ?? t('새 질문')}</h1>
        <span />
      </header>
      <main className="mobile-body">
        <Composer
          submitOnEnter={false}
          projectId={projectId}
          hostName={projectHostName(data, projectId)}
          profileId={data.activeProfileId}
          settings={data.settings}
          mediaActions={mediaActions()}
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

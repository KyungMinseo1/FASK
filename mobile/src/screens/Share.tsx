import { useState } from 'react'
import { useNavigate } from 'react-router'
import Composer from '@desktop/renderer/src/personal/Composer'
import { useMobile } from '../context'
import { mediaActions } from '../media'
import { useT } from '@desktop/shared/i18n/react'

const LAST_PROJECT = 'fask-mobile:lastProject'

export default function Share(): React.JSX.Element {
  const { data, share, refresh } = useMobile()
  const navigate = useNavigate()
  const t = useT()
  const [projectId, setProjectId] = useState(() => {
    const last = localStorage.getItem(LAST_PROJECT)
    return data.projects.some((p) => p.id === last) ? last! : (data.projects[0]?.id ?? '')
  })
  return (
    <>
      <header className="mobile-top">
        <button aria-label={t('뒤로')} onClick={() => navigate('/')}>
          ←
        </button>
        <h1>{t('공유받은 내용으로 질문')}</h1>
        <span />
      </header>
      <main className="mobile-body">
        <label className="mobile-field">
          {t('프로젝트')}
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value)
              localStorage.setItem(LAST_PROJECT, e.target.value)
            }}
          >
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {projectId ? (
          <Composer
            key={`${share?.id ?? 'empty'}:${projectId}`}
            projectId={projectId}
            profileId={data.activeProfileId}
            settings={data.settings}
            initialRaw={share?.raw}
            initialFiles={share?.files}
            mediaActions={mediaActions()}
            persistDraft={false}
            onSaved={(id) => void refresh().then(() => navigate(`/p/${projectId}/q/${id}`))}
          />
        ) : (
          <div className="empty-state">
            <h2>{t('PC에서 프로젝트를 만들어 주세요.')}</h2>
          </div>
        )}
      </main>
    </>
  )
}

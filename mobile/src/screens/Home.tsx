import { useNavigate } from 'react-router'
import type { PeerStatus } from '@desktop/preload/personal'
import { useT } from '@desktop/shared/i18n/react'
import { Wordmark } from '@desktop/renderer/src/personal/Wordmark'
import { useMobile } from '../context'
import { Icon } from '../icons'

const PEER_STATUS: Record<PeerStatus, string> = {
  online: '온라인',
  offline: '오프라인',
  revoked: '연결 해제됨',
  blocked: '인증서 불일치'
}

export default function Home(): React.JSX.Element {
  const { data } = useMobile()
  const navigate = useNavigate()
  const t = useT()
  return (
    <>
      <header className="mobile-top">
        <h1>
          <Wordmark />
        </h1>
        <button onClick={() => navigate('/settings')}>{t('설정')}</button>
      </header>
      <main className="mobile-body">
        {data.workspaces.map((w) => {
          const unavailable = !!w.remote && w.remote.status !== 'online'
          return (
            <section key={w.id} className="mobile-workspace">
              <h2>
                {w.remote && <Icon name="globe" size={16} />}
                {w.name}
              </h2>
              {w.remote && (
                <small className="mobile-remote-status">
                  <span>{w.remote.name}</span>
                  <span>{t(PEER_STATUS[w.remote.status])}</span>
                </small>
              )}
              {data.projects
                .filter((p) => p.workspaceId === w.id)
                .map((p) => (
                  <button
                    key={p.id}
                    className="space-card"
                    aria-disabled={unavailable || undefined}
                    onClick={() => {
                      if (!unavailable) navigate(`/p/${p.id}`)
                    }}
                  >
                    <span className="space-icon">
                      <Icon name="project" />
                    </span>
                    <h3>{p.name}</h3>
                    <small>
                      {t('{{n}}개 질문', { n: data.questions.filter((q) => q.projectId === p.id).length })}
                    </small>
                    <b>
                      <Icon name="right" size={18} />
                    </b>
                  </button>
                ))}
            </section>
          )
        })}
        {!data.projects.length && (
          <div className="empty-state">
            <h2>{t('PC에서 프로젝트를 만들어 주세요.')}</h2>
          </div>
        )}
      </main>
    </>
  )
}

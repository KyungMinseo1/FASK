import { useNavigate } from 'react-router'
import type { PeerStatus } from '@desktop/preload/personal'
import { useMobile } from '../context'

const PEER_STATUS: Record<PeerStatus, string> = {
  online: '온라인',
  offline: '오프라인',
  revoked: '연결 해제됨',
  blocked: '인증서 불일치'
}

export default function Home(): React.JSX.Element {
  const { data } = useMobile()
  const navigate = useNavigate()
  return (
    <>
      <header className="mobile-top">
        <h1>FASK</h1>
        <button onClick={() => navigate('/settings')}>설정</button>
      </header>
      <main className="mobile-body">
        {data.workspaces.map((w) => {
          const unavailable = !!w.remote && w.remote.status !== 'online'
          return (
            <section key={w.id} className="mobile-workspace">
              <h2>{w.remote ? `🌐 ${w.name}` : w.name}</h2>
              {w.remote && (
                <small className="mobile-remote-status">
                  {w.remote.name} · {PEER_STATUS[w.remote.status]}
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
                    <span className="space-icon">◈</span>
                    <h3>{p.name}</h3>
                    <small>{data.questions.filter((q) => q.projectId === p.id).length}개 질문</small>
                    <b>↗</b>
                  </button>
                ))}
            </section>
          )
        })}
        {!data.projects.length && (
          <div className="empty-state">
            <h2>PC에서 프로젝트를 만들어 주세요.</h2>
          </div>
        )}
      </main>
    </>
  )
}

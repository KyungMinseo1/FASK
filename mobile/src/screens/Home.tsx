import { useNavigate } from 'react-router'
import { useMobile } from '../context'

export default function Home(): React.JSX.Element {
  const { data } = useMobile()
  const navigate = useNavigate()
  return (
    <>
      <header className="mobile-top">
        <h1>FASK</h1>
        <button onClick={() => navigate('/connection')}>연결</button>
      </header>
      <main className="mobile-body">
        {data.workspaces.map((w) => (
          <section key={w.id} className="mobile-workspace">
            <h2>{w.name}</h2>
            {data.projects
              .filter((p) => p.workspaceId === w.id)
              .map((p) => (
                <button key={p.id} className="space-card" onClick={() => navigate(`/p/${p.id}`)}>
                  <span className="space-icon">◈</span>
                  <h3>{p.name}</h3>
                  <small>{data.questions.filter((q) => q.projectId === p.id).length}개 질문</small>
                  <b>↗</b>
                </button>
              ))}
          </section>
        ))}
        {!data.projects.length && (
          <div className="empty-state">
            <h2>PC에서 프로젝트를 만들어 주세요.</h2>
          </div>
        )}
      </main>
    </>
  )
}

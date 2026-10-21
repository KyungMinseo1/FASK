import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { Concept, Question, Snapshot, ShortcutInfo } from '../../../preload/personal'
import MindMap from '../components/MindMap/MindMap'
import type { MindNode } from '../lib/trees'
import Composer from './Composer'
import MarkdownAnswer from './MarkdownAnswer'
import Settings from './Settings'
import { dateLabel, errorText, statuses, useSnapshot } from './common'
import './personal.css'

type ItemKind = 'profile' | 'workspace' | 'project' | 'concept' | 'question'

function tree(data: Snapshot, projectId: string, questions: Question[]): MindNode {
  const concepts = data.concepts.filter((c) => c.projectId === projectId)
  const leaf = (q: Question, parent: string): MindNode => ({
    id: `q:${q.id}:${parent}`,
    label: (q.title || q.sent).slice(0, 34),
    kind: 'question',
    detail: q.title || q.sent,
    children: []
  })
  const node = (c: Concept, seen: Set<string>): MindNode => ({
    id: `c:${c.id}`,
    label: c.name,
    kind: 'concept',
    count: questions.filter((q) => q.conceptIds.includes(c.id)).length,
    children: seen.has(c.id)
      ? []
      : [
          ...concepts
            .filter((s) => s.parentId === c.id)
            .map((s) => node(s, new Set([...seen, c.id]))),
          ...questions.filter((q) => q.conceptIds.includes(c.id)).map((q) => leaf(q, c.id))
        ]
  })
  return {
    id: `project:${projectId}`,
    label: data.projects.find((p) => p.id === projectId)?.name || '프로젝트',
    kind: 'root',
    children: [
      ...concepts
        .filter((c) => !c.parentId || !concepts.some((p) => p.id === c.parentId))
        .map((c) => node(c, new Set())),
      {
        id: 'unfiled',
        label: '미분류',
        kind: 'group',
        children: questions.filter((q) => !q.conceptIds.length).map((q) => leaf(q, 'unfiled'))
      }
    ]
  }
}
export default function Dashboard(): React.JSX.Element {
  const { data, refresh, error } = useSnapshot()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const projectId = search.get('project') || '',
    workspaceId = search.get('workspace') || ''
  const scope = search.get('scope') || 'project'
  const setProjectId = (id: string): void =>
    setSearch((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('project', id)
      else next.delete('project')
      next.set('scope', 'project')
      return next
    })
  const setWorkspaceId = (id: string): void => setSearch({ workspace: id, scope: 'workspace' })
  const [selectedId, setSelectedId] = useState('')
  const [shortcut, setShortcut] = useState<ShortcutInfo | null>(null)
  useEffect(() => {
    void window.fask.shortcutInfo().then(setShortcut)
  }, [])
  const [view, setView] = useState<'timeline' | 'graph' | 'list'>('timeline'),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all')
  const [settingsOpen, setSettingsOpen] = useState(false),
    [compose, setCompose] = useState(false),
    [notice, setNotice] = useState('')
  const [create, setCreate] = useState<{
      kind: ItemKind
      parent?: string
      id?: string
    } | null>(null),
    [name, setName] = useState('')
  const [conceptId, setConceptId] = useState('')
  const workspace = data?.workspaces.find((w) => w.id === workspaceId) ?? data?.workspaces[0]
  const projects = data?.projects.filter((p) => p.workspaceId === workspace?.id) ?? []
  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  useEffect(() => {
    if (project && scope === 'project') void window.fask.activateProject(project.id).catch(() => {})
  }, [project?.id, scope])
  const questions = data?.questions.filter((q) => q.projectId === project?.id) ?? []
  const filtered = useMemo(
    () =>
      questions.filter(
        (q) =>
          (filter === 'all' ||
            (filter === 'important'
              ? q.important
              : filter === 'unfiled'
                ? !q.conceptIds.length
                : filter === 'failed'
                  ? q.status === 'failed'
                  : q.complexity === filter)) &&
          `${q.title || ''} ${q.raw} ${q.sent} ${q.answer} ${q.memo} ${(q.documents ?? []).map((d) => d.name + ' ' + d.text).join(' ')}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
      ),
    [questions, filter, query]
  )
  const selected = questions.find((q) => q.id === selectedId)
  const concepts = data?.concepts.filter((c) => c.projectId === project?.id) ?? []
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setNotice('')
      await fn()
      await refresh()
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  const beginCreate = (
    kind: 'profile' | 'workspace' | 'project' | 'concept',
    parent?: string
  ): void => {
    setCreate({ kind, parent })
    setName('')
  }
  const beginRename = (kind: ItemKind, id: string, current: string): void => {
    setCreate({ kind, id })
    setName(current)
  }
  const [context, setContext] = useState<{
    x: number
    y: number
    kind: ItemKind
    id: string
    name: string
  } | null>(null)
  const openContext = (event: MouseEvent, kind: ItemKind, id: string, label: string): void => {
    event.preventDefault()
    event.stopPropagation()
    setContext({
      x: Math.max(8, Math.min(event.clientX, innerWidth - 180)),
      y: Math.max(8, Math.min(event.clientY, innerHeight - 120)),
      kind,
      id,
      name: label
    })
  }
  useEffect(() => {
    if (!context) return
    const dismiss = (): void => setContext(null)
    const pointer = (e: globalThis.MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.item-context-menu')) dismiss()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('click', pointer)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('click', pointer)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [context])
  if (!data) return <div className="fask-loading">{error || '나의 질문 공간을 열고 있습니다…'}</div>
  return (
    <div className="fask-app">
      <aside className="fask-sidebar">
        <div className="fask-wordmark">
          <span>f</span> FASK <small>PERSONAL</small>
        </div>
        <label className="sidebar-label">
          프로필
          <select
            aria-label="프로필"
            onContextMenu={(e) =>
              openContext(
                e,
                'profile',
                data.activeProfileId,
                data.profiles.find((p) => p.id === data.activeProfileId)!.name
              )
            }
            value={data.activeProfileId}
            onChange={(e) => {
              const id = e.target.value
              void run(async () => {
                await window.fask.switchProfile(id)
                setSearch({ scope: 'home' })
                setCompose(false)
                setSelectedId('')
              })
            }}
          >
            {data.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="sidebar-add" onClick={() => beginCreate('profile')}>
          ＋ 프로필 추가
        </button>
        <div className="sidebar-heading">
          WORKSPACE
          <button aria-label="워크스페이스 추가" onClick={() => beginCreate('workspace')}>
            ＋
          </button>
        </div>
        <select
          aria-label="워크스페이스"
          onContextMenu={(e) => {
            if (workspace) openContext(e, 'workspace', workspace.id, workspace.name)
          }}
          value={workspace?.id || ''}
          onChange={(e) => {
            setWorkspaceId(e.target.value)
            setSelectedId('')
            setCompose(false)
          }}
        >
          {data.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        {workspace && (
          <button
            className="sidebar-rename"
            onClick={() => beginRename('workspace', workspace.id, workspace.name)}
          >
            워크스페이스 이름 변경 ✎
          </button>
        )}
        <div className="sidebar-heading">
          PROJECTS
          <button aria-label="프로젝트 추가" onClick={() => beginCreate('project', workspace?.id)}>
            ＋
          </button>
        </div>
        <nav>
          {projects.map((p) => (
            <button
              key={p.id}
              onContextMenu={(e) => openContext(e, 'project', p.id, p.name)}
              className={p.id === project?.id ? 'active' : ''}
              onClick={() => {
                setProjectId(p.id)
                setSelectedId('')
                setConceptId('')
                setCompose(false)
              }}
            >
              <span>◈</span>
              {p.name}
              <small>{data.questions.filter((q) => q.projectId === p.id).length}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <i /> 로컬에 저장 중
            <small>이미지 {(data.storageBytes / 1024 / 1024).toFixed(1)} MB</small>
          </div>
          <button onClick={() => setSettingsOpen(true)}>⚙ 설정 · AI 연결</button>
          <small>
            {shortcut?.accelerator?.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' + ') ||
              '단축키 등록 불가 · 다른 앱 점유 확인'}
            <br />
            {shortcut?.fallback ? '대체 단축키 · ' : ''}화면 질문 열기 / 패널 토글
          </small>
        </div>
      </aside>
      <main className="fask-main">
        <nav className="breadcrumb" aria-label="상위 경로">
          <button
            aria-label="이전 화면"
            disabled={!window.history.state?.idx}
            onClick={() => navigate(-1)}
          >
            ←
          </button>
          <button
            onClick={() => {
              setSearch({ scope: 'home' })
              setSelectedId('')
              setCompose(false)
            }}
          >
            내 공간
          </button>
          {scope !== 'home' && workspace && (
            <>
              <span>/</span>
              <button
                onClick={() => {
                  setSearch({ scope: 'workspace', workspace: workspace.id })
                  setSelectedId('')
                  setCompose(false)
                }}
              >
                {workspace.name}
              </button>
            </>
          )}
          {scope === 'project' && project && (
            <>
              <span>/</span>
              <button
                onClick={() => {
                  setSelectedId('')
                  setCompose(false)
                }}
                aria-current="page"
              >
                {project.name}
              </button>
            </>
          )}
        </nav>
        <header className="project-header">
          <div>
            <span className="eyebrow">
              {scope === 'project'
                ? 'PROJECT LIBRARY'
                : scope === 'workspace'
                  ? 'WORKSPACE'
                  : 'YOUR SPACE'}
            </span>
            <h1>
              {scope === 'home'
                ? '내 공간'
                : scope === 'workspace'
                  ? workspace?.name
                  : project?.name || '프로젝트를 만들어 보세요'}
              {scope === 'project' && project && (
                <button
                  className="title-rename"
                  aria-label="프로젝트 이름 변경"
                  onClick={() => beginRename('project', project.id, project.name)}
                >
                  ✎
                </button>
              )}
            </h1>
            <p>
              {scope === 'project'
                ? '질문하고, 연결하고, 나의 지식으로.'
                : '생각을 이어갈 프로젝트를 선택하세요.'}
            </p>
          </div>
          <div className="button-row">
            {scope === 'project' ? (
              <>
                <button
                  disabled={!project}
                  onClick={() => void run(() => window.fask.exportContext(project!.id))}
                >
                  기억 내보내기 ↗
                </button>
                <button
                  className="primary"
                  disabled={!project}
                  onClick={() => void run(() => window.fask.openOverlay(project!.id))}
                >
                  ▧ 화면에서 질문
                </button>
              </>
            ) : (
              <button
                className="primary"
                onClick={() =>
                  beginCreate(
                    scope === 'home' ? 'workspace' : 'project',
                    scope === 'home' ? undefined : workspace?.id
                  )
                }
              >
                ＋ {scope === 'home' ? '워크스페이스' : '프로젝트'} 만들기
              </button>
            )}
          </div>
        </header>
        {scope !== 'project' ? (
          <section className="space-grid">
            {(scope === 'home' ? data.workspaces : projects).map((item) => (
              <button
                className="space-card"
                key={item.id}
                onContextMenu={(e) =>
                  openContext(e, scope === 'home' ? 'workspace' : 'project', item.id, item.name)
                }
                onClick={() => {
                  setSelectedId('')
                  setCompose(false)
                  if (scope === 'home') setWorkspaceId(item.id)
                  else setSearch({ scope: 'project', workspace: workspace!.id, project: item.id })
                }}
              >
                <span className="space-icon">{scope === 'home' ? '▦' : '◈'}</span>
                <h2>{item.name}</h2>
                <small>
                  {scope === 'home'
                    ? `${data.projects.filter((p) => p.workspaceId === item.id).length}개 프로젝트`
                    : `${data.questions.filter((q) => q.projectId === item.id).length}개 질문`}
                </small>
                <b>↗</b>
              </button>
            ))}
            {!(scope === 'home' ? data.workspaces : projects).length && (
              <div className="empty-state">
                <h2>새 프로젝트를 만들어 시작하세요.</h2>
              </div>
            )}
          </section>
        ) : (
          <>
            <div className="project-stats">
              <div>
                <b>{questions.length}</b>
                <span>쌓인 질문</span>
              </div>
              <div>
                <b>{concepts.length}</b>
                <span>연결된 개념</span>
              </div>
              <div>
                <b>{questions.filter((q) => q.important).length}</b>
                <span>중요한 기억</span>
              </div>
              <div className="connection-note">
                <i className={data.settings.model ? 'connected' : ''} />
                {data.settings.model || 'AI 연결을 설정해 주세요'}
              </div>
            </div>
            {(notice || error) && (
              <div className="notice error" role="alert">
                {notice || error}
                <button onClick={() => setNotice('')}>×</button>
              </div>
            )}
            <div className="view-bar">
              <div className="segmented">
                {(
                  [
                    ['timeline', '날짜순'],
                    ['graph', '개념 그래프'],
                    ['list', '목록']
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={view === id ? 'active' : ''}
                    onClick={() => setView(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                disabled={!project}
                onClick={() => {
                  setCompose((s) => !s)
                  setSelectedId('')
                }}
              >
                ＋ 새 질문
              </button>
            </div>
            {compose && project && (
              <Composer
                key={project.id}
                projectId={project.id}
                profileId={data.activeProfileId}
                settings={data.settings}
                onSaved={(id) => {
                  setSelectedId(id)
                  void refresh()
                }}
              />
            )}
            <div className="filter-row">
              <input
                aria-label="기록 검색"
                placeholder="⌕ 질문, 답변, 메모 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                aria-label="질문 필터"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">모든 질문</option>
                <option value="simple">간단한 질문</option>
                <option value="complex">복잡한 질문</option>
                <option value="unknown">복잡도 미확정</option>
                <option value="important">중요한 기억</option>
                <option value="unfiled">미분류</option>
                <option value="failed">요청 실패</option>
              </select>
              <span>{filtered.length}개 기록</span>
            </div>
            <div className={`knowledge-area ${selected ? 'has-detail' : ''}`}>
              <section className="records-panel">
                {view === 'graph' && project ? (
                  <>
                    <div className="graph-actions">
                      <span>개념을 펼치고 질문을 연결하세요</span>
                      <button onClick={() => beginCreate('concept', project.id)}>＋ 개념</button>
                    </div>
                    <MindMap
                      key={project.id}
                      root={tree(data, project.id, filtered)}
                      height={510}
                      onContextMenu={(node, event) => {
                        if (node.id.startsWith('q:')) {
                          const q = questions.find((q) => q.id === node.id.split(':')[1])
                          if (q) openContext(event, 'question', q.id, q.title || q.sent)
                        } else if (node.id.startsWith('c:'))
                          openContext(event, 'concept', node.id.slice(2), node.label)
                        else if (node.id.startsWith('project:'))
                          openContext(event, 'project', project.id, project.name)
                      }}
                      onSelect={(node) => {
                        if (node.id.startsWith('q:')) setSelectedId(node.id.split(':')[1])
                        if (node.id.startsWith('c:')) setConceptId(node.id.slice(2))
                      }}
                    />
                    {conceptId && concepts.some((c) => c.id === conceptId) && (
                      <ConceptEditor
                        key={conceptId}
                        concept={concepts.find((c) => c.id === conceptId)!}
                        concepts={concepts}
                        run={run}
                      />
                    )}
                  </>
                ) : filtered.length ? (
                  <div className={view === 'list' ? 'question-list compact' : 'question-list'}>
                    {filtered.map((q, index) => (
                      <div key={q.id}>
                        {view === 'timeline' &&
                          (index === 0 ||
                            new Date(filtered[index - 1].createdAt).toDateString() !==
                              new Date(q.createdAt).toDateString()) && (
                            <h3 className="day-label">
                              {new Date(q.createdAt).toLocaleDateString('ko-KR', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                                weekday: 'short'
                              })}
                            </h3>
                          )}
                        <button
                          className={`question-card ${selectedId === q.id ? 'selected' : ''}`}
                          onContextMenu={(e) => openContext(e, 'question', q.id, q.title || q.sent)}
                          onClick={() => {
                            setSelectedId(q.id)
                            setCompose(false)
                          }}
                        >
                          <div className="question-meta">
                            <span>
                              {q.complexity === 'complex'
                                ? '깊이 탐구'
                                : q.complexity === 'simple'
                                  ? '빠른 질문'
                                  : '미확정'}
                            </span>
                            <time>{dateLabel(q.createdAt)}</time>
                            {q.important && <span>★</span>}
                          </div>
                          <h3>{q.title || q.sent}</h3>
                          {view !== 'list' && (
                            <p>{q.answer || q.error || '아직 답변이 없습니다.'}</p>
                          )}
                          <div className="question-footer">
                            <span>
                              {q.conceptIds
                                .map((id) => concepts.find((c) => c.id === id)?.name)
                                .filter(Boolean)
                                .join(' · ') || '미분류'}
                            </span>
                            <small>
                              {statuses[q.status]} {q.attachment ? '· ▧' : ''}
                            </small>
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div>✳</div>
                    <h2>
                      {query || filter !== 'all'
                        ? '일치하는 기록이 없습니다'
                        : '첫 번째 궁금함을 남겨보세요'}
                    </h2>
                    <p>
                      화면에 표시하고 질문하거나, 생각을 글로 남기세요.
                      <br />
                      질문과 답변은 이 프로젝트에 차곡차곡 쌓입니다.
                    </p>
                    <button className="primary" onClick={() => setCompose(true)}>
                      ＋ 새 질문
                    </button>
                  </div>
                )}
              </section>
              {selected && project && (
                <QuestionDetail
                  key={selected.id}
                  question={selected}
                  concepts={concepts}
                  run={run}
                  onClose={() => setSelectedId('')}
                  onCreateConcept={async (name) => {
                    const id = await window.fask.create('concept', name, project.id)
                    await window.fask.updateQuestion(selected.id, {
                      conceptIds: [...selected.conceptIds, id],
                      suggestions: selected.suggestions.filter((s) => s !== name)
                    })
                  }}
                />
              )}
            </div>
          </>
        )}
      </main>
      {notice && scope !== 'project' && (
        <div className="global-notice notice error" role="alert">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {context && (
        <div
          className="item-context-menu"
          role="menu"
          aria-label="항목 메뉴"
          style={{ left: context.x, top: context.y }}
        >
          <small>{context.name}</small>
          <button
            role="menuitem"
            autoFocus
            onClick={() => {
              beginRename(context.kind, context.id, context.name)
              setContext(null)
            }}
          >
            편집 · 이름 바꾸기
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              const { kind, id } = context
              setContext(null)
              void run(async () => {
                await window.fask.remove(kind, id)
                if (kind === 'profile' || kind === 'workspace' || kind === 'project') {
                  setSearch({ scope: 'home' })
                  setCompose(false)
                }
                if (id === selectedId) setSelectedId('')
                if (id === conceptId) setConceptId('')
              })
            }}
          >
            삭제
          </button>
        </div>
      )}
      {settingsOpen && <Settings settings={data.settings} onClose={() => setSettingsOpen(false)} />}
      {create && (
        <div className="modal-backdrop">
          <form
            className="create-modal"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                if (create.id) {
                  await window.fask.rename(create.kind, create.id, name)
                  setCreate(null)
                  return
                }
                if (create.kind === 'question') return
                const id = await window.fask.create(create.kind, name, create.parent)
                if (create.kind === 'project') setProjectId(id)
                if (create.kind === 'workspace') setWorkspaceId(id)
                if (create.kind === 'profile') await window.fask.switchProfile(id)
                setCreate(null)
              })
            }}
          >
            <span className="eyebrow">MAKE ROOM FOR YOUR IDEAS</span>
            <h2>
              {
                {
                  profile: '프로필',
                  workspace: '워크스페이스',
                  project: '프로젝트',
                  concept: '개념',
                  question: '질문'
                }[create.kind]
              }{' '}
              {create.id ? '이름 변경' : '만들기'}
            </h2>
            <input
              aria-label="이름"
              autoFocus
              placeholder="이름을 입력하세요"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
            {notice && <p className="error">{notice}</p>}
            <div className="button-row">
              <button type="button" onClick={() => setCreate(null)}>
                취소
              </button>
              <button className="primary" disabled={!name.trim()}>
                {create.id ? '저장' : '만들기'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function QuestionDetail({
  question: q,
  concepts,
  run,
  onClose,
  onCreateConcept
}: {
  question: Question
  concepts: Concept[]
  run: (fn: () => Promise<unknown>) => Promise<void>
  onClose: () => void
  onCreateConcept: (name: string) => Promise<void>
}): React.JSX.Element {
  const [image, setImage] = useState<string | null>(null),
    [memo, setMemo] = useState(q.memo)
  useEffect(() => {
    let alive = true
    if (q.attachment)
      void window.fask
        .attachment(q.attachment)
        .then((img) => {
          if (alive) setImage(img)
        })
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [q.attachment])
  return (
    <aside className="question-detail">
      <header>
        <span className="eyebrow">QUESTION NOTES</span>
        <button onClick={onClose}>닫기 ×</button>
      </header>
      <div className="detail-title">
        <h2>{q.title || q.sent}</h2>
        <button
          className={q.important ? 'star active' : 'star'}
          aria-label="중요 표시"
          onClick={() =>
            void run(() => window.fask.updateQuestion(q.id, { important: !q.important }))
          }
        >
          {q.important ? '★' : '☆'}
        </button>
      </div>
      <p className="detail-meta">
        {dateLabel(q.createdAt)} · {statuses[q.status]}
        <br />
        {q.actualModel || q.model || '모델 미지정'}
      </p>
      {q.refined && (
        <details>
          <summary>원래 질문</summary>
          <p>{q.raw}</p>
        </details>
      )}
      {q.attachment && image && (
        <div className="detail-capture">
          <img src={image} alt="질문에 사용한 캡처" />
          <button onClick={() => void run(() => window.fask.clearAttachment(q.id))}>
            보관 이미지 제거
          </button>
        </div>
      )}
      {q.documents?.map((d, index) => (
        <details key={`${d.name}:${index}`} className="document-detail">
          <summary>▤ {d.name}</summary>
          <pre>{d.text}</pre>
        </details>
      ))}
      <div className="detail-answer">
        <MarkdownAnswer>{q.answer || '아직 답변이 없습니다.'}</MarkdownAnswer>
      </div>
      {q.error && <p className="notice error">{q.error}</p>}
      {q.status === 'running' && (
        <button onClick={() => void run(() => window.fask.cancel(q.id))}>답변 생성 중지</button>
      )}
      <details>
        <summary>모델 추천 근거</summary>
        <p>{q.routingReason}</p>
      </details>
      <h3>연결된 개념</h3>
      <div className="concept-checks">
        {concepts.map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={q.conceptIds.includes(c.id)}
              onChange={(e) =>
                void run(() =>
                  window.fask.updateQuestion(q.id, {
                    conceptIds: e.target.checked
                      ? [...q.conceptIds, c.id]
                      : q.conceptIds.filter((id) => id !== c.id)
                  })
                )
              }
            />
            {c.name}
          </label>
        ))}
      </div>
      {q.suggestions.length > 0 && (
        <div className="suggestions">
          <small>새 개념 제안 · 클릭하면 연결</small>
          {q.suggestions.map((s) => (
            <button key={s} onClick={() => void run(() => onCreateConcept(s))}>
              ＋ {s}
            </button>
          ))}
        </div>
      )}
      <label className="memo-label">
        나의 메모
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="확인한 사실, 결정, 다음 할 일…"
        />
      </label>
      <button onClick={() => void run(() => window.fask.updateQuestion(q.id, { memo }))}>
        메모 저장
      </button>
      <button
        className="reply-button"
        onClick={() => void run(() => window.fask.openOverlay(q.projectId, q.id))}
      >
        이 대화에 이어서 질문 ↗
      </button>
    </aside>
  )
}
function ConceptEditor({
  concept,
  concepts,
  run
}: {
  concept: Concept
  concepts: Concept[]
  run: (fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(concept.name),
    [parent, setParent] = useState(concept.parentId || ''),
    [target, setTarget] = useState('')
  return (
    <div className="concept-editor">
      <h3>개념 정리</h3>
      <input aria-label="개념 이름" value={name} onChange={(e) => setName(e.target.value)} />
      <select aria-label="상위 개념" value={parent} onChange={(e) => setParent(e.target.value)}>
        <option value="">프로젝트 바로 아래</option>
        {concepts
          .filter((c) => c.id !== concept.id)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <button
        onClick={() => void run(() => window.fask.editConcept(concept.id, name, parent || null))}
      >
        이름·위치 저장
      </button>
      <select aria-label="병합 대상" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">병합할 개념 선택</option>
        {concepts
          .filter((c) => c.id !== concept.id)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <button
        disabled={!target}
        onClick={() => void run(() => window.fask.mergeConcept(concept.id, target))}
      >
        선택한 개념으로 병합
      </button>
    </div>
  )
}

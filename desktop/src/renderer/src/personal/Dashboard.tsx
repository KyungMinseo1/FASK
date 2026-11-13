import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { CaptureSetupReason, ExportOptions, Reference, ShortcutInfo } from '../../../preload/personal'
import { EXPORT_DEFAULTS } from '../../../shared/export'
import { captureSetupMessage } from '../../../shared/capture'
import {
  filterQuestions,
  lastTurn,
  questionComplexity,
  questionHeading,
  questionImages,
  pageSlice,
  questionStatus
} from '../../../shared/questions'
import MindMap from '../components/MindMap/MindMap'
import Composer from './Composer'
import MarkdownAnswer from './MarkdownAnswer'
import Pager from './Pager'
import QuestionDetail from './QuestionDetail'
import ConceptPanel from './ConceptPanel'
import TidyBar from './TidyBar'
import Settings, { type SettingsCategory } from './Settings'
import ExportOptionsFields from './ExportOptionsFields'
import { Icon } from './ToolbarIcons'
import { NotificationBell } from './notifications'
import { Wordmark } from './Wordmark'
import { dateLabel, errorText, statuses, useSnapshot } from './common'
import {
  linkableConcepts,
  projectConcepts,
  questionTags,
  questionTree,
  relationHighlight,
  TAG_CHIPS
} from './questionTree'
import { canDropGraphNode, canMoveGraphNode, moveGraphNode } from './graphMove'
import { useT } from '../../../shared/i18n/react'
import { i18n } from '../../../shared/i18n'
import './personal.css'

type ItemKind = 'profile' | 'workspace' | 'project' | 'concept' | 'question'

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 360

/** Parses a card's Markdown only once it nears the visible part of the list; a page holds 10. */
function CardPreview({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (near || !el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true)
      },
      { root: el.closest('.records-scroll'), rootMargin: '400px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])
  return near ? (
    <MarkdownAnswer preview>{text}</MarkdownAnswer>
  ) : (
    <div ref={ref} className="card-preview-pending" />
  )
}

export default function Dashboard(): React.JSX.Element {
  const { data, refresh, error } = useSnapshot()
  const t = useT()
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
  const [selectedId, setSelectedIdState] = useState('')
  // Concept the open question was reached from (graph leaf or concept panel), and the open concept.
  const [focusConceptId, setFocusConceptId] = useState<string | null>(null)
  const [conceptId, setConceptId] = useState('')
  const setSelectedId = (id: string, fromConcept: string | null = null): void => {
    setSelectedIdState(id)
    setFocusConceptId(fromConcept)
    setConceptId('')
  }
  const [shortcut, setShortcut] = useState<ShortcutInfo | null>(null)
  useEffect(() => {
    void window.fask.shortcutInfo().then(setShortcut)
  }, [])
  const [view, setView] = useState<'timeline' | 'graph' | 'list'>('timeline'),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all')
  const [settingsSection, setSettingsSection] = useState<SettingsCategory | null>(null)
  const [captureIssue, setCaptureIssue] = useState<CaptureSetupReason>()
  const [captureNotice, setCaptureNotice] = useState<CaptureSetupReason>()
  useEffect(() => window.fask.onCaptureSetupRequired((issue) => {
    setCaptureIssue(issue.reason)
    setSettingsSection('capture')
  }), [])
  useEffect(() => window.fask.onCaptureRegionSaved(() => {
    setCaptureIssue(undefined)
    setCaptureNotice(undefined)
  }), [])
  const [compose, setCompose] = useState(false),
    [notice, setNotice] = useState(''),
    [exportOpts, setExportOpts] = useState<ExportOptions | null>(null),
    [exportBusy, setExportBusy] = useState(false)
  const [create, setCreate] = useState<{
      kind: ItemKind
      parent?: string
      id?: string
    } | null>(null),
    [name, setName] = useState('')
  const [move, setMove] = useState<{ id: string; name: string } | null>(null),
    [moveTarget, setMoveTarget] = useState('')
  const workspace = data?.workspaces.find((w) => w.id === workspaceId) ?? data?.workspaces[0]
  const projects = data?.projects.filter((p) => p.workspaceId === workspace?.id) ?? []
  const locked = !!workspace?.remote && workspace.remote.status !== 'online'
  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  useEffect(() => {
    if (project && scope === 'project') void window.fask.activateProject(project.id).catch(() => {})
  }, [project?.id, scope])
  const questions = useMemo(
    () => data?.questions.filter((q) => q.projectId === project?.id) ?? [],
    [data?.questions, project?.id]
  )
  const filtered = useMemo(
    () => filterQuestions(questions, filter, query),
    [questions, filter, query]
  )
  const [page, setPage] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [headerCollapsed, setHeaderCollapsed] = useState(
    () => localStorage.getItem('fask:library-header-collapsed') === '1'
  )
  useEffect(() => {
    localStorage.setItem('fask:library-header-collapsed', headerCollapsed ? '1' : '0')
  }, [headerCollapsed])
  const collapsedHeader = scope === 'project' && headerCollapsed
  // The question note beside the list: a draggable width (0 = default split) and a full-width mode.
  const areaRef = useRef<HTMLDivElement>(null)
  const [detailWidth, setDetailWidth] = useState(() => Number(localStorage.getItem('fask:detail-width')) || 0)
  useEffect(() => {
    if (detailWidth) localStorage.setItem('fask:detail-width', String(detailWidth))
    else localStorage.removeItem('fask:detail-width')
  }, [detailWidth])
  const [detailExpanded, setDetailExpanded] = useState(() => localStorage.getItem('fask:detail-expanded') === '1')
  useEffect(() => {
    localStorage.setItem('fask:detail-expanded', detailExpanded ? '1' : '0')
  }, [detailExpanded])
  const resizingDetail = useRef(false)
  /** Keeps the list at least 300px (plus the 24px handle) and the note at least 340px. */
  const clampDetail = (width: number): number =>
    Math.round(Math.max(340, Math.min((areaRef.current?.clientWidth ?? 0) - 324, width)))
  // The sidebar: a draggable width (0 = default) and a collapsed mode, both remembered.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('fask:sidebar-collapsed') === '1'
  )
  useEffect(() => {
    localStorage.setItem('fask:sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('fask:sidebar-width')) || 0)
  useEffect(() => {
    if (sidebarWidth) localStorage.setItem('fask:sidebar-width', String(sidebarWidth))
    else localStorage.removeItem('fask:sidebar-width')
  }, [sidebarWidth])
  const sidebarRef = useRef<HTMLElement>(null)
  const resizingSidebar = useRef(false)
  const clampSidebar = (w: number): number => Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)))
  // After a toggle, focus moves to the button that undoes it (the clicked one unmounts).
  const toggleFocus = useRef(false)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!toggleFocus.current) return
    toggleFocus.current = false
    ;(sidebarCollapsed ? expandRef : collapseRef).current?.focus()
  }, [sidebarCollapsed])
  const toggleSidebar = (collapsed: boolean): void => {
    toggleFocus.current = true
    setSidebarCollapsed(collapsed)
  }
  const paged = useMemo(() => pageSlice(filtered, page), [filtered, page])
  useEffect(() => setPage(1), [project?.id])
  const graphRoot = useMemo(
    () => (data && project ? questionTree(data, project.id, filtered) : null),
    [data, project?.id, filtered]
  )
  const selected = questions.find((q) => q.id === selectedId)
  const { concepts, shared } = useMemo(
    () => (data && project ? projectConcepts(data, project.id) : { concepts: [], shared: new Set<string>() }),
    [data, project?.id]
  )
  const linkable = useMemo(
    () => (data && project ? linkableConcepts(data, project.id) : []),
    [data, project?.id]
  )
  const openConcept = conceptId ? data?.concepts.find((c) => c.id === conceptId) : undefined
  // Only while a concept's panel is open: it and its related concepts stand out in the graph.
  const highlight = useMemo(
    () => (data && openConcept ? relationHighlight(data, openConcept.id) : undefined),
    [data, openConcept]
  )
  // The selected concept and its related concepts; MindMap frames those that are visible.
  const focusIds = useMemo(
    () => (highlight ? [highlight.focus, ...Object.keys(highlight.related)] : undefined),
    [highlight]
  )
  useEffect(() => {
    void window.fask.focusQuestion(selected?.id ?? null).catch(() => {})
  }, [selected?.id])
  const openReference = (ref: Reference): void => {
    if (ref.kind === 'concept') {
      setSelectedId('')
      setConceptId(ref.id)
      return
    }
    const target = data?.questions.find((q) => q.id === ref.id)
    if (!target) return
    if (target.projectId !== project?.id) {
      const owner = data?.projects.find((p) => p.id === target.projectId)
      if (!owner) return
      setSearch({ scope: 'project', workspace: owner.workspaceId, project: owner.id })
    }
    setCompose(false)
    setSelectedId(target.id)
  }
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      setNotice('')
      setCaptureNotice(undefined)
      await fn()
      await refresh()
      return true
    } catch (e) {
      setNotice(errorText(e))
      return false
    }
  }
  const openScreenQuestion = async (projectId: string, questionId?: string): Promise<void> => {
    setNotice('')
    setCaptureNotice(undefined)
    try {
      const result = await window.fask.openOverlay(projectId, questionId)
      if (!result.ok) {
        setCaptureIssue(result.reason)
        setCaptureNotice(result.reason)
      }
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  const openCaptureSettings = (): void => {
    setCaptureIssue(captureNotice)
    setSettingsSection('capture')
  }
  const dismissNotice = (): void => {
    setNotice('')
    setCaptureNotice(undefined)
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
  if (!data) return <div className="fask-loading">{error || t('나의 질문 공간을 열고 있습니다…')}</div>
  return (
    <div className="fask-app">
      {!sidebarCollapsed && (
        <aside
          ref={sidebarRef}
          className="fask-sidebar"
          inert={!!settingsSection}
          style={sidebarWidth ? ({ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties) : undefined}
        >
          <div className="fask-wordmark">
            <Wordmark />
            <small>{t('개인용')}</small>
            <button
              ref={collapseRef}
              className="sidebar-toggle"
              aria-label={t('사이드바 접기')}
              title={t('사이드바 접기')}
              aria-expanded
              onClick={() => toggleSidebar(true)}
            >
              <Icon name="sidebar" />
            </button>
          </div>
          <label className="sidebar-label">
            {t('프로필')}
            <select
              aria-label={t('프로필')}
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
            <Icon name="plus" size={14} />
            {t('프로필 추가')}
          </button>
          <div className="sidebar-heading">
            {t('워크스페이스')}
            <button aria-label={t('워크스페이스 추가')} onClick={() => beginCreate('workspace')}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          <select
            aria-label={t('워크스페이스')}
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
                {w.remote ? t('{{name}} (원격)', { name: w.name }) : w.name}
              </option>
            ))}
          </select>
          {workspace?.remote && (
            <span className="sidebar-remote">
              <Icon name="globe" size={14} />
              <span>{workspace.remote.name}</span>
              <small>
                {t(
                  {
                    online: '온라인',
                    offline: '오프라인 (변경 불가)',
                    revoked: '연결 해제됨',
                    blocked: '인증서 불일치'
                  }[workspace.remote.status]
                )}
              </small>
            </span>
          )}
          {workspace && (
            <button
              className="sidebar-rename"
              disabled={locked}
              onClick={() => beginRename('workspace', workspace.id, workspace.name)}
            >
              <Icon name="edit" size={14} />
              {t('워크스페이스 이름 변경')}
            </button>
          )}
          <div className="sidebar-heading">
            {t('프로젝트')}
            <button
              aria-label={t('프로젝트 추가')}
              disabled={locked}
              onClick={() => beginCreate('project', workspace?.id)}
            >
              <Icon name="plus" size={14} />
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
                  setCompose(false)
                }}
              >
                {p.name}
                <small>{data.questions.filter((q) => q.projectId === p.id).length}</small>
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-status">
              {t('로컬에 저장 중')}
              <small>{t('이미지 {{size}} MB', { size: (data.storageBytes / 1024 / 1024).toFixed(1) })}</small>
            </div>
            <NotificationBell />
            <button onClick={() => {
              setCaptureIssue(undefined)
              setSettingsSection('ai')
            }}>
              <Icon name="gear" />
              {t('설정과 AI 연결')}
            </button>
            <small>
              {shortcut?.accelerator ? (
                shortcut.accelerator.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' + ')
              ) : (
                <>
                  <b>{t('단축키를 등록하지 못했습니다')}</b>
                  {t('다른 앱이 같은 키를 쓰는지 확인하세요.')}
                </>
              )}
              <br />
              {shortcut?.fallback && `${t('대체 단축키')}: `}
              {t('화면 질문 열기, 패널 토글')}
            </small>
          </div>
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('사이드바 너비 조절')}
            title={t('드래그해서 너비 조절, 두 번 눌러 기본값')}
            tabIndex={0}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarWidth || undefined}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              resizingSidebar.current = true
            }}
            onPointerMove={(e) => {
              const aside = sidebarRef.current
              if (!resizingSidebar.current || !aside) return
              // The app root is CSS-zoomed by --ui-zoom; convert client px to layout px.
              const rect = aside.getBoundingClientRect()
              setSidebarWidth(clampSidebar((e.clientX - rect.left) * (aside.offsetWidth / rect.width || 1)))
            }}
            onPointerUp={() => (resizingSidebar.current = false)}
            onPointerCancel={() => (resizingSidebar.current = false)}
            onDoubleClick={() => setSidebarWidth(0)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              const current = sidebarWidth || sidebarRef.current?.offsetWidth || 240
              setSidebarWidth(clampSidebar(current + (e.key === 'ArrowRight' ? 16 : -16)))
            }}
          />
        </aside>
      )}
      <main className={`fask-main${scope === 'project' ? ' project-scope' : ''}`} inert={!!settingsSection}>
        <nav className="breadcrumb" aria-label={t('상위 경로')}>
          {sidebarCollapsed && (
            <>
              <button
                ref={expandRef}
                className="sidebar-toggle"
                aria-label={t('사이드바 펼치기')}
                title={t('사이드바 펼치기')}
                aria-expanded={false}
                onClick={() => toggleSidebar(false)}
              >
                <Icon name="sidebar" />
              </button>
              <NotificationBell compact />
            </>
          )}
          <button
            aria-label={t('이전 화면')}
            disabled={!window.history.state?.idx}
            onClick={() => navigate(-1)}
          >
            <Icon name="back" />
          </button>
          <button
            onClick={() => {
              setSearch({ scope: 'home' })
              setSelectedId('')
              setCompose(false)
            }}
          >
            {t('내 공간')}
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
        <header className={collapsedHeader ? 'project-header collapsed' : 'project-header'}>
          <div>
            <h1>
              {scope === 'home'
                ? t('내 공간')
                : scope === 'workspace'
                  ? workspace?.name
                  : project?.name || t('프로젝트를 만들어 보세요')}
              {scope === 'project' && project && (
                <button
                  className="title-rename"
                  aria-label={t('프로젝트 이름 변경')}
                  onClick={() => beginRename('project', project.id, project.name)}
                >
                  <Icon name="edit" />
                </button>
              )}
              {scope === 'project' && (
                <button
                  className={`header-collapse${headerCollapsed ? ' collapsed' : ''}`}
                  aria-expanded={!headerCollapsed}
                  aria-label={headerCollapsed ? t('정보 펼치기') : t('정보 접기')}
                  title={headerCollapsed ? t('정보 펼치기') : t('정보 접기')}
                  onClick={() => setHeaderCollapsed((c) => !c)}
                >
                  <Icon name="up" />
                </button>
              )}
            </h1>
            {!collapsedHeader && (
              <p>
                {scope === 'project'
                  ? t('질문하고, 연결하고, 나의 지식으로.')
                  : t('생각을 이어갈 프로젝트를 선택하세요.')}
              </p>
            )}
          </div>
          <div className="button-row">
            {scope === 'project' ? (
              <>
                <button disabled={!project || locked} onClick={() => setExportOpts(EXPORT_DEFAULTS)}>
                  <Icon name="export" />
                  {t('기억 내보내기')}
                </button>
                <button
                  className={compose ? undefined : 'primary'}
                  disabled={!project}
                  onClick={() => void openScreenQuestion(project!.id)}
                >
                  <Icon name="capture" />
                  {t('화면에서 질문')}
                </button>
              </>
            ) : (
              <button
                className="primary"
                disabled={scope !== 'home' && locked}
                onClick={() =>
                  beginCreate(
                    scope === 'home' ? 'workspace' : 'project',
                    scope === 'home' ? undefined : workspace?.id
                  )
                }
              >
                <Icon name="plus" />
                {scope === 'home' ? t('워크스페이스 만들기') : t('프로젝트 만들기')}
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
                <span className="space-icon">
                  <Icon name={scope === 'home' ? 'workspace' : 'project'} size={18} />
                </span>
                <Icon name="right" className="space-card-go" />
                <h2>{item.name}</h2>
                <small>
                  {scope === 'home'
                    ? t('{{n}}개 프로젝트', { n: data.projects.filter((p) => p.workspaceId === item.id).length })
                    : t('{{n}}개 질문', { n: data.questions.filter((q) => q.projectId === item.id).length })}
                </small>
              </button>
            ))}
            {!(scope === 'home' ? data.workspaces : projects).length && (
              <div className="empty-state">
                <h2>{t('새 프로젝트를 만들어 시작하세요.')}</h2>
              </div>
            )}
          </section>
        ) : (
          <>
            {!headerCollapsed && (
            <div className="project-stats">
              <div>
                <b>{questions.length}</b>
                <span>{t('쌓인 질문')}</span>
              </div>
              <div>
                <b>{concepts.length}</b>
                <span>{t('연결된 개념')}</span>
              </div>
              <div>
                <b>{questions.filter((q) => q.important).length}</b>
                <span>{t('중요한 기억')}</span>
              </div>
              <div className="connection-note">
                {data.settings.model ? (
                  <>
                    <span>{t('AI 모델')}</span>
                    <b>{data.settings.model}</b>
                  </>
                ) : (
                  t('AI 연결을 설정해 주세요')
                )}
              </div>
            </div>
            )}
            {(captureNotice || notice || error) && (
              <div className="notice error" role="alert">
                {captureNotice ? t(captureSetupMessage(captureNotice)) : notice || error}
                {captureNotice && (
                  <button onClick={openCaptureSettings}>{t('캡처 영역 다시 설정')}</button>
                )}
                <button aria-label={t('닫기')} onClick={dismissNotice}>
                  <Icon name="close" size={14} />
                </button>
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
                    {t(label)}
                  </button>
                ))}
              </div>
              <button
                disabled={!project || locked}
                onClick={() => {
                  setCompose((s) => !s)
                  setSelectedId('')
                }}
              >
                <Icon name="plus" />
                {t('새 질문')}
              </button>
            </div>
            {compose && project && (
              <div className="compose-slot">
                <Composer
                  key={project.id}
                  projectId={project.id}
                  profileId={data.activeProfileId}
                  settings={data.settings}
                  host={workspace?.remote}
                  onSaved={(id) => {
                    setSelectedId(id)
                    void refresh()
                  }}
                />
              </div>
            )}
            <div className={`filter-row${collapsedHeader ? ' compact' : ''}`}>
              <label className="search-field">
                <Icon name="search" />
                <input
                  aria-label={t('기록 검색')}
                  placeholder={t('질문, 답변, 메모 검색')}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setPage(1)
                  }}
                />
              </label>
              <select
                aria-label={t('질문 필터')}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="all">{t('모든 질문')}</option>
                <option value="simple">{t('간단한 질문')}</option>
                <option value="complex">{t('복잡한 질문')}</option>
                <option value="unknown">{t('복잡도 미확정')}</option>
                <option value="important">{t('중요한 기억')}</option>
                <option value="unfiled">{t('미분류')}</option>
                <option value="failed">{t('요청 실패')}</option>
              </select>
              <span>{t('{{n}}개 기록', { n: filtered.length })}</span>
            </div>
            <div
              ref={areaRef}
              className={`knowledge-area ${selected || openConcept ? 'has-detail' : ''}${selected && detailExpanded ? ' detail-expanded' : ''}`}
              style={detailWidth ? ({ '--detail-w': `${detailWidth}px` } as React.CSSProperties) : undefined}
            >
              <section className="records-panel">
                {view === 'graph' && project && graphRoot ? (
                  <div className="graph-stage">
                    {workspace && (
                      <TidyBar
                        workspaceId={workspace.id}
                        workspaceName={workspace.name}
                        revision={data}
                        disabled={locked}
                      />
                    )}
                    <MindMap
                      key={project.id}
                      root={graphRoot}
                      highlight={highlight}
                      focusIds={focusIds}
                      height="100%"
                      actions={
                        !locked && (
                          <button onClick={() => beginCreate('concept', project.id)}>
                            <Icon name="plus" size={18} />
                            {t('개념 추가')}
                          </button>
                        )
                      }
                      onMoveNode={
                        locked
                          ? undefined
                          : (node, target, copy) =>
                              void run(() => moveGraphNode(window.fask, concepts, questions, node, target, copy))
                      }
                      canMove={canMoveGraphNode}
                      canDrop={canDropGraphNode}
                      onContextMenu={(node, event) => {
                        if (node.id.startsWith('q:')) {
                          const q = questions.find((q) => q.id === node.id.split(':')[1])
                          if (q) openContext(event, 'question', q.id, questionHeading(q))
                        } else if (node.id.startsWith('c:'))
                          openContext(event, 'concept', node.id.slice(2), node.label)
                        else if (node.id.startsWith('project:'))
                          openContext(event, 'project', project.id, project.name)
                      }}
                      onSelect={(node) => {
                        if (node.id.startsWith('q:')) {
                          const [, id, parent] = node.id.split(':')
                          setSelectedId(id, parent === 'unfiled' ? null : parent)
                        } else if (node.id.startsWith('c:')) {
                          setSelectedId('')
                          setConceptId(node.id.slice(2))
                        }
                      }}
                    />
                  </div>
                ) : filtered.length ? (
                  <>
                  <div className="records-scroll" ref={scrollRef}>
                  <div className={view === 'list' ? 'question-list compact' : 'question-list'}>
                    {paged.items.map((q, index) => {
                      const tags = questionTags(q, concepts).focus
                      const hidden = tags.slice(TAG_CHIPS)
                      return (
                        <div key={q.id}>
                          {view === 'timeline' &&
                            (index === 0 ||
                              new Date(paged.items[index - 1].createdAt).toDateString() !==
                                new Date(q.createdAt).toDateString()) && (
                              <h3 className="day-label">
                                {new Date(q.createdAt).toLocaleDateString(i18n.language === 'en' ? 'en-US' : 'ko-KR', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                  weekday: 'short'
                                })}
                              </h3>
                            )}
                          <button
                            className={`question-card ${selectedId === q.id ? 'selected' : ''}`}
                            onContextMenu={(e) => openContext(e, 'question', q.id, questionHeading(q))}
                            onClick={() => {
                              setSelectedId(q.id)
                              setCompose(false)
                            }}
                          >
                            <div className="question-meta">
                              <span className="chip">
                                {questionComplexity(q) === 'complex'
                                  ? t('깊이 탐구')
                                  : questionComplexity(q) === 'simple'
                                    ? t('빠른 질문')
                                    : t('미확정')}
                              </span>
                              {q.important && <span className="signal-chip">{t('중요')}</span>}
                              <span className="question-meta-end">
                                <time>{dateLabel(q.createdAt)}</time>
                                {q.turns.length > 1 && <span>{t('대화 {{n}}개', { n: q.turns.length })}</span>}
                                {q.memo.trim() !== '' && (
                                  <span className="memo-badge">
                                    <Icon name="note" size={14} />
                                    {t('메모 있음')}
                                  </span>
                                )}
                              </span>
                            </div>
                            <h3>{questionHeading(q)}</h3>
                            {view !== 'list' && (
                              <CardPreview
                                text={lastTurn(q).answer || t(lastTurn(q).error || '아직 답변이 없습니다.')}
                              />
                            )}
                            <div className="question-footer">
                              <span className="question-tags">
                                {tags.length ? (
                                  <>
                                    {tags.slice(0, TAG_CHIPS).map((c) => (
                                      <span key={c.id} className="concept-tag">
                                        {c.name}
                                        {shared.has(c.id) && (
                                          <span className="shared-badge">{t('공유')}</span>
                                        )}
                                      </span>
                                    ))}
                                    {hidden.length > 0 && (
                                      <span
                                        className="concept-tag more"
                                        title={hidden.map((c) => c.name).join(', ')}
                                      >
                                        +{hidden.length}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  t('미분류')
                                )}
                              </span>
                              <span className="question-status">
                                {questionImages(q).length > 0 && (
                                  <span title={t('이미지 있음')} aria-label={t('이미지 있음')}>
                                    <Icon name="image" size={14} />
                                  </span>
                                )}
                                {t(statuses[questionStatus(q)])}
                              </span>
                            </div>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  </div>
                  <Pager
                    page={paged.page}
                    pages={paged.pages}
                    onPage={(p) => {
                      setPage(p)
                      scrollRef.current?.scrollTo({ top: 0 })
                    }}
                  />
                  </>
                ) : (
                  <div className="empty-state">
                    <span className="empty-state-mark">
                      <Icon name="ask" size={20} />
                    </span>
                    <h2>
                      {query || filter !== 'all'
                        ? t('일치하는 기록이 없습니다')
                        : t('첫 번째 궁금함을 남겨보세요')}
                    </h2>
                    <p>
                      {t('화면에 표시하고 질문하거나, 생각을 글로 남기세요.')}
                      <br />
                      {t('질문과 답변은 이 프로젝트에 차곡차곡 쌓입니다.')}
                    </p>
                    <button onClick={() => setCompose(true)}>
                      <Icon name="plus" />
                      {t('새 질문')}
                    </button>
                  </div>
                )}
              </section>
              {(selected || openConcept) && !(selected && detailExpanded) && (
                <div
                  className="detail-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('질문 노트 너비 조절')}
                  title={t('드래그해서 너비 조절, 두 번 눌러 기본값')}
                  tabIndex={0}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.currentTarget.setPointerCapture(e.pointerId)
                    resizingDetail.current = true
                  }}
                  onPointerMove={(e) => {
                    const area = areaRef.current
                    if (resizingDetail.current && area)
                      setDetailWidth(clampDetail(area.getBoundingClientRect().right - e.clientX - 12))
                  }}
                  onPointerUp={() => (resizingDetail.current = false)}
                  onPointerCancel={() => (resizingDetail.current = false)}
                  onDoubleClick={() => setDetailWidth(0)}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                    e.preventDefault()
                    const current = areaRef.current?.lastElementChild?.getBoundingClientRect().width ?? 0
                    setDetailWidth(clampDetail(current + (e.key === 'ArrowLeft' ? 32 : -32)))
                  }}
                />
              )}
              {selected && project ? (
                <QuestionDetail
                  key={selected.id}
                  question={selected}
                  concepts={linkable}
                  shared={shared}
                  focusConceptId={focusConceptId}
                  onReference={openReference}
                  run={run}
                  onClose={() => {
                    // Reached from a concept: closing the question goes back to that concept.
                    const back = focusConceptId
                    setSelectedId('')
                    if (back) setConceptId(back)
                  }}
                  onCreateConcept={async (name) => {
                    const id = await window.fask.create('concept', name, project.id)
                    await window.fask.updateQuestion(selected.id, {
                      conceptIds: [...new Set([...selected.conceptIds, id])],
                      suggestions: selected.suggestions.filter((s) => s !== name)
                    })
                  }}
                  onContinue={() =>
                    void openScreenQuestion(selected.projectId, selected.id)
                  }
                  expanded={detailExpanded}
                  onToggleExpand={() => setDetailExpanded((x) => !x)}
                />
              ) : (
                openConcept &&
                project && (
                  <ConceptPanel
                    key={openConcept.id}
                    data={data}
                    conceptId={openConcept.id}
                    projectId={project.id}
                    run={run}
                    onOpenQuestion={(id, from) => setSelectedId(id, from)}
                    onOpenConcept={setConceptId}
                    onClose={() => setConceptId('')}
                  />
                )
              )}
            </div>
          </>
        )}
      </main>
      {(captureNotice || notice) && scope !== 'project' && (
        <div className="global-notice notice error" role="alert">
          {captureNotice ? t(captureSetupMessage(captureNotice)) : notice}
          {captureNotice && (
            <button onClick={openCaptureSettings}>{t('캡처 영역 다시 설정')}</button>
          )}
          <button aria-label={t('닫기')} onClick={dismissNotice}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {context && (
        <div
          className="item-context-menu"
          role="menu"
          aria-label={t('항목 메뉴')}
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
            <Icon name="edit" />
            {t('편집, 이름 바꾸기')}
          </button>
          {context.kind === 'question' && (
            <button
              role="menuitem"
              onClick={() => {
                setMove({ id: context.id, name: context.name })
                setMoveTarget('')
                setNotice('')
                setContext(null)
              }}
            >
              <Icon name="move" />
              {t('다른 프로젝트로 이동')}
            </button>
          )}
          <hr />
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
              })
            }}
          >
            <Icon name="trash" />
            {t('삭제')}
          </button>
        </div>
      )}
      {settingsSection && (
        <Settings
          settings={data.settings}
          initialCategory={settingsSection}
          captureIssue={captureIssue}
          onClose={() => setSettingsSection(null)}
        />
      )}
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
            <h2>
              {t(create.id ? '{{kind}} 이름 변경' : '{{kind}} 만들기', {
                kind: t(
                  {
                    profile: '프로필',
                    workspace: '워크스페이스',
                    project: '프로젝트',
                    concept: '개념',
                    question: '질문'
                  }[create.kind]
                )
              })}
            </h2>
            <input
              aria-label={t('이름')}
              autoFocus
              placeholder={t('이름을 입력하세요')}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
            {notice && <p className="error">{notice}</p>}
            <div className="button-row">
              <button type="button" onClick={() => setCreate(null)}>
                {t('취소')}
              </button>
              <button className="primary" disabled={!name.trim()}>
                {create.id ? t('저장') : t('만들기')}
              </button>
            </div>
          </form>
        </div>
      )}
      {move && (
        <div className="modal-backdrop">
          <form
            className="create-modal"
            onSubmit={(e) => {
              e.preventDefault()
              const { id } = move
              void run(async () => {
                await window.fask.moveQuestion(id, moveTarget)
                if (id === selectedId) setSelectedId('')
                setMove(null)
              })
            }}
          >
            <h2>{t('다른 프로젝트로 이동')}</h2>
            <p>{move.name}</p>
            <select
              aria-label={t('이동할 프로젝트')}
              autoFocus
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
            >
              <option value="">{t('프로젝트 선택')}</option>
              {data.workspaces.map((w) => {
                const current = data.questions.find((q) => q.id === move.id)?.projectId
                const targets = data.projects.filter((p) => p.workspaceId === w.id && p.id !== current)
                return (
                  targets.length > 0 && (
                    <optgroup key={w.id} label={w.name}>
                      {targets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )
                )
              })}
            </select>
            {notice && <p className="error">{notice}</p>}
            <div className="button-row">
              <button type="button" onClick={() => setMove(null)}>
                {t('취소')}
              </button>
              <button className="primary" disabled={!moveTarget}>
                {t('이동')}
              </button>
            </div>
          </form>
        </div>
      )}
      {exportOpts !== null && project && (
        <div className="modal-backdrop">
          <form
            className="create-modal"
            onSubmit={(e) => {
              e.preventDefault()
              const options = exportOpts
              setExportBusy(true)
              void run(async () => {
                await window.fask.export(project.id, options)
                setExportOpts(null)
              }).finally(() => setExportBusy(false))
            }}
          >
            <h2>{t('기억 내보내기')}</h2>
            <p>
              {t(
                '질문, 개념, 관계를 zip 파일 하나로 내보냅니다. 다른 LLM이 읽을 안내(README)와 SKOS 온톨로지가 함께 들어갑니다.'
              )}
            </p>
            <ExportOptionsFields
              value={exportOpts}
              onChange={setExportOpts}
              images={new Set(questions.flatMap(questionImages)).size}
              host={workspace?.remote?.name}
            />
            {notice && <p className="error">{notice}</p>}
            <div className="button-row">
              <button type="button" disabled={exportBusy} onClick={() => setExportOpts(null)}>
                {t('취소')}
              </button>
              <button className="primary" disabled={exportBusy} autoFocus>
                {exportBusy ? t('준비 중…') : t('내보내기')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

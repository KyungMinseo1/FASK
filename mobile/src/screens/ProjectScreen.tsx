import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { App } from '@capacitor/app'
import type { Question } from '@desktop/preload/personal'
import {
  filterQuestions,
  lastTurn,
  questionComplexity,
  questionHeading,
  questionImages,
  pageSlice,
  questionStatus
} from '@desktop/shared/questions'
import MindMap from '@desktop/renderer/src/components/MindMap/MindMap'
import { useApi } from '@desktop/renderer/src/personal/api'
import {
  canDropGraphNode,
  canMoveGraphNode,
  moveGraphNode
} from '@desktop/renderer/src/personal/graphMove'
import { dateLabel, errorText, statuses } from '@desktop/renderer/src/personal/common'
import Composer from '@desktop/renderer/src/personal/Composer'
import MarkdownAnswer from '@desktop/renderer/src/personal/MarkdownAnswer'
import Pager from '@desktop/renderer/src/personal/Pager'
import QuestionDetail from '@desktop/renderer/src/personal/QuestionDetail'
import { questionTree } from '@desktop/renderer/src/personal/questionTree'
import { useT } from '@desktop/shared/i18n/react'
import { useMobile } from '../context'
import { mediaActions } from '../media'
import { Icon } from '../icons'
import {
  isAndroidOverlay,
  isOverlayCancellation,
  overlayControl,
  previewOverlay,
  type OverlayStatus
} from '../overlay/control'
import { loadPairing } from '../storage'
import { HubError, nativeTransport } from '../transport'

const FILTERS = [
  ['all', '전체'],
  ['important', '중요'],
  ['unfiled', '미분류'],
  ['failed', '실패'],
  ['simple', '빠른 질문'],
  ['complex', '깊이 탐구']
] as const

const lastPage = new Map<string, number>()

function useWide(): boolean {
  const query = '(min-width: 900px)'
  const [wide, setWide] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const list = matchMedia(query)
    const update = (): void => setWide(list.matches)
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [])
  return wide
}

export default function ProjectScreen(): React.JSX.Element {
  const { projectId = '', questionId } = useParams()
  const { data, refresh } = useMobile()
  const api = useApi()
  const [graphError, setGraphError] = useState('')
  const navigate = useNavigate()
  const t = useT()
  const wide = useWide()
  const project = data.projects.find((p) => p.id === projectId)
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [view, setView] = useState<'list' | 'graph'>('list'),
    [menu, setMenu] = useState<Question | null>(null)
  const questions = useMemo(
    () => data.questions.filter((q) => q.projectId === projectId),
    [data.questions, projectId]
  )
  const filtered = useMemo(() => filterQuestions(questions, filter, query), [questions, filter, query])
  const graph = useMemo(() => questionTree(data, projectId, filtered), [data, projectId, filtered])
  const projectConcepts = data.concepts.filter((c) => c.projectId === projectId)
  const workspace = data.workspaces.find((w) => w.id === project?.workspaceId)
  const locked = !!workspace?.remote && workspace.remote.status !== 'online'
  const [page, setPageState] = useState(() => lastPage.get(projectId) ?? 1)
  const setPage = (p: number): void => {
    lastPage.set(projectId, p)
    setPageState(p)
  }
  const paged = useMemo(() => pageSlice(filtered, page), [filtered, page])
  const listRef = useRef<HTMLElement>(null)
  if (!project) return <Navigate404 />
  const concepts = data.concepts.filter((c) => c.projectId === projectId)
  const open = (id: string): void => void navigate(`/p/${projectId}/q/${id}`)
  const list = (
    <section className="mobile-list" ref={listRef}>
      <div className="filter-row">
        <label className="search-field">
          <Icon name="search" size={18} />
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
      </div>
      <div className="mobile-chips" role="tablist">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? 'active' : ''}
            onClick={() => {
              setFilter(id)
              setPage(1)
            }}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className="segmented">
        <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
          {t('목록')}
        </button>
        <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
          {t('개념 그래프')}
        </button>
      </div>
      {view === 'graph' ? (
        <>
          {graphError && (
            <p className="notice error" role="alert">
              {graphError}
            </p>
          )}
          <MindMap
            root={graph}
            height="70vh"
            allowCopy={false}
            onMoveNode={
              locked
                ? undefined
                : (node, target) => {
                    setGraphError('')
                    void moveGraphNode(api, projectConcepts, questions, node, target, false)
                      .then(refresh)
                      .catch((e) => setGraphError(errorText(e)))
                  }
            }
            canMove={canMoveGraphNode}
            canDrop={canDropGraphNode}
            onSelect={(node) => {
              if (node.id.startsWith('q:')) open(node.id.split(':')[1])
            }}
          />
        </>
      ) : filtered.length ? (
        <>
          <div className="question-list">
            {paged.items.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              selected={q.id === questionId}
              concepts={concepts}
              onOpen={() => open(q.id)}
              onMenu={() => setMenu(q)}
            />
          ))}
          </div>
          <Pager
            page={paged.page}
            pages={paged.pages}
            onPage={(p) => {
              setPage(p)
              listRef.current?.scrollIntoView({ block: 'start' })
            }}
          />
        </>
      ) : (
        <div className="empty-state">
          <h2>{query || filter !== 'all' ? t('일치하는 기록이 없습니다') : t('첫 질문을 남겨 보세요')}</h2>
        </div>
      )}
    </section>
  )
  const detail = questionId ? (
    <Detail key={questionId} projectId={projectId} questionId={questionId} />
  ) : (
    <div className="empty-state">
      <h2>{t('질문을 선택하세요')}</h2>
    </div>
  )
  const fab = (
    <div className="mobile-fab">
      <button className="primary" onClick={() => navigate(`/p/${projectId}/new`)}>
        <Icon name="plus" size={18} />
        {t('새 질문')}
      </button>
    </div>
  )
  return (
    <>
      <header className="mobile-top">
        <button aria-label={t('뒤로')} onClick={() => navigate(questionId && !wide ? `/p/${projectId}` : '/')}>
          <Icon name="back" />
        </button>
        <h1>{project.name}</h1>
        {isAndroidOverlay() && <ScreenQuestionControl projectId={projectId} />}
        <button onClick={() => navigate('/settings')}>{t('설정')}</button>
      </header>
      <main className={wide ? 'mobile-body project-split' : 'mobile-body'}>
        {wide ? (
          <>
            {/* The button lives in the list column so the detail pane reaches its bottom edge. */}
            <div className="mobile-list-column">
              {list}
              {fab}
            </div>
            {detail}
          </>
        ) : questionId ? (
          detail
        ) : (
          list
        )}
      </main>
      {!questionId && !wide && fab}
      {menu && (
        <QuestionSheet
          key={menu.id}
          question={menu}
          projectId={projectId}
          currentId={questionId}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

function ScreenQuestionControl({ projectId }: { projectId: string }): React.JSX.Element {
  const mobile = useMobile()
  const t = useT()
  const current = useRef({ mobile, projectId })
  current.current = { mobile, projectId }
  const [status, setStatus] = useState<OverlayStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const refresh = (): void => {
      void overlayControl.status().then(
        (value) => { if (mounted.current) setStatus(value) },
        (error) => { if (mounted.current) setMessage(errorText(error)) }
      )
    }
    refresh()
    const listener = App.addListener('resume', refresh)
    return () => {
      mounted.current = false
      void listener.then((handle) => handle.remove())
    }
  }, [])

  const act = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const state = await overlayControl.status()
      if (!mounted.current) return
      setStatus(state)
      if (state.running) {
        await overlayControl.stop()
        if (mounted.current) setStatus(await overlayControl.status())
        return
      }
      const initial = current.current
      // The demo hub has no PC to stream to; show the native toolbar preview instead.
      if (initial.mobile.demo) {
        await previewOverlay()
        return
      }
      if (initial.mobile.conn.state !== 'online')
        throw new Error(t('PC에 연결된 상태에서 화면 질문을 시작해 주세요.'))
      if (!initial.mobile.data.projects.some((item) => item.id === projectId))
        throw new Error(t('프로젝트를 찾을 수 없습니다.'))
      if (!window.confirm(
        t(
          '다른 앱 위에 FASK 토글을 표시하고 이번 세션 동안 전체 디스플레이를 공유합니다. 전역 펜 좌표를 맞추려면 전체 화면 공유가 필요합니다. 전체 화면을 자동 전송하지 않으며, 질문 전송 시 선택한 영역만 첨부합니다. 보호된 화면은 캡처되지 않거나 검게 보일 수 있습니다. 계속할까요?'
        )
      )) return
      if (!state.overlayAllowed) {
        await overlayControl.requestOverlayPermission()
        if (mounted.current) {
          setStatus(await overlayControl.status())
          setMessage(t('다른 앱 위에 표시 권한을 허용한 뒤 화면 위에서 질문 버튼을 다시 눌러 주세요.'))
        }
        return
      }
      const pairing = await loadPairing()
      const expected = initial.mobile.pairing
      if (!pairing || pairing.fingerprint !== expected.fingerprint ||
          pairing.token !== expected.token || pairing.port !== expected.port ||
          JSON.stringify(pairing.addresses) !== JSON.stringify(expected.addresses) ||
          JSON.stringify(pairing.relay ?? null) !== JSON.stringify(expected.relay ?? null))
        throw new Error(t('페어링이 변경되었습니다. 연결 상태를 확인해 주세요.'))
      // A cached snapshot must not authorize a new screen-sharing session.
      const response = await nativeTransport.request(
        pairing, initial.mobile.client.address(), 'POST', '/rpc/snapshot', '{"args":[]}', 15_000
      )
      if (response.status < 200 || response.status >= 300)
        throw new Error(t('PC의 최신 프로젝트 정보를 확인할 수 없습니다.'))
      const envelope: unknown = JSON.parse(response.body)
      if (!envelope || typeof envelope !== 'object' || !('result' in envelope))
        throw new Error(t('PC의 프로젝트 응답을 읽을 수 없습니다.'))
      const latest = envelope.result
      if (!latest || typeof latest !== 'object' ||
          !('activeProfileId' in latest) || typeof latest.activeProfileId !== 'string' ||
          !('profiles' in latest) || !Array.isArray(latest.profiles) ||
          !('projects' in latest) || !Array.isArray(latest.projects) ||
          !('workspaces' in latest) || !Array.isArray(latest.workspaces) ||
          !('questions' in latest) || !Array.isArray(latest.questions))
        throw new Error(t('PC의 프로젝트 응답을 읽을 수 없습니다.'))
      const now = current.current
      if (!mounted.current) return
      if (now.mobile.client !== initial.mobile.client || now.projectId !== initial.projectId ||
          now.mobile.conn.state !== 'online' ||
          now.mobile.data.activeProfileId !== initial.mobile.data.activeProfileId)
        throw new Error(t('현재 화면이나 연결이 변경되었습니다. 다시 시작해 주세요.'))
      const profileId = latest.activeProfileId
      const project = latest.projects.find((item) => item.id === projectId)
      if (profileId !== initial.mobile.data.activeProfileId ||
          !latest.profiles.some((item) => item.id === profileId) ||
          !project || !latest.workspaces.some(
            (item) => item.id === project.workspaceId && item.profileId === profileId
          ))
        throw new Error(t('현재 프로필에 프로젝트가 없습니다. 프로젝트를 다시 열어 주세요.'))
      await overlayControl.start({ pairing, profileId, projectId })
      if (mounted.current) setStatus(await overlayControl.status())
    } catch (error) {
      if (error instanceof HubError && error.code === 'UNAUTHORIZED')
        await current.current.mobile.unpair(error.message)
      if (mounted.current && !isOverlayCancellation(error)) setMessage(errorText(error))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <>
      <button disabled={busy || !status} onClick={() => void act()}>
        {busy ? t('처리 중…') : status?.running ? t('화면 질문 실행 중 / 종료') : t('화면 위에서 질문')}
      </button>
      {message && <p role="status" className="mobile-header-message">{message}</p>}
    </>
  )
}

function Navigate404(): React.JSX.Element {
  const t = useT()
  return (
    <main className="mobile-body">
      <div className="empty-state">
        <h2>{t('프로젝트를 찾을 수 없습니다.')}</h2>
        <Link to="/">{t('처음으로')}</Link>
      </div>
    </main>
  )
}

type SheetMode = 'actions' | 'rename' | 'delete' | 'move'

function QuestionSheet({
  question: q,
  projectId,
  currentId,
  onClose
}: {
  question: Question
  projectId: string
  currentId?: string
  onClose: () => void
}): React.JSX.Element {
  const { data, refresh } = useMobile()
  const api = useApi()
  const navigate = useNavigate()
  const t = useT()
  const [mode, setMode] = useState<SheetMode>('actions')
  const workspaceId = data.projects.find((p) => p.id === projectId)?.workspaceId
  const owner = data.workspaces.find((w) => w.id === workspaceId)?.remote?.peerId
  const [name, setName] = useState(() => questionHeading(q))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<void>, after?: () => void): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onClose()
      after?.()
      void refresh()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  return (
    <div className="mobile-sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={questionHeading(q)}
        onClick={(e) => e.stopPropagation()}
      >
        <strong>{questionHeading(q)}</strong>
        {mode === 'actions' && (
          <>
            <button onClick={() => setMode('rename')}>{t('이름 바꾸기')}</button>
            <button onClick={() => setMode('move')}>{t('다른 프로젝트로 이동')}</button>
            <button className="danger" onClick={() => setMode('delete')}>
              {t('삭제')}
            </button>
          </>
        )}
        {mode === 'rename' && (
          <>
            <input aria-label={t('질문 이름')} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <button
              className="primary"
              disabled={busy || !name.trim()}
              onClick={() => void run(() => api.rename('question', q.id, name.trim()))}
            >
              {t('저장')}
            </button>
          </>
        )}
        {mode === 'delete' && (
          <>
            <p>{t('이 질문을 삭제할까요?')}</p>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.remove('question', q.id),
                  () => {
                    if (q.id === currentId) navigate(`/p/${projectId}`)
                  }
                )
              }
            >
              {t('삭제')}
            </button>
          </>
        )}
        {mode === 'move' &&
          data.workspaces.map((w) => {
            // Questions cannot cross the local/remote boundary; the PC refuses it anyway.
            if (w.remote?.peerId !== owner) return null
            const targets = data.projects.filter((p) => p.workspaceId === w.id && p.id !== projectId)
            if (!targets.length) return null
            return (
              <div key={w.id} className="mobile-sheet-group">
                <small>{w.name}</small>
                {targets.map((p) => (
                  <button
                    key={p.id}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.moveQuestion(q.id, p.id),
                        () => navigate(`/p/${p.id}`)
                      )
                    }
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )
          })}
        {error && <p className="notice error">{error}</p>}
        <button disabled={busy} onClick={onClose}>
          {t('취소')}
        </button>
      </div>
    </div>
  )
}

function QuestionCard({
  question: q,
  selected,
  concepts,
  onOpen,
  onMenu
}: {
  question: Question
  selected: boolean
  concepts: { id: string; name: string }[]
  onOpen: () => void
  onMenu: () => void
}): React.JSX.Element {
  const t = useT()
  const complexity = questionComplexity(q)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const longPressed = useRef(false)
  const cancel = (): void => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancel, [])
  return (
    <button
      className={`question-card ${selected ? 'selected' : ''}`}
      onPointerDown={(e) => {
        cancel()
        longPressed.current = false
        const timer = window.setTimeout(() => {
          press.current = null
          longPressed.current = true
          onMenu()
        }, 500)
        press.current = { timer, x: e.clientX, y: e.clientY }
      }}
      onPointerMove={(e) => {
        const p = press.current
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false
          return
        }
        onOpen()
      }}
    >
      <div className="question-meta">
        <span className="chip">
          {t(complexity === 'complex' ? '깊이 탐구' : complexity === 'simple' ? '빠른 질문' : '미확정')}
        </span>
        {q.important && <span className="signal-chip">{t('중요')}</span>}
        {q.memo.trim() !== '' && (
          <span className="memo-badge" title={t('메모 있음')}>
            <Icon name="pen" size={14} />
            {t('메모')}
          </span>
        )}
        <time className="question-meta-end">{dateLabel(q.createdAt)}</time>
      </div>
      <h3>{questionHeading(q)}</h3>
      <MarkdownAnswer preview>
        {lastTurn(q).answer || lastTurn(q).error || t('아직 답변이 없습니다.')}
      </MarkdownAnswer>
      <div className="question-footer">
        <span className="question-tags">
          {(() => {
            const names = q.conceptIds
              .map((id) => concepts.find((c) => c.id === id)?.name)
              .filter((name): name is string => !!name)
            return (names.length ? names : [t('미분류')]).map((name, i) => (
              <span key={i} className="tag">
                {name}
              </span>
            ))
          })()}
        </span>
        {q.turns.length > 1 && <span>{t('대화 {{n}}개', { n: q.turns.length })}</span>}
        <small>
          {t(statuses[questionStatus(q)])}
          {questionImages(q).length > 0 && <Icon name="image" size={16} />}
        </small>
      </div>
    </button>
  )
}

function Detail({ projectId, questionId }: { projectId: string; questionId: string }): React.JSX.Element {
  const { data, refresh } = useMobile()
  const api = useApi()
  const navigate = useNavigate()
  const t = useT()
  const [notice, setNotice] = useState('')
  const question = data.questions.find((q) => q.id === questionId)
  // A turn already running on arrival (e.g. sent from the new-question screen) keeps streaming here.
  const [running] = useState(() =>
    question && lastTurn(question).status === 'running' ? question : undefined
  )
  if (!question)
    return (
      <div className="empty-state">
        <h2>{t('삭제되었거나 찾을 수 없는 질문입니다.')}</h2>
        <Link to={`/p/${projectId}`}>{t('목록으로')}</Link>
      </div>
    )
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      setNotice('')
      await fn()
      await refresh()
      return true
    } catch (e) {
      setNotice(errorText(e))
      return false
    }
  }
  return (
    <section className="mobile-detail">
      {notice && <p className="notice error">{notice}</p>}
      <QuestionDetail
        question={question}
        concepts={data.concepts.filter((c) => c.projectId === projectId)}
        run={run}
        onClose={() => navigate(-1)}
        onCreateConcept={async (name) => {
          const id = await api.create('concept', name, projectId)
          await api.updateQuestion(question.id, {
            conceptIds: [...question.conceptIds, id],
            suggestions: question.suggestions.filter((s) => s !== name)
          })
        }}
      />
      <Composer
        submitOnEnter={false}
        autoFocus={false}
        projectId={projectId}
        profileId={data.activeProfileId}
        settings={data.settings}
        questionId={question.id}
        recentQuestion={running}
        mediaActions={mediaActions()}
        persistDraft={false}
        onCompleted={() => void refresh()}
      />
    </section>
  )
}

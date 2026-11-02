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
  questionStatus
} from '@desktop/shared/questions'
import MindMap from '@desktop/renderer/src/components/MindMap/MindMap'
import { useApi } from '@desktop/renderer/src/personal/api'
import { dateLabel, errorText, statuses } from '@desktop/renderer/src/personal/common'
import Composer from '@desktop/renderer/src/personal/Composer'
import MarkdownAnswer from '@desktop/renderer/src/personal/MarkdownAnswer'
import QuestionDetail from '@desktop/renderer/src/personal/QuestionDetail'
import { questionTree } from '@desktop/renderer/src/personal/questionTree'
import { useMobile } from '../context'
import { mediaActions } from '../media'
import { isAndroidOverlay, isOverlayCancellation, overlayControl, type OverlayStatus } from '../overlay/control'
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
  const { data } = useMobile()
  const navigate = useNavigate()
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
  if (!project) return <Navigate404 />
  const concepts = data.concepts.filter((c) => c.projectId === projectId)
  const open = (id: string): void => void navigate(`/p/${projectId}/q/${id}`)
  const list = (
    <section className="mobile-list">
      <div className="filter-row">
        <input
          aria-label="기록 검색"
          placeholder="⌕ 질문, 답변, 메모 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="mobile-chips" role="tablist">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? 'active' : ''}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="segmented">
        <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
          목록
        </button>
        <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
          개념 그래프
        </button>
      </div>
      {view === 'graph' ? (
        <MindMap
          root={graph}
          height="70vh"
          onSelect={(node) => {
            if (node.id.startsWith('q:')) open(node.id.split(':')[1])
          }}
        />
      ) : filtered.length ? (
        <div className="question-list">
          {filtered.map((q) => (
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
      ) : (
        <div className="empty-state">
          <h2>{query || filter !== 'all' ? '일치하는 기록이 없습니다' : '첫 질문을 남겨 보세요'}</h2>
        </div>
      )}
    </section>
  )
  const detail = questionId ? (
    <Detail key={questionId} projectId={projectId} questionId={questionId} />
  ) : (
    <div className="empty-state">
      <h2>질문을 선택하세요</h2>
    </div>
  )
  return (
    <>
      <header className="mobile-top">
        <button aria-label="뒤로" onClick={() => navigate(questionId && !wide ? `/p/${projectId}` : '/')}>
          ←
        </button>
        <h1>{project.name}</h1>
        {isAndroidOverlay() && <ScreenQuestionControl projectId={projectId} questionId={questionId} />}
        <button onClick={() => navigate('/connection')}>연결</button>
      </header>
      <main className={wide ? 'mobile-body project-split' : 'mobile-body'}>
        {wide ? (
          <>
            {list}
            {detail}
          </>
        ) : questionId ? (
          detail
        ) : (
          list
        )}
      </main>
      {(!questionId || wide) && (
        <div className="mobile-fab">
          <button className="primary" onClick={() => navigate(`/p/${projectId}/new`)}>
            ＋ 새 질문
          </button>
        </div>
      )}
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

function ScreenQuestionControl({
  projectId,
  questionId
}: {
  projectId: string
  questionId?: string
}): React.JSX.Element {
  const mobile = useMobile()
  const current = useRef({ mobile, projectId, questionId })
  current.current = { mobile, projectId, questionId }
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
      if (initial.mobile.conn.state !== 'online')
        throw new Error('PC에 연결된 상태에서 화면 질문을 시작해 주세요.')
      if (!initial.mobile.data.projects.some((item) => item.id === projectId) ||
          (questionId && !initial.mobile.data.questions.some(
            (item) => item.id === questionId && item.projectId === projectId
          ))) throw new Error('현재 화면에 프로젝트 또는 질문이 없습니다. 다시 열어 주세요.')
      if (!window.confirm(
        '다른 앱 위에 FASK 토글을 표시하고 이번 세션 동안 전체 디스플레이를 공유합니다. ' +
        '전역 펜 좌표를 맞추려면 전체 화면 공유가 필요합니다. ' +
        '전체 화면을 자동 전송하지 않으며, 질문 전송 시 선택한 영역만 첨부합니다. ' +
        '보호된 화면은 캡처되지 않거나 검게 보일 수 있습니다. 계속할까요?'
      )) return
      if (!state.overlayAllowed) {
        await overlayControl.requestOverlayPermission()
        if (mounted.current) {
          setStatus(await overlayControl.status())
          setMessage('다른 앱 위에 표시 권한을 허용한 뒤 화면 위에서 질문 버튼을 다시 눌러 주세요.')
        }
        return
      }
      const pairing = await loadPairing()
      const expected = initial.mobile.pairing
      if (!pairing || pairing.fingerprint !== expected.fingerprint ||
          pairing.token !== expected.token || pairing.port !== expected.port ||
          JSON.stringify(pairing.addresses) !== JSON.stringify(expected.addresses) ||
          JSON.stringify(pairing.relay ?? null) !== JSON.stringify(expected.relay ?? null))
        throw new Error('페어링이 변경되었습니다. 연결 상태를 확인해 주세요.')
      // A cached snapshot must not authorize a new screen-sharing session.
      const response = await nativeTransport.request(
        pairing, initial.mobile.client.address(), 'POST', '/rpc/snapshot', '{"args":[]}', 15_000
      )
      if (response.status < 200 || response.status >= 300)
        throw new Error('PC의 최신 프로젝트 정보를 확인할 수 없습니다.')
      const envelope: unknown = JSON.parse(response.body)
      if (!envelope || typeof envelope !== 'object' || !('result' in envelope))
        throw new Error('PC의 프로젝트 응답을 읽을 수 없습니다.')
      const latest = envelope.result
      if (!latest || typeof latest !== 'object' ||
          !('activeProfileId' in latest) || typeof latest.activeProfileId !== 'string' ||
          !('profiles' in latest) || !Array.isArray(latest.profiles) ||
          !('projects' in latest) || !Array.isArray(latest.projects) ||
          !('workspaces' in latest) || !Array.isArray(latest.workspaces) ||
          !('questions' in latest) || !Array.isArray(latest.questions))
        throw new Error('PC의 프로젝트 응답을 읽을 수 없습니다.')
      const now = current.current
      if (!mounted.current) return
      if (now.mobile.client !== initial.mobile.client || now.projectId !== initial.projectId ||
          now.questionId !== initial.questionId || now.mobile.conn.state !== 'online' ||
          now.mobile.data.activeProfileId !== initial.mobile.data.activeProfileId)
        throw new Error('현재 화면이나 연결이 변경되었습니다. 다시 시작해 주세요.')
      const profileId = latest.activeProfileId
      const project = latest.projects.find((item) => item.id === projectId)
      if (profileId !== initial.mobile.data.activeProfileId ||
          !latest.profiles.some((item) => item.id === profileId) ||
          !project || !latest.workspaces.some(
            (item) => item.id === project.workspaceId && item.profileId === profileId
          ))
        throw new Error('현재 프로필에 프로젝트가 없습니다. 프로젝트를 다시 열어 주세요.')
      if (questionId && !latest.questions.some(
        (item) => item.id === questionId && item.projectId === projectId
      )) throw new Error('현재 프로젝트에 질문이 없습니다. 질문을 다시 열어 주세요.')
      await overlayControl.start({ pairing, profileId, projectId, ...(questionId ? { questionId } : {}) })
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
    <div>
      <button disabled={busy || !status} onClick={() => void act()}>
        {busy ? '처리 중…' : status?.running ? '화면 질문 실행 중 / 종료' : '화면 위에서 질문'}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  )
}

function Navigate404(): React.JSX.Element {
  return (
    <main className="mobile-body">
      <div className="empty-state">
        <h2>프로젝트를 찾을 수 없습니다.</h2>
        <Link to="/">처음으로</Link>
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
  return (
    <div className="mobile-sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="mobile-sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
        <strong>{questionHeading(q)}</strong>
        {mode === 'actions' && (
          <>
            <button onClick={() => setMode('rename')}>이름 바꾸기</button>
            <button onClick={() => setMode('move')}>다른 프로젝트로 이동</button>
            <button className="danger" onClick={() => setMode('delete')}>
              삭제
            </button>
          </>
        )}
        {mode === 'rename' && (
          <>
            <input aria-label="질문 이름" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <button
              className="primary"
              disabled={busy || !name.trim()}
              onClick={() => void run(() => api.rename('question', q.id, name.trim()))}
            >
              저장
            </button>
          </>
        )}
        {mode === 'delete' && (
          <>
            <p>이 질문을 삭제할까요?</p>
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
              삭제
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
          취소
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
        <span>{complexity === 'complex' ? '깊이 탐구' : complexity === 'simple' ? '빠른 질문' : '미확정'}</span>
        <time>{dateLabel(q.createdAt)}</time>
        {q.turns.length > 1 && <span>대화 {q.turns.length}개</span>}
        {q.important && <span>★</span>}
      </div>
      <h3>{questionHeading(q)}</h3>
      <MarkdownAnswer preview>
        {lastTurn(q).answer || lastTurn(q).error || '아직 답변이 없습니다.'}
      </MarkdownAnswer>
      <div className="question-footer">
        <span>
          {q.conceptIds
            .map((id) => concepts.find((c) => c.id === id)?.name)
            .filter(Boolean)
            .join(' · ') || '미분류'}
        </span>
        <small>
          {statuses[questionStatus(q)]} {questionImages(q).length ? '· ▧' : ''}
        </small>
      </div>
    </button>
  )
}

function Detail({ projectId, questionId }: { projectId: string; questionId: string }): React.JSX.Element {
  const { data, refresh } = useMobile()
  const api = useApi()
  const navigate = useNavigate()
  const [notice, setNotice] = useState('')
  const question = data.questions.find((q) => q.id === questionId)
  // A turn already running on arrival (e.g. sent from the new-question screen) keeps streaming here.
  const [running] = useState(() =>
    question && lastTurn(question).status === 'running' ? question : undefined
  )
  if (!question)
    return (
      <div className="empty-state">
        <h2>삭제되었거나 찾을 수 없는 질문입니다.</h2>
        <Link to={`/p/${projectId}`}>목록으로</Link>
      </div>
    )
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setNotice('')
      await fn()
      await refresh()
    } catch (e) {
      setNotice(errorText(e))
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
        projectId={projectId}
        profileId={data.activeProfileId}
        settings={data.settings}
        questionId={question.id}
        recentQuestion={running}
        mediaActions={mediaActions}
        persistDraft={false}
        onCompleted={() => void refresh()}
      />
    </section>
  )
}

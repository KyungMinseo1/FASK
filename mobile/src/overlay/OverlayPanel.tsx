import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot } from '@desktop/preload/personal'
import { answerJustCompleted, questionHeading } from '@desktop/shared/questions'
import { useApi } from '@desktop/renderer/src/personal/api'
import { errorText } from '@desktop/renderer/src/personal/common'
import Composer from '@desktop/renderer/src/personal/Composer'
import ProjectPicker from '@desktop/renderer/src/personal/ProjectPicker'
import QuestionDetail from '@desktop/renderer/src/personal/QuestionDetail'
import TurnNav from '@desktop/renderer/src/personal/TurnNav'
import { t } from '@desktop/shared/i18n'
import { useT } from '@desktop/shared/i18n/react'
import type { HubClient, HubConn } from '../hub'
import { applyOverlayTheme, type Bootstrap, type Bridge, type OverlayState } from './bridge'

type Interaction = { busy: boolean; running: boolean; unresolved: boolean }
const IDLE: Interaction = { busy: false, running: false, unresolved: false }

/** Why this panel must stop accepting questions for the session's context, or ''. */
export function contextProblem(
  data: Snapshot,
  ctx: { profileId: string; projectId: string },
  questionId: string | undefined
): string {
  if (data.activeProfileId !== ctx.profileId)
    return t('PC에서 프로필이 바뀌었습니다. 앱에서 화면 질문을 다시 시작해 주세요.')
  if (!data.projects.some((p) => p.id === ctx.projectId))
    return t('프로젝트가 삭제되었습니다. 앱에서 화면 질문을 다시 시작해 주세요.')
  if (questionId) {
    const q = data.questions.find((x) => x.id === questionId)
    if (q && q.projectId !== ctx.projectId) return t('다른 프로젝트의 질문입니다.')
  }
  return ''
}

export default function OverlayPanel({
  bridge,
  boot,
  initial,
  conn,
  unpaired
}: {
  bridge: Bridge
  boot: Bootstrap
  /** Snapshot read once before mounting; the Composer is mounted exactly once from it. */
  initial: Snapshot
  conn: HubConn
  unpaired: string
}): React.JSX.Element {
  const api = useApi() as HubClient
  useT()
  const [data, setData] = useState(initial)
  const [overlay, setOverlay] = useState<OverlayState>(boot)
  const [projectId, setProjectId] = useState(boot.projectId)
  const [picker, setPicker] = useState(false)
  const [questionId, setQuestionId] = useState(boot.questionId)
  const [composerKey, setComposerKey] = useState(0)
  // Earlier turns start folded per conversation; hiding and showing the panel keeps this state.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState('')
  const [interaction, setInteraction] = useState<Interaction>(IDLE)
  const interactionRef = useRef(interaction)
  // Ink revision frozen by the latest capture, tied to the turn that capture produced.
  const capturedInk = useRef<number | null>(null)
  const turnInk = useRef(new Map<string, number>())
  const clearQueue = useRef<number[]>([])
  const seq = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const my = ++seq.current
    try {
      const next = await api.snapshot()
      if (my === seq.current) setData(next)
    } catch (e) {
      if (my === seq.current) setNotice(errorText(e))
    }
  }, [api])

  useEffect(() => {
    const offChanged = api.onChanged(() => void refresh())
    const offPush = bridge.onPush((push) => {
      if (push.event === 'overlayState') {
        setOverlay(push.payload)
        applyOverlayTheme(push.payload)
      }
      else if (push.event === 'panelShown') {
        // The Composer stays mounted; reconnecting replays missed stream/state through onChanged.
        api.reconnect()
        void refresh()
      } else if (push.event === 'sessionInvalidated') setBlocked(t('화면 질문이 종료되었습니다.'))
      else if (push.event === 'projectPicker') setPicker(true)
      else if (push.event === 'selectProject') void switchRef.current(push.payload.projectId)
    })
    return () => {
      offChanged()
      offPush()
    }
  }, [api, bridge, refresh])

  // Profile switch or project deletion on the PC: never let a question land in the wrong place.
  useEffect(() => {
    const problem = contextProblem(data, { profileId: boot.profileId, projectId }, questionId)
    if (!problem) return
    setBlocked(problem)
    void bridge.call('stop').catch(() => {})
  }, [data, boot.profileId, projectId, questionId, bridge])

  // The Composer's autofocused input otherwise keeps the panel scrolled past the opened list.
  const head = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!picker) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const show = (): void => head.current?.scrollIntoView({ block: 'start' })
    show()
    // Opened from the toolbar, the hidden panel (0px tall) gets its real viewport only afterwards.
    window.addEventListener('resize', show, { once: true })
    return () => window.removeEventListener('resize', show)
  }, [picker])

  const flushClears = (): void => {
    const queue = clearQueue.current
    clearQueue.current = []
    for (const expectedRevision of queue)
      void bridge.call('clearInk', { expectedRevision }).catch((e) => setNotice(errorText(e)))
  }
  const onInteractionState = (state: Interaction): void => {
    interactionRef.current = state
    setInteraction(state)
    const idle = !state.busy && !state.running && !state.unresolved
    void bridge
      .call('setInteractionState', state)
      .then(() => {
        // Native ink is locked while a request owns it; clear only once released.
        if (idle) flushClears()
      })
      .catch((e) => setNotice(errorText(e)))
    if (idle) capturedInk.current = null
  }
  const onCapture = async (): Promise<string> => {
    const { dataUrl, inkRevision } = await bridge.call<{ dataUrl: string; inkRevision: number }>(
      'captureSelectedRegion'
    )
    capturedInk.current = inkRevision
    return dataUrl
  }
  const onTurnIdentified = ({ questionId: qid, turnId }: { questionId: string; turnId: string }): void => {
    if (capturedInk.current !== null) turnInk.current.set(turnId, capturedInk.current)
    capturedInk.current = null
    if (qid === questionId) return
    setQuestionId(qid)
    void bridge.call('setQuestion', { questionId: qid }).catch((e) => setNotice(errorText(e)))
  }
  const onCompleted = (_id: string, result: { turnId: string; status: 'saved' | 'completed' }): void => {
    const revision = turnInk.current.get(result.turnId)
    turnInk.current.delete(result.turnId)
    // Only an answered turn clears the ink it was sent with; newer strokes stay.
    if (result.status === 'completed' && revision !== undefined) {
      clearQueue.current.push(revision)
      const s = interactionRef.current
      if (!s.busy && !s.running && !s.unresolved) flushClears()
    }
    void refresh()
  }
  const locked = interaction.busy || interaction.running || interaction.unresolved
  // WebView has no confirm() dialog here; a second tap within 3s confirms instead.
  const [confirmNew, setConfirmNew] = useState(false)
  useEffect(() => {
    if (!confirmNew) return
    const timer = setTimeout(() => setConfirmNew(false), 3000)
    return () => clearTimeout(timer)
  }, [confirmNew])
  const newConversation = (): void => {
    if (locked) return
    if (!confirmNew) {
      setConfirmNew(true)
      return
    }
    setConfirmNew(false)
    setQuestionId(undefined)
    setHistoryOpen(false)
    void bridge.call('setQuestion', { questionId: null }).catch((e) => setNotice(errorText(e)))
    void bridge
      .call('clearInk', { expectedRevision: overlay.inkRevision })
      .catch((e) => setNotice(errorText(e)))
    setComposerKey((k) => k + 1)
  }
  const switchProject = async (id: string): Promise<void> => {
    setPicker(false)
    if (locked || id === projectId) return
    try {
      // Native clears the session's active question along with the project.
      await bridge.call('setProject', { projectId: id })
      setNotice('')
      setProjectId(id)
      setQuestionId(undefined)
      setHistoryOpen(false)
      setComposerKey((k) => k + 1)
    } catch (e) {
      setNotice(errorText(e))
      // Chosen from the native toolbar the panel may be hidden; surface the error there.
      void bridge.call('setPanelVisible', { visible: true }).catch(() => {})
    }
  }
  const switchRef = useRef(switchProject)
  switchRef.current = switchProject
  const lockReason = locked ? t('답변이 끝난 뒤 프로젝트를 바꿀 수 있습니다.') : null
  const projectsKey = JSON.stringify([data.projects, data.workspaces, projectId, lockReason, notice])
  // The native toolbar's project popover mirrors this list; resent after every switch attempt.
  useEffect(() => {
    const groups = new Map(data.workspaces.map((w) => [w.id, w.remote ? `🌐 ${w.name}` : w.name]))
    const projects = [...data.projects]
      .sort((a, b) => (groups.get(a.workspaceId) ?? '').localeCompare(groups.get(b.workspaceId) ?? ''))
      .map((p) => ({ id: p.id, name: p.name, group: groups.get(p.workspaceId) ?? null }))
    void bridge.call('setProjects', { projects, lockReason }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, projectsKey])

  const question = questionId ? data.questions.find((q) => q.id === questionId) : undefined
  const prevQuestion = useRef(question)
  // Native blinks the toggle only when the panel is folded, so no visibility check here.
  useEffect(() => {
    if (answerJustCompleted(prevQuestion.current, question))
      void bridge.call('notifyAnswered').catch(() => {})
    prevQuestion.current = question
  }, [bridge, question])
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
  // The native window draws the desktop panel's header (project, 접기 ×) and a side resize grip
  // on the edge facing away from the screen edge.
  return (
    <div className="overlay-panel screen-q-panel">
      {picker && (
        <div className="screen-q-picker" ref={head}>
          <ProjectPicker
            workspaces={data.workspaces}
            projects={data.projects}
            currentId={projectId}
            disabledReason={lockReason ?? undefined}
            onSelect={(id) => void switchProject(id)}
          />
        </div>
      )}
      <div className="overlay-panel-content">
        <div className="screen-q-followup" role="status">
          {questionId ? (
            <>
              <span className="screen-q-followup-tag">↪ {t('이어서 질문 중')}</span>
              <b title={question ? questionHeading(question) : undefined}>
                {question ? questionHeading(question) : ''}
              </b>
              <button disabled={locked} onClick={newConversation}>
                {confirmNew ? t('다시 눌러 새 대화 시작') : t('＋ 새 질문')}
              </button>
            </>
          ) : (
            <b>{t('새 대화')}</b>
          )}
        </div>
        {unpaired && <p className="notice error">{unpaired}</p>}
        {conn.state === 'offline' && (
          <p className="notice">{t('PC에 연결할 수 없습니다. 연결되면 이어서 표시합니다.')}</p>
        )}
        {conn.state === 'blocked' && (
          <p className="notice error">{t('인증서가 일치하지 않는 연결을 차단했습니다.')}</p>
        )}
        {blocked && <p className="notice error">{blocked}</p>}
        <small className="overlay-capture-note">
          {overlay.region
            ? t('캡처 영역 {{width}}×{{height}}px', overlay.region)
            : t('영역 미설정 · 화면 첨부 전에 영역을 선택하세요')}
          {overlay.hasInk ? t(' · 필기 있음') : ''}
          {t(' · 캡처 포함을 선택하면 질문 전송 시 촬영합니다.')}
          <button
            disabled={locked}
            onClick={() => void bridge.call('selectRegion').catch((e) => setNotice(errorText(e)))}
          >
            {t('영역 선택')}
          </button>
        </small>
        {question && question.turns.length > 1 && (
          <details
            className="overlay-history"
            open={historyOpen}
            onToggle={(e) => setHistoryOpen(e.currentTarget.open)}
          >
            <summary>
              {t('이전 대화 {{count}}개', { count: question.turns.length - 1 })}
              {question.memo.trim() !== '' && (
                <span className="memo-badge" title={t('메모 있음')}>
                  ✎ {t('메모')}
                </span>
              )}
            </summary>
            <QuestionDetail
              question={question}
              concepts={data.concepts.filter((c) => c.projectId === projectId)}
              run={run}
              earlierOnly
              onCreateConcept={async (name) => {
                const id = await api.create('concept', name, projectId)
                await api.updateQuestion(question.id, {
                  conceptIds: [...question.conceptIds, id],
                  suggestions: question.suggestions.filter((s) => s !== name)
                })
              }}
            />
          </details>
        )}
        {question && (
          <TurnNav
            turns={question.turns}
            important={question.important}
            onToggleImportant={() =>
              void run(() => api.updateQuestion(question.id, { important: !question.important }))
            }
            panel={{ historyOpen, onToggleHistory: () => setHistoryOpen((open) => !open) }}
          />
        )}
        {!blocked && (
          <Composer
            submitOnEnter={false}
            key={composerKey}
            projectId={projectId}
            profileId={boot.profileId}
            settings={data.settings}
            questionId={questionId}
            recentQuestion={question}
            persistDraft={false}
            hasInk={overlay.hasInk}
            onCapture={onCapture}
            onSaved={() => void refresh()}
            onCompleted={onCompleted}
            onTurnIdentified={onTurnIdentified}
            onInteractionState={onInteractionState}
          />
        )}
        {notice && <p className="notice error">{notice}</p>}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Question, Snapshot } from '@desktop/preload/personal'
import { lastTurn } from '@desktop/shared/questions'
import { useApi } from '@desktop/renderer/src/personal/api'
import { errorText } from '@desktop/renderer/src/personal/common'
import Composer from '@desktop/renderer/src/personal/Composer'
import QuestionDetail from '@desktop/renderer/src/personal/QuestionDetail'
import type { HubClient, HubConn } from '../hub'
import type { Bootstrap, Bridge, OverlayState } from './bridge'

type Interaction = { busy: boolean; running: boolean; unresolved: boolean }
const IDLE: Interaction = { busy: false, running: false, unresolved: false }

/** Why this panel must stop accepting questions for the session's context, or ''. */
export function contextProblem(
  data: Snapshot,
  ctx: { profileId: string; projectId: string },
  questionId: string | undefined
): string {
  if (data.activeProfileId !== ctx.profileId)
    return 'PC에서 프로필이 바뀌었습니다. 앱에서 화면 질문을 다시 시작해 주세요.'
  if (!data.projects.some((p) => p.id === ctx.projectId))
    return '프로젝트가 삭제되었습니다. 앱에서 화면 질문을 다시 시작해 주세요.'
  if (questionId) {
    const q = data.questions.find((x) => x.id === questionId)
    if (q && q.projectId !== ctx.projectId) return '다른 프로젝트의 질문입니다.'
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
  const [data, setData] = useState(initial)
  const [overlay, setOverlay] = useState<OverlayState>(boot)
  const [questionId, setQuestionId] = useState(boot.questionId)
  const [composerKey, setComposerKey] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState('')
  const [interaction, setInteraction] = useState<Interaction>(IDLE)
  // A running last turn on arrival keeps streaming in this Composer.
  const [recent] = useState<Question | undefined>(() => {
    const q = boot.questionId ? initial.questions.find((x) => x.id === boot.questionId) : undefined
    return q && lastTurn(q).status === 'running' ? q : undefined
  })
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
      if (push.event === 'overlayState') setOverlay(push.payload)
      else if (push.event === 'panelShown') {
        // The Composer stays mounted; reconnecting replays missed stream/state through onChanged.
        api.reconnect()
        void refresh()
      } else if (push.event === 'sessionInvalidated') setBlocked('화면 질문이 종료되었습니다.')
    })
    return () => {
      offChanged()
      offPush()
    }
  }, [api, bridge, refresh])

  // Profile switch or project deletion on the PC: never let a question land in the wrong place.
  useEffect(() => {
    const problem = contextProblem(data, boot, questionId)
    if (!problem) return
    setBlocked(problem)
    void bridge.call('stop').catch(() => {})
  }, [data, boot, questionId, bridge])

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
  const newConversation = (): void => {
    if (locked || !confirm('현재 작성 중인 내용을 버리고 새 대화를 시작할까요?')) return
    setQuestionId(undefined)
    setHistoryOpen(false)
    void bridge.call('setQuestion', { questionId: null }).catch((e) => setNotice(errorText(e)))
    void bridge
      .call('clearInk', { expectedRevision: overlay.inkRevision })
      .catch((e) => setNotice(errorText(e)))
    setComposerKey((k) => k + 1)
  }
  const stop = (): void => {
    const warn = interaction.running || interaction.unresolved
    if (warn && !confirm('PC에서 답변이 계속 진행될 수 있습니다. 화면 질문을 종료할까요?')) return
    void bridge.call('stop').catch(() => {})
  }

  const question = questionId ? data.questions.find((q) => q.id === questionId) : undefined
  const project = data.projects.find((p) => p.id === boot.projectId)
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
    <div className="screen-q">
      <header className="screen-q-head">
        <b>{project?.name ?? 'FASK'}</b>
        <span>
          <button disabled={locked} onClick={newConversation}>
            새 대화
          </button>
          <button onClick={() => void bridge.call('setPanelVisible', { visible: false })}>접기</button>
          <button className="danger" onClick={stop}>
            종료
          </button>
        </span>
      </header>
      {unpaired && <p className="notice error">{unpaired}</p>}
      {conn.state === 'offline' && (
        <p className="notice">PC에 연결할 수 없습니다. 연결되면 이어서 표시합니다.</p>
      )}
      {conn.state === 'blocked' && (
        <p className="notice error">인증서가 일치하지 않는 연결을 차단했습니다.</p>
      )}
      {blocked && <p className="notice error">{blocked}</p>}
      {notice && <p className="notice error">{notice}</p>}
      <div className="screen-q-region">
        <span>
          {overlay.region
            ? `캡처 영역 ${overlay.region.width}×${overlay.region.height}px 선택됨`
            : '캡처 영역 없음 · 화면 첨부 시 먼저 영역을 선택하세요'}
          {overlay.hasInk ? ' · 필기 있음' : ''}
        </span>
        <button disabled={locked} onClick={() => void bridge.call('selectRegion').catch((e) => setNotice(errorText(e)))}>
          영역 선택
        </button>
      </div>
      <small className="screen-q-hint">
        전송하는 순간의 화면에서 선택 영역과 필기만 보냅니다. 보호된 화면은 검게 캡처될 수 있습니다.
      </small>
      {question && (
        <details open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
          <summary>대화 기록</summary>
          <QuestionDetail
            question={question}
            concepts={data.concepts.filter((c) => c.projectId === boot.projectId)}
            run={run}
            onClose={() => setHistoryOpen(false)}
            onCreateConcept={async (name) => {
              const id = await api.create('concept', name, boot.projectId)
              await api.updateQuestion(question.id, {
                conceptIds: [...question.conceptIds, id],
                suggestions: question.suggestions.filter((s) => s !== name)
              })
            }}
          />
        </details>
      )}
      {!blocked && (
        <Composer
          key={composerKey}
          projectId={boot.projectId}
          profileId={boot.profileId}
          settings={data.settings}
          questionId={questionId}
          recentQuestion={composerKey === 0 ? recent : undefined}
          persistDraft={false}
          hasInk={overlay.hasInk}
          onCapture={onCapture}
          onSaved={() => {
            setHistoryOpen(false)
            void refresh()
          }}
          onCompleted={onCompleted}
          onTurnIdentified={onTurnIdentified}
          onInteractionState={onInteractionState}
        />
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type {
  AskInput,
  LocalSettings,
  ModelSettings,
  ReasoningEffort,
  Reference,
  Question,
  TextAttachment,
  TurnState,
  Workspace
} from '../../../preload/personal'
import {
  applyDelta,
  lastTurn,
  reconcileTurnState,
  recommend,
  routedModel,
  type LiveAnswer
} from '../../../shared/questions'
import { attachmentAccept, readAttachment } from './attachments'
import { errorText } from './common'
import MarkdownAnswer from './MarkdownAnswer'
import CopyButton from './CopyButton'
import ReferenceChips from './ReferenceChips'
import { Icon, type IconName } from './ToolbarIcons'
import { useApi } from './api'
import { useT } from '../../../shared/i18n/react'

// personal.ts `ask` throws these before recordAsk stores anything; every other failure is
// treated as "result unknown" (the hub wraps handler errors as HTTP 400 either way).
const REJECTED = [
  '요청 ID가 잘못되었습니다.',
  '프로필이 변경되었습니다. 다시 열어 주세요.',
  '질문이나 첨부를 추가해 주세요.',
  '질문은 50,000자 이내로 입력해 주세요.',
  '텍스트 첨부는 최대 5개, 전체 100,000자까지 지원합니다.',
  '같은 요청 ID로 다른 내용을 보낼 수 없습니다.',
  '모델 이름이 잘못되었습니다.',
  '추론 강도가 잘못되었습니다.'
]
const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' }
]

interface Props {
  projectId: string
  profileId: string
  settings: LocalSettings
  /** Focus the question input on mount; off where the keyboard would cover content. */
  autoFocus?: boolean
  /** Question to continue; omitted for a new question. */
  questionId?: string
  recentQuestion?: Question
  onCapture?: () => Promise<string>
  /** New ink enables capture; clearing ink keeps the user's current capture choice. */
  hasInk?: boolean
  onSaved?: (id: string) => void
  onCompleted?: (id: string, result: { turnId: string; status: 'completed' }) => void
  /** Called once per turn when an ask reply or matching stream identifies it. */
  onTurnIdentified?: (state: { questionId: string; turnId: string }) => void
  /** busy: capture/ask/refine in flight; unresolved: sent but acceptance unknown. */
  onInteractionState?: (state: { busy: boolean; running: boolean; unresolved: boolean }) => void
  /** Prefilled question; wins over the stored draft. */
  initialRaw?: string
  /** Files attached once on mount (e.g. shared from another app). */
  initialFiles?: File[]
  /** Extra pickers such as camera or gallery; when given, attaching opens a menu of them plus files. */
  mediaActions?: { label: string; icon: IconName; pick: () => Promise<File[]> }[]
  /** When false the draft is never read from or written to localStorage. */
  persistDraft?: boolean
  /** Enter sends and Shift+Enter breaks the line; when false, Ctrl/Cmd+Enter sends (soft keyboards). */
  submitOnEnter?: boolean
  /** Opens a "참고한 지식" chip of the shown answer; chips are hidden when omitted. */
  onReference?: (ref: Reference) => void
  /**
   * Linked-PC project: that PC answers, so models come from its shared settings. A PC on an older
   * build shares none; it then picks the model itself and no picker is shown.
   */
  host?: Workspace['remote']
}
export default function Composer({
  projectId,
  profileId,
  settings,
  autoFocus = true,
  questionId,
  recentQuestion,
  onCapture,
  hasInk = false,
  onSaved,
  onCompleted,
  onTurnIdentified,
  onInteractionState,
  initialRaw,
  initialFiles,
  mediaActions,
  submitOnEnter = true,
  persistDraft = true,
  onReference,
  host
}: Props): React.JSX.Element {
  const t = useT()
  const api = useApi()
  const draftKey = `fask:draft:${profileId}:${projectId}`
  const recentTurn = recentQuestion ? lastTurn(recentQuestion) : undefined
  // The settings that pick the answer model: the answering PC's own; undefined when it shares none.
  const modelSettings: ModelSettings | undefined = host ? host.models : settings
  const lastModelKey = host ? `fask:last-model:${profileId}:peer:${host.peerId}` : `fask:last-model:${profileId}`
  const effortKey = `fask:reasoning-effort:${profileId}`
  const [raw, setRaw] = useState(
      () => initialRaw ?? (persistDraft ? localStorage.getItem(draftKey) : null) ?? ''
    ),
    [refined, setRefined] = useState(''),
    // Continuing keeps the conversation's own model; a new question reuses the last pick. A model
    // missing from the configured list (removed since) is skipped rather than sent.
    [chosenModel, setModel] = useState(
      () =>
        [recentTurn?.model, localStorage.getItem(lastModelKey)].find(
          (m): m is string =>
            !!m &&
            !!modelSettings &&
            (!modelSettings.models.length || modelSettings.models.includes(m) || m === modelSettings.model)
        ) ?? ''
    ),
    // Remembered across questions and PCs; '' sends no reasoning_effort.
    [effort, setEffort] = useState<ReasoningEffort | ''>(() => {
      const saved = localStorage.getItem(effortKey)
      return EFFORTS.find((e) => e.value === saved)?.value ?? ''
    })
  const model = chosenModel || modelSettings?.model || ''
  const [image, setImage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [actualModel, setActualModel] = useState(''),
    // Model the running answer was requested with; empty when a linked PC picks it.
    [sentModel, setSentModel] = useState('')
  const [live, setLiveState] = useState<LiveAnswer>(
    recentTurn
      ? { turnId: recentTurn.id, answer: recentTurn.answer, revision: recentTurn.revision }
      : { turnId: '', answer: '', revision: 0 }
  )
  // The stream subscription is registered once, so it reads the latest answer through a ref.
  const liveRef = useRef(live)
  const setLive = (next: LiveAnswer): void => {
    liveRef.current = next
    setLiveState(next)
  }
  const [running, setRunning] = useState(recentTurn?.status === 'running')
  const captureKey = `fask:capture:${profileId}`
  const [includeCapture, setIncludeCapture] = useState(
    () => hasInk || localStorage.getItem(captureKey) === 'true'
  )
  const [capturing, setCapturing] = useState(false)
  const [documents, setDocuments] = useState<TextAttachment[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const canRefine = !!raw.trim() || !!image || documents.length > 0
  const hasInput = canRefine || (!!onCapture && includeCapture)
  // Per-question knowledge injection; the settings scope supplies the default.
  const [useMemory, setUseMemory] = useState(settings.memoryScope !== 'off')
  const attach = async (files: File[]): Promise<void> => {
    if (locked) return
    setBusy(true)
    setError('')
    try {
      const parsed = await Promise.all(files.map(readAttachment))
      if (parsed.filter((f) => f.image).length > 1)
        throw new Error(t('이미지는 한 번에 한 장씩 첨부해 주세요.'))
      const textFiles = [...documents, ...parsed.flatMap((f) => (f.document ? [f.document] : []))]
      if (textFiles.length > 5 || textFiles.reduce((sum, d) => sum + d.text.length, 0) > 100000)
        throw new Error(t('텍스트 첨부는 최대 5개, 전체 100,000자까지 지원합니다.'))
      setDocuments(textFiles)
      const picture = parsed.find((f) => f.image)?.image
      if (picture) {
        setImage(picture)
        setIncludeCapture(false)
      }
      setRefined('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const [attachOpen, setAttachOpen] = useState(false)
  const attachMenu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!attachOpen) return
    const close = (e: PointerEvent): void => {
      if (!attachMenu.current?.contains(e.target as Node)) setAttachOpen(false)
    }
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAttachOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', escape)
    }
  }, [attachOpen])
  const pickMedia = (pick: () => Promise<File[]>): void => {
    setAttachOpen(false)
    void pick()
      .then((files) => (files.length ? attach(files) : undefined))
      .catch((e) => setError(errorText(e)))
  }
  const request = useRef('')
  const question = useRef(recentQuestion?.id ?? '')
  const turn = useRef(recentTurn?.status === 'running' ? recentTurn.id : '')
  // Turn whose completion was already handled; each turn finishes exactly once.
  const finished = useRef('')
  const syncing = useRef(false),
    syncAgain = useRef(false)
  // New ink enables capture unless an attached image wins; clearing ink must not change the choice.
  const [inkSeen, setInkSeen] = useState(hasInk)
  if (inkSeen !== hasInk) {
    setInkSeen(hasInk)
    if (hasInk && !image) setIncludeCapture(true)
  }
  // A sent ask stays frozen (same requestId, same image bytes, same fields) until the hub's
  // acceptance is known, so a lost reply is replayed instead of creating a second turn.
  const pending = useRef<AskInput | null>(null)
  const [unresolved, setUnresolvedState] = useState(false)
  const setUnresolved = (value: boolean): void => {
    if (!value) pending.current = null
    setUnresolvedState(value)
  }
  // Late HTTP results of an older send/replay never overwrite newer state.
  const operation = useRef(0)
  // Each turn is announced once; callbacks are read fresh because subscriptions mount once.
  const identified = useRef('')
  const callbacks = useRef({ onSaved, onCompleted, onTurnIdentified, onInteractionState })
  callbacks.current = { onSaved, onCompleted, onTurnIdentified, onInteractionState }
  const notify = (fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      // A consumer error must not turn an accepted ask into a failed one.
      console.error(e)
    }
  }
  const identify = (questionId: string, turnId: string): void => {
    if (!turnId || identified.current === turnId) return
    identified.current = turnId
    notify(() => callbacks.current.onTurnIdentified?.({ questionId, turnId }))
  }
  const locked = busy || running || unresolved
  useEffect(() => {
    notify(() => callbacks.current.onInteractionState?.({ busy, running, unresolved }))
  }, [busy, running, unresolved])
  useEffect(() => {
    if (persistDraft) localStorage.setItem(draftKey, raw)
  }, [draftKey, raw, persistDraft])
  const initialAttached = useRef(false)
  useEffect(() => {
    if (initialAttached.current || !initialFiles?.length) return
    initialAttached.current = true
    void Promise.resolve().then(() => attach(initialFiles))
    // Mount-only: shared files are attached once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /** The only path that applies answer text together with the run status. */
  const applyState = (turnId: string, state: TurnState): void => {
    const r = reconcileTurnState(liveRef.current, state, turnId, turn.current)
    setLive(r.live)
    if (!r.finished || finished.current === turnId) return
    finished.current = turnId
    setRunning(false)
    setActualModel(r.finished.actualModel)
    if (r.finished.status === 'completed') {
      setError('')
      setRaw('')
      setRefined('')
      setImage('')
      setDocuments([])
      const qid = question.current
      notify(() => callbacks.current.onCompleted?.(qid, { turnId, status: 'completed' }))
    } else if (r.finished.status !== 'saved')
      setError(r.finished.error || t('요청이 실패했습니다.'))
  }
  const resync = async (): Promise<void> => {
    if (syncing.current) {
      syncAgain.current = true
      return
    }
    syncing.current = true
    try {
      do {
        syncAgain.current = false
        const id = turn.current
        if (!id) break
        try {
          const state = await api.turnState(question.current, id)
          // A readable turn proves the hub accepted the request that the stream tied to it.
          if (pending.current && pending.current.requestId === request.current) {
            setUnresolved(false)
            setError('')
            if (finished.current !== id) setRunning(true)
          }
          applyState(id, state)
        } catch (e) {
          // Keep `running`; the next change notification or reconnect retries.
          setError(errorText(e))
        }
      } while (syncAgain.current)
    } finally {
      syncing.current = false
    }
  }
  useEffect(() => {
    const offStream = api.onStream((event) => {
      if (event.requestId !== request.current && !(turn.current && event.turnId === turn.current))
        return
      // Events can arrive before the ask response; adopt the turn from the request ID.
      if (!turn.current) {
        turn.current = event.turnId
        question.current = event.questionId
        identify(event.questionId, event.turnId)
        // A sent request whose reply was lost: the turn state confirms acceptance.
        if (pending.current) void resync()
      }
      if (event.delta) {
        const r = applyDelta(liveRef.current, {
          turnId: event.turnId,
          revision: event.revision,
          delta: event.delta
        })
        setLive(r.live)
        if (r.resync) void resync()
      }
      // The server stores the final state before `done`; completion is handled by applyState.
      if (event.done) void resync()
    })
    const offChanged = api.onChanged(() => {
      if (turn.current && finished.current !== turn.current) void resync()
    })
    // A reopened panel restores the answer written since the last checkpoint and its status.
    if (turn.current) void resync()
    return () => {
      offStream()
      offChanged()
    }
    // Mount-only subscription; handlers read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const refine = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setRefined(
        await api.refine(
          raw + (documents.length ? `\n첨부파일: ${JSON.stringify(documents)}` : ''),
          image || undefined
        )
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const submit = async (input: AskInput): Promise<void> => {
    const op = ++operation.current
    pending.current = input
    request.current = input.requestId
    setBusy(true)
    setError('')
    if (!turn.current) setRunning(true)
    let result: { questionId: string; turnId: string }
    try {
      result = await api.ask(input)
    } catch (e) {
      if (op !== operation.current) return
      const message = errorText(e)
      if (REJECTED.some((m) => message.includes(m) || message.includes(t(m)))) {
        // Rejected before recordAsk: nothing was stored, so the draft simply stays editable.
        setUnresolved(false)
        if (!turn.current) setRunning(false)
        setError(message)
        return
      }
      // Lost replies and timeouts are not evidence of rejection.
      if (pending.current !== input) {
        // The stream's turn already proved acceptance; just keep following that turn.
        void resync()
        return
      }
      setUnresolved(true)
      if (turn.current) void resync()
      else setRunning(false)
      setError(t('전송 결과를 확인하지 못했습니다. {{message}}', { message }))
      return
    } finally {
      if (op === operation.current) setBusy(false)
    }
    if (op !== operation.current) return
    setUnresolved(false)
    const { questionId: qid, turnId } = result
    question.current = qid
    turn.current = turnId
    if (liveRef.current.turnId !== turnId) setLive({ turnId, answer: '', revision: 0 })
    identify(qid, turnId)
    notify(() => callbacks.current.onSaved?.(qid))
    // A replayed request emits nothing, so always re-read the turn.
    void resync()
  }
  const questionInput = useRef<HTMLTextAreaElement>(null)
  // Focus without scrolling so a reopened overlay panel keeps its scroll position.
  useEffect(() => {
    if (autoFocus) questionInput.current?.focus({ preventScroll: true })
  }, [])
  const send = async (): Promise<void> => {
    if (!hasInput || locked) return
    if (settings.refine && !refined && canRefine) {
      await refine()
      return
    }
    const routed = modelSettings?.routing === 'auto'
    if (modelSettings && !routed && model) localStorage.setItem(lastModelKey, model)
    setSentModel(!modelSettings ? '' : routed ? autoModel : model)
    // Frozen before capture: later edits or a new questionId never alter this request.
    const base: Omit<AskInput, 'requestId'> = {
      profileId,
      projectId,
      ...(questionId ? { questionId } : {}),
      raw,
      refined,
      model,
      documents: [...documents],
      useMemory,
      ...(effort ? { reasoningEffort: effort } : {})
    }
    setBusy(true)
    setError('')
    setActualModel('')
    setLive({ turnId: '', answer: '', revision: 0 })
    turn.current = ''
    setRunning(true)
    let outgoingImage = image || undefined
    let annotated = false
    if (includeCapture && onCapture) {
      setCapturing(true)
      try {
        outgoingImage = await onCapture()
        annotated = hasInk
      } catch (e) {
        // Nothing reached the hub: keep the draft and release the locks.
        setError(errorText(e))
        setRunning(false)
        setBusy(false)
        return
      } finally {
        setCapturing(false)
      }
    }
    await submit({
      ...base,
      requestId: crypto.randomUUID(),
      image: outgoingImage,
      ...(annotated ? { annotated: true } : {})
    })
  }
  /** Replays the exact frozen request to learn whether the hub accepted it. */
  const replay = (): void => {
    if (pending.current && !busy) void submit(pending.current)
  }
  const routing = recommend(raw, !!image || (!!onCapture && includeCapture))
  const autoModel = modelSettings ? routedModel(modelSettings, routing.complexity) : ''
  const routingChips =
    routing.complexity === 'complex' ? (
      <span>{t('여러 단계의 추론')}</span>
    ) : routing.complexity === 'unknown' ? (
      <span>{t('이미지 난이도 미확정')}</span>
    ) : (
      <>
        <span>{t('간단한 설명')}</span>
        <span>{t('로컬 규칙')}</span>
      </>
    )
  const autoModelName = autoModel ? <b>{autoModel}</b> : <span>{t('설정에서 모델을 선택하세요')}</span>
  return (
    <div
      className="composer"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        e.preventDefault()
        void attach([...e.dataTransfer.files])
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files]
        if (files.length) {
          e.preventDefault()
          void attach(files)
        }
      }}
    >
      <div className="composer-label">
        <b>{questionId ? t('이 질문에 이어서 질문') : t('새 질문')}</b>
        <span>{t('프로젝트에 자동 저장')}</span>
      </div>
      {recentTurn && (
        <div className="recent-question">
          <small>{t('최근 질문')}</small>
          <p>{recentTurn.sent}</p>
        </div>
      )}
      {(live.answer || running) && (
        <div className="live-answer">
          <div className="answer-head">
            <span className="live-answer-label">
              {running ? (
                <>
                  {t('답변 작성 중')}
                  {sentModel && <b>{sentModel}</b>}
                </>
              ) : (
                <>
                  {t('이번 답변')}
                  {actualModel && <b>{actualModel}</b>}
                </>
              )}
            </span>
            {!running && live.answer && (
              <CopyButton text={() => live.answer} label={t('답변 복사')} />
            )}
          </div>
          <MarkdownAnswer>
            {live.answer ||
              (capturing
                ? t('현재 화면을 캡처하고 있습니다…')
                : t('모델 응답을 기다리고 있습니다…'))}
          </MarkdownAnswer>
          {onReference && !running && (
            <ReferenceChips
              references={recentQuestion?.turns.find((x) => x.id === live.turnId)?.references}
              onReference={onReference}
            />
          )}
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={attachmentAccept}
        style={{ display: 'none' }}
        aria-label={t('파일 및 이미지 선택')}
        onChange={(e) => {
          void attach([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <textarea
        ref={questionInput}
        aria-label={t('질문')}
        placeholder={t('지금 궁금한 것을 적어보세요…')}
        value={raw}
        disabled={locked}
        onChange={(e) => {
          setRaw(e.target.value)
          setRefined('')
        }}
        onKeyDown={(e) => {
          // Confirming Korean IME input fires Enter too; never send on it.
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
          if (submitOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {image && (
        <div className="capture-thumb">
          <img src={image} alt={t('전송할 캡처')} />
          <button
            disabled={locked}
            onClick={() => {
              setImage('')
              setRefined('')
            }}
          >
            {t('이미지 제거')}
          </button>
        </div>
      )}
      {documents.length > 0 && (
        <div className="document-chips">
          {documents.map((d, index) => (
            <span key={`${d.name}:${index}`}>
              <Icon name="file" size={14} />
              {d.name}
              <button
                aria-label={t('{{name}} 제거', { name: d.name })}
                disabled={locked}
                onClick={() => {
                  setDocuments((ds) => ds.filter((_, i) => i !== index))
                  setRefined('')
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {refined && (
        <label className="refine-review">
          {t('다듬은 질문, 고친 뒤 전송')}
          <textarea
            value={refined}
            onChange={(e) => setRefined(e.target.value)}
            disabled={locked}
          />
          <button disabled={locked} onClick={() => setRefined('')}>
            {t('원문 사용으로 되돌리기')}
          </button>
        </label>
      )}
      {host && (
        <div className="recommendation">
          <span>
            {modelSettings
              ? t('{{name}} PC의 모델로 답변합니다', { name: host.name })
              : t('{{name}} PC의 모델 설정으로 답변합니다', { name: host.name })}
          </span>
        </div>
      )}
      {modelSettings?.routing === 'auto' ? (
        <div className="recommendation">
          <span>{t('자동 선택')}</span>
          {autoModelName}
          {routingChips}
          <span>{t('이 모델로 답변합니다')}</span>
        </div>
      ) : modelSettings?.routing === 'recommend' ? (
        <div className="recommendation">
          <span>{t('추천 모델')}</span>
          {autoModelName}
          {routingChips}
          {autoModel === model ? (
            <span className="chip">{t('적용됨')}</span>
          ) : (
            autoModel && (
              <button disabled={locked} onClick={() => setModel(autoModel)}>
                {t('사용')}
              </button>
            )
          )}
        </div>
      ) : null}
      <div className="composer-actions">
        {mediaActions?.length ? (
          <div className="attach-menu-anchor" ref={attachMenu}>
            <button
              disabled={locked}
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              onClick={() => setAttachOpen((open) => !open)}
            >
              <Icon name="clip" />
              {t('파일·사진 첨부')}
            </button>
            {attachOpen && (
              <div className="attach-menu" role="menu" aria-label={t('파일·사진 첨부')}>
                {mediaActions.map((action) => (
                  <button key={action.label} role="menuitem" onClick={() => pickMedia(action.pick)}>
                    <Icon name={action.icon} size={18} />
                    {action.label}
                  </button>
                ))}
                <button
                  role="menuitem"
                  onClick={() => {
                    setAttachOpen(false)
                    fileInput.current?.click()
                  }}
                >
                  <Icon name="file" size={18} />
                  {t('파일 선택')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <button disabled={locked} onClick={() => fileInput.current?.click()}>
            <Icon name="clip" />
            {t('파일 첨부')}
          </button>
        )}
        {onCapture && (
          <label className={`capture-toggle ${includeCapture ? 'checked' : ''}`}>
            <input
              type="checkbox"
              aria-label={t('화면 캡처 포함')}
              checked={includeCapture}
              disabled={locked}
              onChange={(e) => {
                setIncludeCapture(e.target.checked)
                localStorage.setItem(captureKey, String(e.target.checked))
                if (e.target.checked) setImage('')
              }}
            />
            {t('화면 캡처 포함')}
          </label>
        )}
        {settings.memoryScope !== 'off' && (
          <label
            className={`capture-toggle ${useMemory ? 'checked' : ''}`}
            title={t('저장된 지식을 찾아 이번 질문에 참고합니다')}
          >
            <input
              type="checkbox"
              aria-label={t('지식 참고')}
              checked={useMemory}
              disabled={locked}
              onChange={(e) => setUseMemory(e.target.checked)}
            />
            {t('지식 참고')}
          </label>
        )}
        <button disabled={locked || !canRefine} onClick={() => void refine()}>
          <Icon name="refine" />
          {t('질문 다듬기')}
        </button>
        {modelSettings && (
          <label className="model-select answer-model">
            <span>{t('답변 모델')}</span>
            {modelSettings.routing === 'auto' ? (
              <select value={autoModel} disabled>
                <option value="">{t('모델 선택')}</option>
                {[
                  ...new Set([...modelSettings.models, modelSettings.model, model, autoModel].filter(Boolean))
                ].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            ) : (
              <select value={model} disabled={locked} onChange={(e) => setModel(e.target.value)}>
                <option value="">{t('모델 선택')}</option>
                {[...new Set([...modelSettings.models, modelSettings.model, model].filter(Boolean))].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            )}
          </label>
        )}
        <label className="model-select effort-select">
          <span>{t('추론 강도')}</span>
          <select
            value={effort}
            disabled={locked}
            onChange={(e) => {
              const next = EFFORTS.find((x) => x.value === e.target.value)?.value ?? ''
              setEffort(next)
              localStorage.setItem(effortKey, next)
            }}
          >
            <option value="">{t('모델 기본값')}</option>
            {EFFORTS.map((e) => (
              <option key={e.value} value={e.value}>
                {t(e.label)}
              </option>
            ))}
          </select>
        </label>
        {running ? (
          <button
            className="danger"
            disabled={capturing}
            onClick={() => void api.cancel(request.current || turn.current)}
          >
            {capturing ? t('화면 캡처 중…') : t('중지')}
          </button>
        ) : (
          <button className="primary" disabled={locked || !hasInput} onClick={() => void send()}>
            {busy
              ? t('처리 중…')
              : settings.refine && !refined && canRefine
                ? t('다듬고 검토')
                : t('질문하기')}
          </button>
        )}
      </div>
      {unresolved && (
        <div className="notice error" role="status">
          {t('전송 결과를 확인하지 못했습니다.')}{' '}
          <button disabled={busy} onClick={replay}>
            {t('같은 요청 다시 확인')}
          </button>
        </div>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <small className="composer-hint">
        {onCapture && includeCapture && (
          <span className="composer-hint-capture">
            {t('질문하기를 누르면 현재 화면의 설정 영역을 캡처해 전송합니다. 다듬기에서는 캡처하지 않습니다.')}
          </span>
        )}
        <span className="composer-hint-keys">
          <span>{t('이미지 붙여넣기, 파일 드래그 가능')}</span>
        </span>
        <span>{t('이미지 1장')}</span>
        <span>{t('텍스트, 코드 최대 5개')}</span>
        <span className="composer-hint-keys">
          {submitOnEnter ? (
            <>
              <span>
                <kbd>Enter</kbd>
                {t('전송')}
              </span>
              <span>
                <kbd>Shift</kbd>
                <kbd>Enter</kbd>
                {t('줄바꿈')}
              </span>
            </>
          ) : (
            <span>
              <kbd>Ctrl</kbd>
              <kbd>Enter</kbd>
              {t('전송')}
            </span>
          )}
        </span>
      </small>
    </div>
  )
}

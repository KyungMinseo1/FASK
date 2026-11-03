import { useEffect, useRef, useState } from 'react'
import type {
  AskInput,
  LocalSettings,
  Question,
  TextAttachment,
  TurnState
} from '../../../preload/personal'
import {
  applyDelta,
  lastTurn,
  reconcileTurnState,
  type LiveAnswer
} from '../../../shared/questions'
import { attachmentAccept, readAttachment } from './attachments'
import { errorText } from './common'
import MarkdownAnswer from './MarkdownAnswer'
import CopyButton from './CopyButton'
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
  '같은 요청 ID로 다른 내용을 보낼 수 없습니다.'
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
  /** Overlay has pen strokes: capture defaults on while ink exists, off otherwise. */
  hasInk?: boolean
  onSaved?: (id: string) => void
  onCompleted?: (id: string, result: { turnId: string; status: 'saved' | 'completed' }) => void
  /** Called once per turn when an ask reply or matching stream identifies it. */
  onTurnIdentified?: (state: { questionId: string; turnId: string }) => void
  /** busy: capture/ask/refine in flight; unresolved: sent but acceptance unknown. */
  onInteractionState?: (state: { busy: boolean; running: boolean; unresolved: boolean }) => void
  /** Prefilled question; wins over the stored draft. */
  initialRaw?: string
  /** Files attached once on mount (e.g. shared from another app). */
  initialFiles?: File[]
  /** Extra pickers such as camera or gallery, rendered after the file button. */
  mediaActions?: { label: string; pick: () => Promise<File[]> }[]
  /** When false the draft is never read from or written to localStorage. */
  persistDraft?: boolean
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
  persistDraft = true
}: Props): React.JSX.Element {
  const t = useT()
  const api = useApi()
  const draftKey = `fask:draft:${profileId}:${projectId}`
  const recentTurn = recentQuestion ? lastTurn(recentQuestion) : undefined
  const [raw, setRaw] = useState(
      () => initialRaw ?? (persistDraft ? localStorage.getItem(draftKey) : null) ?? ''
    ),
    [refined, setRefined] = useState(''),
    [chosenModel, setModel] = useState('')
  const model = chosenModel || settings.model
  const [image, setImage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [actualModel, setActualModel] = useState('')
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
  const request = useRef('')
  const question = useRef(recentQuestion?.id ?? '')
  const turn = useRef(recentTurn?.status === 'running' ? recentTurn.id : '')
  // Turn whose completion was already handled; each turn finishes exactly once.
  const finished = useRef('')
  const syncing = useRef(false),
    syncAgain = useRef(false)
  // Ink toggles the default; an explicitly attached image wins (capture and image are exclusive).
  const [inkSeen, setInkSeen] = useState(hasInk)
  if (inkSeen !== hasInk) {
    setInkSeen(hasInk)
    setIncludeCapture(hasInk && !image)
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
    if (!turn.current) setRunning(!input.saveOnly)
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
    if (input.saveOnly) {
      finished.current = turnId
      setRunning(false)
      setRaw('')
      setRefined('')
      setImage('')
      setDocuments([])
      notify(() => callbacks.current.onCompleted?.(qid, { turnId, status: 'saved' }))
    }
    // A replayed request emits nothing, so always re-read the turn.
    else void resync()
  }
  const questionInput = useRef<HTMLTextAreaElement>(null)
  // Focus without scrolling so a reopened overlay panel keeps its scroll position.
  useEffect(() => {
    if (autoFocus) questionInput.current?.focus({ preventScroll: true })
  }, [])
  const send = async (saveOnly = false): Promise<void> => {
    if (!hasInput || locked) return
    if (!saveOnly && settings.refine && !refined && canRefine) {
      await refine()
      return
    }
    // Frozen before capture: later edits or a new questionId never alter this request.
    const base: Omit<AskInput, 'requestId'> = {
      profileId,
      projectId,
      ...(questionId ? { questionId } : {}),
      raw,
      refined,
      model,
      documents: [...documents],
      saveOnly
    }
    setBusy(true)
    setError('')
    setActualModel('')
    setLive({ turnId: '', answer: '', revision: 0 })
    turn.current = ''
    setRunning(!saveOnly)
    let outgoingImage = image || undefined
    let annotated = false
    if (!saveOnly && includeCapture && onCapture) {
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
  const complex =
    /증명|설계|디버깅|분석|비교|최적화|구현|derive|debug|design/i.test(raw) || raw.length > 500
  const recommendation = (complex ? settings.deepModel : settings.fastModel) || settings.model
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
            <span className="eyebrow">
              {running
                ? t('답변 작성 중')
                : actualModel
                  ? t('이번 답변 · {{model}}', { model: actualModel })
                  : t('이번 답변')}
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
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
              ▤ {d.name}
              <button
                aria-label={t('{{name}} 제거', { name: d.name })}
                disabled={locked}
                onClick={() => {
                  setDocuments((ds) => ds.filter((_, i) => i !== index))
                  setRefined('')
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {refined && (
        <label className="refine-review">
          {t('다듬은 질문 · 수정 후 전송')}
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
      {settings.routing !== 'manual' && (
        <div className="recommendation">
          {settings.routing === 'auto' ? t('자동 선택') : t('추천')} ·{' '}
          {recommendation || t('설정에서 모델을 선택하세요')}{' '}
          <span>
            {image || includeCapture
              ? t('이미지 난이도 미확정')
              : complex
                ? t('여러 단계의 추론')
                : t('간단한 설명 · 로컬 규칙')}
          </span>
          {settings.routing === 'recommend' && recommendation && (
            <button disabled={locked} onClick={() => setModel(recommendation)}>
              {t('사용')}
            </button>
          )}
        </div>
      )}
      <div className="composer-actions">
        <button disabled={locked} onClick={() => fileInput.current?.click()}>
          {t('＋ 파일·이미지')}
        </button>
        {mediaActions?.map((action) => (
          <button
            key={action.label}
            disabled={locked}
            onClick={() =>
              void action
                .pick()
                .then((files) => (files.length ? attach(files) : undefined))
                .catch((e) => setError(errorText(e)))
            }
          >
            {action.label}
          </button>
        ))}
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
        <button disabled={locked || !canRefine} onClick={() => void refine()}>
          {t('질문 다듬기')}
        </button>
        <select
          aria-label={t('사용 모델')}
          value={model}
          disabled={locked || settings.routing === 'auto'}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="">{t('모델 선택')}</option>
          {[...new Set([...settings.models, settings.model, model].filter(Boolean))].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button disabled={locked || !canRefine} onClick={() => void send(true)}>
          {t('저장만')}
        </button>
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
                : t('질문하기 ↗')}
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
          <>
            {t(
              '질문하기를 누르면 현재 화면의 설정 영역을 캡처해 전송합니다. 저장만·다듬기에서는 캡처하지 않습니다.'
            )}
            <br />
          </>
        )}
        {t(
          '이미지 붙여넣기·파일 드래그 가능 · 이미지 1장, 텍스트/코드 최대 5개 · Ctrl + Enter로 전송'
        )}
      </small>
    </div>
  )
}

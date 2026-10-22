import { useEffect, useRef, useState } from 'react'
import type { LocalSettings, Question, TextAttachment } from '../../../preload/personal'
import { attachmentAccept, readAttachment } from './attachments'
import { errorText } from './common'
import MarkdownAnswer from './MarkdownAnswer'

interface Props {
  projectId: string
  profileId: string
  settings: LocalSettings
  conversationId?: string
  recentQuestion?: Question
  onCapture?: () => Promise<string>
  /** Overlay has pen strokes: capture defaults on while ink exists, off otherwise. */
  hasInk?: boolean
  onSaved?: (id: string) => void
  onCompleted?: (id: string) => void
}
export default function Composer({
  projectId,
  profileId,
  settings,
  conversationId,
  recentQuestion,
  onCapture,
  hasInk = false,
  onSaved,
  onCompleted
}: Props): React.JSX.Element {
  const draftKey = `fask:draft:${profileId}:${projectId}`
  const [raw, setRaw] = useState(() => localStorage.getItem(draftKey) || ''),
    [refined, setRefined] = useState(''),
    [chosenModel, setModel] = useState('')
  const model = chosenModel || settings.model
  const [image, setImage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [answer, setAnswer] = useState(recentQuestion?.answer || '')
  const [running, setRunning] = useState(recentQuestion?.status === 'running')
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
    if (running || busy) return
    setBusy(true)
    setError('')
    try {
      const parsed = await Promise.all(files.map(readAttachment))
      if (parsed.filter((f) => f.image).length > 1)
        throw new Error('이미지는 한 번에 한 장씩 첨부해 주세요.')
      const textFiles = [...documents, ...parsed.flatMap((f) => (f.document ? [f.document] : []))]
      if (textFiles.length > 5 || textFiles.reduce((sum, d) => sum + d.text.length, 0) > 100000)
        throw new Error('텍스트 첨부는 최대 5개, 전체 100,000자까지 지원합니다.')
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
  const request = useRef(recentQuestion?.id || '')
  const question = useRef(recentQuestion?.id || '')
  // Ink toggles the default; an explicitly attached image wins (capture and image are exclusive).
  const [inkSeen, setInkSeen] = useState(hasInk)
  if (inkSeen !== hasInk) {
    setInkSeen(hasInk)
    setIncludeCapture(hasInk && !image)
  }
  useEffect(() => {
    localStorage.setItem(draftKey, raw)
  }, [draftKey, raw])
  useEffect(
    () =>
      window.fask.onStream((event) => {
        if (event.requestId !== request.current && event.questionId !== question.current) return
        if (event.delta) setAnswer((s) => s + event.delta)
        if (event.done) {
          setRunning(false)
          setError(event.error || '')
          // A panel reopened mid-stream may have missed tokens since the last DB checkpoint.
          void window.fask
            .snapshot()
            .then((s) => {
              if (request.current !== event.requestId && question.current !== event.questionId)
                return
              const saved = s.questions.find((q) => q.id === event.questionId)
              if (saved) setAnswer(saved.answer)
            })
            .catch(() => {})
          if (!event.error) {
            onCompleted?.(event.questionId)
            setRaw('')
            setRefined('')
            setImage('')
            setDocuments([])
          }
        }
      }),
    []
  )
  const refine = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setRefined(
        await window.fask.refine(
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
  const send = async (saveOnly = false): Promise<void> => {
    if (!hasInput || busy || running) return
    if (!saveOnly && settings.refine && !refined && canRefine) {
      await refine()
      return
    }
    setBusy(true)
    setError('')
    setAnswer('')
    const id = crypto.randomUUID()
    request.current = id
    question.current = ''
    setRunning(!saveOnly)
    try {
      let outgoingImage = image || undefined
      if (!saveOnly && includeCapture && onCapture) {
        setCapturing(true)
        outgoingImage = await onCapture()
        setCapturing(false)
      }
      const qid = await window.fask.ask({
        requestId: id,
        profileId,
        projectId,
        conversationId,
        raw,
        refined,
        model,
        image: outgoingImage,
        documents,
        saveOnly
      })
      question.current = qid
      onSaved?.(qid)
      if (saveOnly) {
        setRaw('')
        setRefined('')
        setImage('')
        setDocuments([])
        onCompleted?.(qid)
      }
    } catch (e) {
      setError(errorText(e))
      setRunning(false)
    } finally {
      setCapturing(false)
      setBusy(false)
    }
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
        <b>{conversationId ? '이 대화에 이어서 질문' : '새 질문'}</b>
        <span>프로젝트에 자동 저장</span>
      </div>
      {recentQuestion && (
        <div className="recent-question">
          <small>최근 질문</small>
          <p>{recentQuestion.sent}</p>
        </div>
      )}
      {(answer || running) && (
        <div className="live-answer">
          <span className="eyebrow">{running ? '답변 작성 중' : '이번 답변'}</span>
          <MarkdownAnswer>
            {answer ||
              (capturing ? '현재 화면을 캡처하고 있습니다…' : '모델 응답을 기다리고 있습니다…')}
          </MarkdownAnswer>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={attachmentAccept}
        style={{ display: 'none' }}
        aria-label="파일 및 이미지 선택"
        onChange={(e) => {
          void attach([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <textarea
        autoFocus
        aria-label="질문"
        placeholder="지금 궁금한 것을 적어보세요…"
        value={raw}
        disabled={running}
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
          <img src={image} alt="전송할 캡처" />
          <button
            disabled={running}
            onClick={() => {
              setImage('')
              setRefined('')
            }}
          >
            이미지 제거
          </button>
        </div>
      )}
      {documents.length > 0 && (
        <div className="document-chips">
          {documents.map((d, index) => (
            <span key={`${d.name}:${index}`}>
              ▤ {d.name}
              <button
                aria-label={`${d.name} 제거`}
                disabled={running}
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
          다듬은 질문 · 수정 후 전송
          <textarea
            value={refined}
            onChange={(e) => setRefined(e.target.value)}
            disabled={running}
          />
          <button onClick={() => setRefined('')}>원문 사용으로 되돌리기</button>
        </label>
      )}
      {settings.routing !== 'manual' && (
        <div className="recommendation">
          {settings.routing === 'auto' ? '자동 선택' : '추천'} ·{' '}
          {recommendation || '설정에서 모델을 선택하세요'}{' '}
          <span>
            {image || includeCapture
              ? '이미지 난이도 미확정'
              : complex
                ? '여러 단계의 추론'
                : '간단한 설명 · 로컬 규칙'}
          </span>
          {settings.routing === 'recommend' && recommendation && (
            <button onClick={() => setModel(recommendation)}>사용</button>
          )}
        </div>
      )}
      <div className="composer-actions">
        <button disabled={busy || running} onClick={() => fileInput.current?.click()}>
          ＋ 파일·이미지
        </button>
        {onCapture && (
          <label className={`capture-toggle ${includeCapture ? 'checked' : ''}`}>
            <input
              type="checkbox"
              aria-label="화면 캡처 포함"
              checked={includeCapture}
              disabled={busy || running}
              onChange={(e) => {
                setIncludeCapture(e.target.checked)
                localStorage.setItem(captureKey, String(e.target.checked))
                if (e.target.checked) setImage('')
              }}
            />
            화면 캡처 포함
          </label>
        )}
        <button disabled={busy || running || !canRefine} onClick={() => void refine()}>
          질문 다듬기
        </button>
        <select
          aria-label="사용 모델"
          value={model}
          disabled={running || settings.routing === 'auto'}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="">모델 선택</option>
          {[...new Set([...settings.models, settings.model, model].filter(Boolean))].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button disabled={busy || running || !canRefine} onClick={() => void send(true)}>
          저장만
        </button>
        {running ? (
          <button
            className="danger"
            disabled={capturing}
            onClick={() => void window.fask.cancel(request.current || question.current)}
          >
            {capturing ? '화면 캡처 중…' : '중지'}
          </button>
        ) : (
          <button className="primary" disabled={busy || !hasInput} onClick={() => void send()}>
            {busy
              ? '처리 중…'
              : settings.refine && !refined && canRefine
                ? '다듬고 검토'
                : '질문하기 ↗'}
          </button>
        )}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <small className="composer-hint">
        {onCapture && includeCapture && (
          <>
            질문하기를 누르면 현재 화면의 설정 영역을 캡처해 전송합니다. 저장만·다듬기에서는
            캡처하지 않습니다.
            <br />
          </>
        )}
        이미지 붙여넣기·파일 드래그 가능 · 이미지 1장, 텍스트/코드 최대 5개 · Ctrl + Enter로 전송
      </small>
    </div>
  )
}

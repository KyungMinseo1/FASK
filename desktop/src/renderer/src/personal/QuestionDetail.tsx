import { useEffect, useRef, useState } from 'react'
import type { Concept, Question, Turn } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import MarkdownAnswer from './MarkdownAnswer'
import CopyButton from './CopyButton'
import TurnNav from './TurnNav'
import { useApi } from './api'
import { loadAttachment } from './attachment-cache'
import { dateLabel } from './common'
import { useT } from '../../../shared/i18n/react'

type Run = (fn: () => Promise<unknown>) => Promise<boolean>

export default function QuestionDetail({
  question: q,
  concepts,
  run,
  onClose,
  onCreateConcept,
  onContinue,
  earlierOnly = false
}: {
  question: Question
  concepts: Concept[]
  run: Run
  /** Omitted where the host already has its own close control (desktop question panel). */
  onClose?: () => void
  onCreateConcept: (name: string) => Promise<void>
  onContinue?: () => void
  /**
   * Question panel history: shows only the turns before the last one (the Composer shows that)
   * and leaves the jump controls to the panel's own TurnNav.
   */
  earlierOnly?: boolean
}): React.JSX.Element {
  const t = useT()
  const api = useApi()
  const [memo, setMemo] = useState(q.memo)
  const [memoState, setMemoState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const memoTimer = useRef<number>(undefined)
  useEffect(() => () => clearTimeout(memoTimer.current), [])
  const memoDirty = memo !== q.memo
  const saveMemo = async (): Promise<void> => {
    clearTimeout(memoTimer.current)
    setMemoState('saving')
    const ok = await run(() => api.updateQuestion(q.id, { memo }))
    setMemoState(ok ? 'saved' : 'idle')
    if (ok) memoTimer.current = window.setTimeout(() => setMemoState('idle'), 2000)
  }
  return (
    <aside className="question-detail">
      <header>
        <span className="eyebrow">QUESTION NOTES</span>
        {onClose && <button onClick={onClose}>{t('닫기 ×')}</button>}
      </header>
      <div className="detail-title">
        <h2>{questionHeading(q)}</h2>
        <button
          className={q.important ? 'star active' : 'star'}
          aria-label={t('중요 표시')}
          onClick={() => void run(() => api.updateQuestion(q.id, { important: !q.important }))}
        >
          {q.important ? '★' : '☆'}
        </button>
      </div>
      <p className="detail-meta">
        {dateLabel(q.createdAt)} · {t('대화 {{count}}개', { count: q.turns.length })}
      </p>
      {(earlierOnly ? q.turns.slice(0, -1) : q.turns).map((t, i) => (
        <TurnView key={t.id} questionId={q.id} turn={t} index={i} run={run} />
      ))}
      <h3>{t('연결된 개념')}</h3>
      <div className="concept-checks">
        {concepts.map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={q.conceptIds.includes(c.id)}
              onChange={(e) =>
                void run(() =>
                  api.updateQuestion(q.id, {
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
          <small>{t('새 개념 제안 · 클릭하면 연결')}</small>
          {q.suggestions.map((s) => (
            <button key={s} onClick={() => void run(() => onCreateConcept(s))}>
              ＋ {s}
            </button>
          ))}
        </div>
      )}
      <label className="memo-label">
        <span className="memo-label-head">
          {t('나의 메모')}
          {memoDirty && <small className="memo-dirty">{t('저장되지 않은 변경')}</small>}
        </span>
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder={t('확인한 사실, 결정, 다음 할 일…')}
        />
      </label>
      <button
        className={memoState === 'saved' && !memoDirty ? 'memo-saved' : ''}
        disabled={!memoDirty || memoState === 'saving'}
        onClick={() => void saveMemo()}
      >
        {memoState === 'saving'
          ? t('저장 중…')
          : memoDirty
            ? t('메모 저장')
            : memoState === 'saved'
              ? t('메모 저장됨 ✓')
              : t('메모 저장')}
      </button>
      {onContinue && (
        <button className="reply-button" onClick={onContinue}>
          {t('이 대화에 이어서 질문 ↗')}
        </button>
      )}
      {!earlierOnly && (
        <TurnNav
          turns={q.turns}
          important={q.important}
          onToggleImportant={() => void run(() => api.updateQuestion(q.id, { important: !q.important }))}
          onClose={onClose}
        />
      )}
    </aside>
  )
}

function TurnView({
  questionId,
  turn: t,
  index,
  run
}: {
  questionId: string
  turn: Turn
  index: number
  run: Run
}): React.JSX.Element {
  const tr = useT()
  const api = useApi()
  // The long question and its capture are folded by default; the image loads on first expand.
  const questionRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  // Keyed by attachment ID: once the image is removed (or replaced) the old state no longer applies.
  const [loaded, setLoaded] = useState<{
    id: string
    state: 'loading' | 'ready' | 'error'
    src?: string | null
  } | null>(null)
  const image = t.attachment && loaded?.id === t.attachment ? loaded : null
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const loadImage = (id: string): void => {
    setLoaded({ id, state: 'loading' })
    const settle = (next: { state: 'ready' | 'error'; src?: string | null }): void => {
      if (mounted.current)
        setLoaded((s) => (s?.id === id && s.state === 'loading' ? { id, ...next } : s))
    }
    loadAttachment(api, id).then(
      (src) => settle({ state: 'ready', src }),
      () => settle({ state: 'error' })
    )
  }
  const toggle = (): void => {
    if (!expanded && t.attachment && !image) loadImage(t.attachment)
    setExpanded(!expanded)
  }
  useEffect(() => {
    const el = questionRef.current
    if (!el || expanded) return
    const check = (): void => setClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [t.sent, expanded])
  return (
    <section className="detail-turn">
      <span className="eyebrow">{tr('질문 {{n}}', { n: index + 1 })}</span>
      <p
        ref={questionRef}
        className={`turn-question${expanded ? ' expanded' : clamped ? ' clamped' : ''}`}
      >
        {t.sent}
      </p>
      {(clamped || expanded || !!t.attachment) && (
        <button className="turn-question-toggle" onClick={toggle}>
          {expanded
            ? tr('질문 접기')
            : t.attachment
              ? tr('▧ 캡처 이미지 · 펼쳐서 보기')
              : tr('질문 더보기')}
        </button>
      )}
      {t.refined && (
        <details>
          <summary>{tr('원래 질문')}</summary>
          <p>{t.raw}</p>
        </details>
      )}
      {expanded && image && (
        <div className="detail-capture">
          {image.state === 'loading' && (
            <p className="capture-status">{tr('이미지 불러오는 중…')}</p>
          )}
          {image.state === 'ready' && image.src && (
            <>
              <img src={image.src} alt={tr('질문에 사용한 캡처')} />
              <button onClick={() => void run(() => api.clearAttachment(questionId, t.id))}>
                {tr('보관 이미지 제거')}
              </button>
            </>
          )}
          {image.state === 'error' && (
            <p className="capture-status">
              {tr('이미지를 불러오지 못했습니다.')}{' '}
              <button onClick={() => loadImage(image.id)}>{tr('다시 시도')}</button>
            </p>
          )}
        </div>
      )}
      {t.documents.map((d, i) => (
        <details key={`${d.name}:${i}`} className="document-detail">
          <summary>▤ {d.name}</summary>
          <pre>{d.text}</pre>
        </details>
      ))}
      <div className="detail-answer">
        {t.answer && (
          <div className="answer-head">
            <CopyButton text={() => t.answer} label={tr('답변 복사')} />
          </div>
        )}
        <MarkdownAnswer>{t.answer || tr('아직 답변이 없습니다.')}</MarkdownAnswer>
      </div>
      {t.error && <p className="notice error">{t.error}</p>}
      {t.status === 'running' && (
        <button onClick={() => void run(() => api.cancel(t.id))}>{tr('답변 생성 중지')}</button>
      )}
      <details>
        <summary>{tr('모델 추천 근거')}</summary>
        <p>{t.actualModel || t.model || tr('모델 미지정')}</p>
        <p>{t.routingReason}</p>
      </details>
    </section>
  )
}

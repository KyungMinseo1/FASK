import { useEffect, useState } from 'react'
import type { Concept, Question, Turn } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import MarkdownAnswer from './MarkdownAnswer'
import { useApi } from './api'
import { dateLabel } from './common'

type Run = (fn: () => Promise<unknown>) => Promise<void>

export default function QuestionDetail({
  question: q,
  concepts,
  run,
  onClose,
  onCreateConcept,
  onContinue
}: {
  question: Question
  concepts: Concept[]
  run: Run
  onClose: () => void
  onCreateConcept: (name: string) => Promise<void>
  onContinue?: () => void
}): React.JSX.Element {
  const api = useApi()
  const [memo, setMemo] = useState(q.memo)
  return (
    <aside className="question-detail">
      <header>
        <span className="eyebrow">QUESTION NOTES</span>
        <button onClick={onClose}>닫기 ×</button>
      </header>
      <div className="detail-title">
        <h2>{questionHeading(q)}</h2>
        <button
          className={q.important ? 'star active' : 'star'}
          aria-label="중요 표시"
          onClick={() =>
            void run(() => api.updateQuestion(q.id, { important: !q.important }))
          }
        >
          {q.important ? '★' : '☆'}
        </button>
      </div>
      <p className="detail-meta">
        {dateLabel(q.createdAt)} · 대화 {q.turns.length}개
      </p>
      {q.turns.map((t, i) => (
        <TurnView key={t.id} questionId={q.id} turn={t} index={i} run={run} />
      ))}
      <h3>연결된 개념</h3>
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
      <button onClick={() => void run(() => api.updateQuestion(q.id, { memo }))}>
        메모 저장
      </button>
      {onContinue && (
        <button className="reply-button" onClick={onContinue}>
          이 대화에 이어서 질문 ↗
        </button>
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
  const api = useApi()
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (t.attachment)
      void api
        .attachment(t.attachment)
        .then((img) => {
          if (alive) setImage(img)
        })
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [api, t.attachment])
  return (
    <section className="detail-turn">
      <span className="eyebrow">질문 {index + 1}</span>
      <p className="turn-question">{t.sent}</p>
      {t.refined && (
        <details>
          <summary>원래 질문</summary>
          <p>{t.raw}</p>
        </details>
      )}
      {t.attachment && image && (
        <div className="detail-capture">
          <img src={image} alt="질문에 사용한 캡처" />
          <button onClick={() => void run(() => api.clearAttachment(questionId, t.id))}>
            보관 이미지 제거
          </button>
        </div>
      )}
      {t.documents.map((d, i) => (
        <details key={`${d.name}:${i}`} className="document-detail">
          <summary>▤ {d.name}</summary>
          <pre>{d.text}</pre>
        </details>
      ))}
      <div className="detail-answer">
        <MarkdownAnswer>{t.answer || '아직 답변이 없습니다.'}</MarkdownAnswer>
      </div>
      {t.error && <p className="notice error">{t.error}</p>}
      {t.status === 'running' && (
        <button onClick={() => void run(() => api.cancel(t.id))}>답변 생성 중지</button>
      )}
      <details>
        <summary>모델 추천 근거</summary>
        <p>{t.actualModel || t.model || '모델 미지정'}</p>
        <p>{t.routingReason}</p>
      </details>
    </section>
  )
}

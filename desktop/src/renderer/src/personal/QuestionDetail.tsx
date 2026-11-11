import { useEffect, useRef, useState } from 'react'
import type { Concept, Question, Reference, Turn } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import MarkdownAnswer from './MarkdownAnswer'
import CopyButton from './CopyButton'
import TurnNav from './TurnNav'
import ReferenceChips from './ReferenceChips'
import { Icon } from './ToolbarIcons'
import { useApi } from './api'
import { loadAttachment } from './attachment-cache'
import { dateLabel } from './common'
import { questionTags } from './questionTree'
import { useT } from '../../../shared/i18n/react'

type Run = (fn: () => Promise<unknown>) => Promise<boolean>

export default function QuestionDetail({
  question: q,
  concepts,
  shared,
  run,
  onClose,
  onCreateConcept,
  onContinue,
  focusConceptId,
  onReference,
  earlierOnly = false,
  expanded = false,
  onToggleExpand
}: {
  question: Question
  /**
   * Concepts the question can link, the project's graph concepts first and then the rest of the
   * workspace; linked chips and the '+ 개념 연결' search come from this list.
   */
  concepts: Concept[]
  /** Concepts another project also links; marked '공유'. */
  shared?: Set<string>
  run: Run
  /** Omitted where the host already has its own close control (desktop question panel). */
  onClose?: () => void
  onCreateConcept: (name: string) => Promise<void>
  onContinue?: () => void
  /** Opened from a concept: scrolls to the turns where it appears, with 'n/m턴 · 다음'. */
  focusConceptId?: string | null
  /** Opens a "참고한 지식" chip; chips are hidden when omitted. */
  onReference?: (ref: Reference) => void
  /**
   * Question panel history: shows only the turns before the last one (the Composer shows that)
   * and leaves the jump controls to the panel's own TurnNav.
   */
  earlierOnly?: boolean
  /** Desktop dashboard: the note fills the whole area and the question list is hidden. */
  expanded?: boolean
  onToggleExpand?: () => void
}): React.JSX.Element {
  const t = useT()
  const api = useApi()
  const [memo, setMemo] = useState(q.memo)
  const [memoState, setMemoState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const memoTimer = useRef<number>(undefined)
  useEffect(() => () => clearTimeout(memoTimer.current), [])
  const memoDirty = memo !== q.memo
  const shownTurns = earlierOnly ? q.turns.slice(0, -1) : q.turns
  // A linked-concept chip clicked here overrides the host's focusConceptId until that prop changes.
  const [picked, setPicked] = useState<{ from: string | null | undefined; id: string } | null>(null)
  const focusId = picked && picked.from === focusConceptId ? picked.id : focusConceptId
  // Turns where the focused concept appears; a concept without recorded turns points at the first.
  const focusTurns = !focusId
    ? []
    : (() => {
        const listed = (q.conceptTurns?.[focusId] ?? []).filter((id) => shownTurns.some((x) => x.id === id))
        return listed.length ? listed : shownTurns.slice(0, 1).map((x) => x.id)
      })()
  // Position among focusTurns, remembered per focused concept so a new concept starts at its first
  // turn; `tick` re-scrolls when the same chip is clicked again.
  const [focusAt, setFocusAt] = useState({ concept: focusId, index: 0, tick: 0 })
  const focusIndex = focusAt.concept === focusId ? focusAt.index : 0
  const focusTurnId = focusTurns[Math.min(focusIndex, focusTurns.length - 1)]
  const turnsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusTurnId) return
    turnsRef.current
      ?.querySelector(`[data-turn-id="${CSS.escape(focusTurnId)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focusTurnId, focusAt.tick])
  const focusConcept = concepts.find((c) => c.id === focusId)
  const { focus: linked, support } = questionTags(q, concepts)
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const matches = concepts
    .filter(
      (c) =>
        !q.conceptIds.includes(c.id) &&
        (!needle || [c.name, ...c.aliases].some((s) => s.toLowerCase().includes(needle)))
    )
    .slice(0, 8)
  const link = (id: string): void => {
    setPicking(false)
    setSearch('')
    void run(() => api.updateQuestion(q.id, { conceptIds: [...q.conceptIds, id] }))
  }
  // Concepts and memo fold behind the action bar so the note's turns start right under it.
  const [section, setSection] = useState<'concepts' | 'memo' | null>(null)
  const sectionRef = useRef<HTMLDivElement>(null),
    barRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    // The pinned bar wraps to two rows in a narrow note; the opened section must land below it.
    el.style.scrollMarginTop = `${(barRef.current?.offsetHeight ?? 0) + 8}px`
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [section])
  const toggleSection = (s: 'concepts' | 'memo'): void => {
    if (section === 'concepts') {
      setPicking(false)
      setSearch('')
    }
    setSection(section === s ? null : s)
  }
  const saveMemo = async (): Promise<void> => {
    clearTimeout(memoTimer.current)
    setMemoState('saving')
    const ok = await run(() => api.updateQuestion(q.id, { memo }))
    setMemoState(ok ? 'saved' : 'idle')
    if (ok) memoTimer.current = window.setTimeout(() => setMemoState('idle'), 2000)
  }
  const chip = (c: Concept): React.JSX.Element => {
    // 1-based numbers of the recorded turns; a concept without an entry shows none.
    const turnIds = q.conceptTurns?.[c.id] ?? []
    const numbers = turnIds.map((id) => q.turns.findIndex((x) => x.id === id) + 1).filter((n) => n > 0)
    const target = turnIds.find((id) => shownTurns.some((x) => x.id === id))
    return (
      <span key={c.id} className="concept-chip">
        <button
          className="concept-chip-name"
          disabled={!target}
          title={numbers.length ? t('{{turns}}턴', { turns: numbers.join('·'), n: numbers.length }) : undefined}
          onClick={() => {
            setPicked({ from: focusConceptId, id: c.id })
            setFocusAt({ concept: c.id, index: 0, tick: focusAt.tick + 1 })
          }}
        >
          {c.name}
          {shared?.has(c.id) && <span className="shared-badge">{t('공유')}</span>}
        </button>
        <button
          className="concept-chip-remove"
          aria-label={t('{{name}} 연결 해제', { name: c.name })}
          onClick={() =>
            void run(() =>
              api.updateQuestion(q.id, { conceptIds: q.conceptIds.filter((id) => id !== c.id) })
            )
          }
        >
          <Icon name="close" size={12} />
        </button>
      </span>
    )
  }
  return (
    <aside className="question-detail">
      <header>
        <span>{t('질문 노트')}</span>
        <span className="detail-header-actions">
          {onToggleExpand && (
            <button
              className="detail-expand"
              aria-label={expanded ? t('질문 노트 원래 크기로') : t('질문 노트 확장')}
              aria-pressed={expanded}
              onClick={onToggleExpand}
            >
              <Icon name={expanded ? 'restore' : 'maximize'} size={14} />
              {expanded ? t('원래 크기') : t('확장')}
            </button>
          )}
          {onClose && (
            <button onClick={onClose}>
              <Icon name="close" size={14} />
              {t('닫기')}
            </button>
          )}
        </span>
      </header>
      <div className="detail-title">
        <h2>{questionHeading(q)}</h2>
        <button
          className={q.important ? 'star active' : 'star'}
          aria-label={t('중요 표시')}
          aria-pressed={q.important}
          onClick={() => void run(() => api.updateQuestion(q.id, { important: !q.important }))}
        >
          <Icon name="star" size={20} />
        </button>
      </div>
      <p className="detail-meta">
        <span>{dateLabel(q.createdAt)}</span>
        <span>{t('대화 {{count}}개', { count: q.turns.length })}</span>
      </p>
      <div ref={barRef} className={`detail-action-row${earlierOnly ? '' : ' sticky'}`}>
        {onContinue && (
          <button className="primary reply-button" onClick={onContinue}>
            <Icon name="reply" />
            {t('이 대화에 이어서 질문')}
          </button>
        )}
        <button
          className={section === 'concepts' ? 'active' : ''}
          aria-expanded={section === 'concepts'}
          onClick={() => toggleSection('concepts')}
        >
          {t('개념 {{count}}', { count: linked.length + support.length })}
          {q.suggestions.length > 0 && (
            <span className="detail-badge">{t('추천 {{count}}', { count: q.suggestions.length })}</span>
          )}
        </button>
        <button
          className={section === 'memo' ? 'active' : ''}
          aria-expanded={section === 'memo'}
          onClick={() => toggleSection('memo')}
        >
          <Icon name="note" size={14} />
          {t('메모')}
          {(q.memo.trim() !== '' || memoDirty) && <span className="detail-dot" aria-hidden="true" />}
        </button>
      </div>
      {section && (
        <div className="detail-section" ref={sectionRef}>
          {section === 'concepts' ? (
            <>
              <div className="concept-chips">
                {linked.map(chip)}
                {!linked.length && !support.length && (
                  <span className="concept-empty">{t('연결된 개념이 없습니다.')}</span>
                )}
                <button
                  className="concept-link-add"
                  aria-expanded={picking}
                  onClick={() => {
                    setPicking((p) => !p)
                    setSearch('')
                  }}
                >
                  <Icon name="plus" size={14} />
                  {t('개념 연결')}
                </button>
              </div>
              {picking && (
                <div className="concept-picker">
                  <input
                    autoFocus
                    value={search}
                    placeholder={t('개념 이름이나 동의어로 찾기')}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setPicking(false)
                      else if (e.key === 'Enter' && matches[0]) link(matches[0].id)
                    }}
                  />
                  {matches.length ? (
                    <ul>
                      {matches.map((c) => (
                        <li key={c.id}>
                          <button onClick={() => link(c.id)}>
                            {c.name}
                            {shared?.has(c.id) && <span className="shared-badge">{t('공유')}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="concept-empty">{t('맞는 개념이 없습니다.')}</p>
                  )}
                </div>
              )}
              {support.length > 0 && (
                <div className="concept-chips support" role="group" aria-label={t('관련 개념')}>
                  <small>{t('관련 개념')}</small>
                  {support.map(chip)}
                </div>
              )}
              {q.suggestions.length > 0 && (
                <div className="suggestions">
                  <small>{t('다른 질문에서 다시 나오면 개념이 됩니다. 누르면 바로 연결됩니다.')}</small>
                  {q.suggestions.map((s) => (
                    <button key={s} onClick={() => void run(() => onCreateConcept(s))}>
                      <Icon name="plus" size={14} />
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
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
                {memoState === 'saving' ? (
                  t('저장 중…')
                ) : !memoDirty && memoState === 'saved' ? (
                  <>
                    <Icon name="check" size={14} />
                    {t('메모 저장됨')}
                  </>
                ) : (
                  t('메모 저장')
                )}
              </button>
            </>
          )}
        </div>
      )}
      {focusTurnId && (
        <div className="concept-turn-nav" role="status">
          {focusConcept && <b>{focusConcept.name}</b>}
          <span>
            {t('{{n}}/{{m}}턴', {
              n: focusTurns.indexOf(focusTurnId) + 1,
              m: focusTurns.length
            })}
          </span>
          {focusTurns.length > 1 && (
            <button
              onClick={() =>
                setFocusAt({ concept: focusId, index: (focusIndex + 1) % focusTurns.length, tick: focusAt.tick })
              }
            >
              {t('다음')}
            </button>
          )}
        </div>
      )}
      <div ref={turnsRef}>
        {shownTurns.map((t, i) => (
          <TurnView
            key={t.id}
            questionId={q.id}
            turn={t}
            index={i}
            run={run}
            focused={t.id === focusTurnId}
            onReference={onReference}
          />
        ))}
      </div>
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
  run,
  focused,
  onReference
}: {
  questionId: string
  turn: Turn
  index: number
  run: Run
  focused: boolean
  onReference?: (ref: Reference) => void
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
    <section className={`detail-turn${focused ? ' concept-focus' : ''}`} data-turn-id={t.id}>
      <small className="turn-label">{tr('질문 {{n}}', { n: index + 1 })}</small>
      <p
        ref={questionRef}
        className={`turn-question${expanded ? ' expanded' : clamped ? ' clamped' : ''}`}
      >
        {t.sent}
      </p>
      {(clamped || expanded || !!t.attachment) && (
        <button className="turn-question-toggle" onClick={toggle}>
          {expanded ? (
            tr('질문 접기')
          ) : t.attachment ? (
            <>
              <Icon name="image" size={14} />
              {tr('캡처 이미지 펼쳐 보기')}
            </>
          ) : (
            tr('질문 더보기')
          )}
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
          <summary>
            <Icon name="file" size={14} />
            {d.name}
          </summary>
          <pre>{d.text}</pre>
        </details>
      ))}
      <div className="detail-answer">
        {t.answer && (
          <div className="answer-head">
            {(t.actualModel || t.model) && (
              <span
                className="turn-model"
                title={
                  t.actualModel && t.model && t.actualModel !== t.model
                    ? tr('요청한 모델: {{model}}', { model: t.model })
                    : undefined
                }
              >
                {t.actualModel || t.model}
              </span>
            )}
            <CopyButton text={() => t.answer} label={tr('답변 복사')} />
          </div>
        )}
        <MarkdownAnswer>{t.answer || tr('아직 답변이 없습니다.')}</MarkdownAnswer>
      </div>
      {onReference && <ReferenceChips references={t.references} onReference={onReference} />}
      {t.error && <p className="notice error">{t.error}</p>}
      {t.status === 'running' && (
        <button onClick={() => void run(() => api.cancel(t.id))}>{tr('답변 생성 중지')}</button>
      )}
      <details>
        <summary>{tr('모델 추천 근거')}</summary>
        <p>{t.routingReason}</p>
      </details>
    </section>
  )
}

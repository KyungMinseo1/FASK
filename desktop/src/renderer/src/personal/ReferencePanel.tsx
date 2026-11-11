import { useMemo, useRef } from 'react'
import type { Question, Reference, Snapshot } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import { useT } from '../../../shared/i18n/react'
import QuestionDetail from './QuestionDetail'
import { Icon } from './ToolbarIcons'
import { linkableConcepts, projectConcepts } from './questionTree'

/** Default size; a resized panel sets the size the next reference opens with. */
export const REF_W = 380,
  REF_H = 520
/** Smallest size the corner handle allows (the main question panel's minimum). */
const MIN_W = 320,
  MIN_H = 260

/**
 * A question the answer referenced, opened beside the overlay question panel instead of replacing
 * its conversation. It hides and returns with the question panel, keeping position, size and scroll;
 * nothing is persisted, so the overlay drops these panels when it closes.
 */
export default function ReferencePanel({
  data,
  question,
  x,
  y,
  width,
  height,
  run,
  onMove,
  onResize,
  onInteraction,
  onFront,
  onClose,
  onContinue,
  onReference,
  folded
}: {
  data: Snapshot
  question: Question
  x: number
  y: number
  width: number
  height: number
  run: (fn: () => Promise<unknown>) => Promise<boolean>
  onMove: (x: number, y: number) => void
  onResize: (width: number, height: number) => void
  /** True while the header or corner is dragged, so the overlay keeps the pointer outside hit regions. */
  onInteraction: (active: boolean) => void
  onFront: () => void
  onClose: () => void
  onContinue?: () => void
  onReference: (ref: Reference) => void
  /** The question panel is folded: stay mounted and laid out (scroll, drafts) but invisible and unclickable. */
  folded: boolean
}): React.JSX.Element {
  const t = useT()
  const w = Math.min(width, innerWidth - 16),
    h = Math.min(height, innerHeight - 16)
  const left = Math.max(8, Math.min(x, innerWidth - w - 8)),
    top = Math.max(8, Math.min(y, innerHeight - h - 8))
  const drag = useRef<{
    resize: boolean
    x: number
    y: number
    left: number
    top: number
    w: number
    h: number
  } | null>(null)
  const project = data.projects.find((p) => p.id === question.projectId)
  const remote = !!data.workspaces.find((ws) => ws.id === project?.workspaceId)?.remote
  const heading = questionHeading(question).replace(/\s+/g, ' ').trim()
  const known = useMemo(
    () => ({
      concepts: linkableConcepts(data, question.projectId),
      shared: projectConcepts(data, question.projectId).shared
    }),
    [data, question.projectId]
  )
  const endDrag = (): void => {
    drag.current = null
    onInteraction(false)
  }
  const startDrag = (e: React.PointerEvent<HTMLElement>, resize: boolean): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    onInteraction(true)
    drag.current = { resize, x: e.clientX, y: e.clientY, left, top, w, h }
  }
  return (
    <section
      className={`overlay-panel overlay-ref-panel${folded ? ' folded' : ''}`}
      aria-hidden={folded || undefined}
      aria-label={t('참고한 질문')}
      style={{ left, top, width: w, height: h }}
      onPointerDownCapture={onFront}
    >
      <header
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest('button')) startDrag(e, false)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d && !d.resize)
            onMove(
              Math.max(0, Math.min(innerWidth - w - 8, d.left + e.clientX - d.x)),
              Math.max(0, Math.min(innerHeight - h - 8, d.top + e.clientY - d.y))
            )
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div>
          <small>
            {t('참고한 질문')} · {project?.name ?? ''}
            {remote && <Icon name="globe" size={12} />}
          </small>
          <b className="overlay-panel-thread" title={heading}>
            {heading}
          </b>
        </div>
        <button aria-label={t('참고 질문 닫기')} onClick={onClose}>
          <Icon name="close" size={14} />
          {t('닫기')}
        </button>
      </header>
      <div className="overlay-panel-content">
        <QuestionDetail
          key={question.id}
          question={question}
          concepts={known.concepts}
          shared={known.shared}
          run={run}
          onReference={onReference}
          onContinue={onContinue}
          onCreateConcept={async (name) => {
            const id = await window.fask.create('concept', name, question.projectId)
            await window.fask.updateQuestion(question.id, {
              conceptIds: [...new Set([...question.conceptIds, id])],
              suggestions: question.suggestions.filter((s) => s !== name)
            })
          }}
        />
      </div>
      <footer className="overlay-panel-footer">
        <small>{t('모서리를 드래그해 크기 조절')}</small>
        <button
          type="button"
          className="panel-resize-handle se"
          aria-label={t('참고 질문 크기 조절')}
          title={t('드래그해서 참고 질문 크기 조절')}
          onPointerDown={(e) => {
            e.preventDefault()
            startDrag(e, true)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d?.resize) return
            // The top-left corner stays put; the panel grows toward the bottom-right screen edge.
            onResize(
              Math.max(
                Math.min(MIN_W, innerWidth - 16),
                Math.min(innerWidth - d.left - 8, d.w + e.clientX - d.x)
              ),
              Math.max(
                Math.min(MIN_H, innerHeight - 16),
                Math.min(innerHeight - d.top - 8, d.h + e.clientY - d.y)
              )
            )
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <Icon name="resize" size={14} />
        </button>
      </footer>
    </section>
  )
}

import { useMemo, useRef } from 'react'
import type { Question, Reference, Snapshot } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import { useT } from '../../../shared/i18n/react'
import QuestionDetail from './QuestionDetail'
import { Icon } from './ToolbarIcons'
import { linkableConcepts, projectConcepts } from './questionTree'

export const REF_W = 380,
  REF_H = 520

/**
 * A question the answer referenced, opened beside the overlay question panel instead of replacing
 * its conversation. Positions are not persisted; the overlay drops these panels when it closes.
 */
export default function ReferencePanel({
  data,
  question,
  x,
  y,
  run,
  onMove,
  onInteraction,
  onFront,
  onClose,
  onContinue,
  onReference
}: {
  data: Snapshot
  question: Question
  x: number
  y: number
  run: (fn: () => Promise<unknown>) => Promise<boolean>
  onMove: (x: number, y: number) => void
  /** True while the header is dragged, so the overlay keeps the pointer outside hit regions. */
  onInteraction: (active: boolean) => void
  onFront: () => void
  onClose: () => void
  onContinue?: () => void
  onReference: (ref: Reference) => void
}): React.JSX.Element {
  const t = useT()
  const w = Math.min(REF_W, innerWidth - 16),
    h = Math.min(REF_H, innerHeight - 16)
  const left = Math.max(8, Math.min(x, innerWidth - w - 8)),
    top = Math.max(8, Math.min(y, innerHeight - h - 8))
  const moving = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
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
  const endMove = (): void => {
    moving.current = null
    onInteraction(false)
  }
  return (
    <section
      className="overlay-panel overlay-ref-panel"
      aria-label={t('참고한 질문')}
      style={{ left, top, width: w, height: h }}
      onPointerDownCapture={onFront}
    >
      <header
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          onInteraction(true)
          moving.current = { x: e.clientX, y: e.clientY, left, top }
        }}
        onPointerMove={(e) => {
          const d = moving.current
          if (d)
            onMove(
              Math.max(0, Math.min(innerWidth - w - 8, d.left + e.clientX - d.x)),
              Math.max(0, Math.min(innerHeight - h - 8, d.top + e.clientY - d.y))
            )
        }}
        onPointerUp={endMove}
        onPointerCancel={endMove}
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
    </section>
  )
}

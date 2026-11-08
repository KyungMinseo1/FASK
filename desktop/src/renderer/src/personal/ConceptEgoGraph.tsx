import { useLayoutEffect, useRef, useState } from 'react'
import type { Concept, Relation } from '../../../preload/personal'
import { CHIP_FONT, CHIP_LINE, EGO_FONT, EGO_MIN_WIDTH, egoLayout, type EgoNode } from './egoGraph'
import { RELATION_LABELS } from './questionTree'
import { useT } from '../../../shared/i18n/react'

/**
 * A concept's approved relations as a small ego graph, laid out for the panel's width: the concept
 * centred, prerequisites left, parts/uses right, contrasts/examples below. Clicking a related
 * concept opens it.
 */
export default function ConceptEgoGraph({
  concept,
  relations,
  concepts,
  onOpen
}: {
  concept: Concept
  /** Approved, active relations of `concept`. */
  relations: Relation[]
  concepts: Concept[]
  onOpen: (conceptId: string) => void
}): React.JSX.Element {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(EGO_MIN_WIDTH)
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = (): void => setWidth(box.clientWidth || EGO_MIN_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])
  const layout = egoLayout(
    concept,
    relations,
    (id) => concepts.find((c) => c.id === id)?.name,
    (type) => t(RELATION_LABELS[type]),
    width
  )
  // The wrapper stays mounted (empty without relations) so its width is always known.
  if (!layout.nodes.length) return <div ref={boxRef} />
  const pill = (n: EgoNode, centre: boolean): React.JSX.Element => (
    <>
      <title>{n.name}</title>
      <rect
        x={n.x - n.width / 2}
        y={n.y - n.height / 2}
        width={n.width}
        height={n.height}
        rx={n.height / 2}
        className={centre ? 'ego-centre' : undefined}
      />
      <text x={n.x} y={n.y} fontSize={EGO_FONT}>
        {n.label}
      </text>
    </>
  )
  return (
    <div ref={boxRef} className="ego-graph">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={t('관계 그래프')}
      >
        {layout.edges.map(({ id, line, arrows, chip }) => (
          <g key={id} className="ego-edge">
            <line x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} />
            {arrows.map((points) => (
              <polygon key={points} points={points} />
            ))}
            <rect
              x={chip.x - chip.width / 2}
              y={chip.y - chip.height / 2}
              width={chip.width}
              height={chip.height}
              rx={Math.min(7, chip.height / 2)}
            />
            {chip.lines.map((l, i) => (
              <text
                key={l}
                x={chip.x}
                y={chip.y + (i - (chip.lines.length - 1) / 2) * CHIP_LINE}
                fontSize={CHIP_FONT}
              >
                {l}
              </text>
            ))}
          </g>
        ))}
        <g className="ego-node">{pill(layout.center, true)}</g>
        {layout.nodes.map((n) => (
          <g
            key={n.id}
            className="ego-node link"
            role="button"
            tabIndex={0}
            aria-label={n.name}
            onClick={() => onOpen(n.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen(n.id)
              }
            }}
          >
            {pill(n, false)}
          </g>
        ))}
      </svg>
    </div>
  )
}

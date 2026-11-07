import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type NodeProps } from '@xyflow/react'
import type { MindNode } from '../../lib/trees'
import { HANDLE, isUnclassified, type MindFlowNode } from './layout'
import { useT } from '../../../../shared/i18n/react'
import { Chevron } from '../../personal/ToolbarIcons'

const handleStyle = (left: string): React.CSSProperties => ({
  left,
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  background: 'transparent',
  opacity: 0
})

/** Invisible 1px handles: tree edges attach to the pill sides, relation overlays to the centre. */
const HANDLES = [
  { id: HANDLE.left, style: handleStyle('0%'), target: Position.Left, source: Position.Left },
  { id: HANDLE.right, style: handleStyle('100%'), target: Position.Right, source: Position.Right },
  { id: HANDLE.center, style: handleStyle('50%'), target: Position.Top, source: Position.Bottom }
]

/** G1 pills: root in the primary color, unclassified as an empty dashed outline. */
function pillStyle(mind: MindNode, depth: number): React.CSSProperties {
  if (depth === 0) return { background: 'var(--primary)', color: 'var(--on-primary)' }
  if (isUnclassified(mind)) {
    return {
      background: 'var(--graph-board)',
      border: '1.2px dashed var(--graph-edge)',
      color: 'var(--ink-muted)'
    }
  }
  return {
    background: 'var(--graph-node)',
    border: '1.2px solid var(--graph-node-line)',
    color: mind.kind === 'question' ? 'var(--ink-muted)' : 'var(--ink)'
  }
}

/** Horizontal S-curve from the parent's side facing the child to the child's near side. */
export function CurveEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps): React.JSX.Element {
  const mx = (sourceX + targetX) / 2
  return (
    <BaseEdge
      id={id}
      path={`M${sourceX} ${sourceY} C${mx} ${sourceY} ${mx} ${targetY} ${targetX} ${targetY}`}
      style={style}
    />
  )
}

export type RelationFlowEdge = Edge<
  {
    label: string
    pending: boolean
    /** Pill sizes of both ends, so the line stops at their borders instead of their centres. */
    sourceSize: [number, number]
    targetSize: [number, number]
  },
  'relation'
>

/**
 * A selected concept's relation: dashed curve between the two pill borders with an arrowhead at
 * the target and the relation type as label. Pending (unapproved) relations are drawn fainter.
 */
export function RelationEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data
}: EdgeProps<RelationFlowEdge>): React.JSX.Element | null {
  const t = useT()
  if (!data) return null
  const dx = targetX - sourceX,
    dy = targetY - sourceY
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len,
    uy = dy / len
  // Distance from a pill centre to its border along the line, plus a small gap.
  const clip = ([w, h]: [number, number]): number =>
    Math.min(ux ? w / 2 / Math.abs(ux) : Infinity, uy ? h / 2 / Math.abs(uy) : Infinity) + 6
  const sx = sourceX + ux * clip(data.sourceSize),
    sy = sourceY + uy * clip(data.sourceSize)
  const ex = targetX - ux * clip(data.targetSize),
    ey = targetY - uy * clip(data.targetSize)
  // Bowed more than tree edges so a relation along a tree edge stays distinguishable.
  const bow = Math.min(60, len * 0.2)
  const cx = (sourceX + targetX) / 2 + uy * bow,
    cy = (sourceY + targetY) / 2 - ux * bow
  // Arrowhead along the curve's end tangent.
  const tl = Math.hypot(ex - cx, ey - cy) || 1
  const ax = (ex - cx) / tl,
    ay = (ey - cy) / tl
  const arrow = `M${ex} ${ey} L${ex - ax * 9 - ay * 4.5} ${ey - ay * 9 + ax * 4.5} L${ex - ax * 9 + ay * 4.5} ${ey - ay * 9 - ax * 4.5} Z`
  const color = data.pending ? 'var(--ink-muted)' : 'var(--primary)'
  const opacity = data.pending ? 0.6 : 1
  return (
    <>
      <BaseEdge
        id={id}
        path={`M${sx} ${sy} Q${cx} ${cy} ${ex} ${ey}`}
        style={{ stroke: color, strokeWidth: data.pending ? 1.4 : 2, strokeDasharray: '6 4', opacity }}
        label={t(data.label)}
        labelX={(sx + 2 * cx + ex) / 4}
        labelY={(sy + 2 * cy + ey) / 4}
        labelStyle={{ fill: color, fontSize: 11.5, fontWeight: 700, opacity }}
        labelShowBg
        labelBgStyle={{ fill: 'var(--surface-1)', stroke: color, strokeWidth: 1, opacity }}
        labelBgPadding={[6, 3]}
        labelBgBorderRadius={8}
      />
      <path d={arrow} fill={color} opacity={opacity} />
    </>
  )
}

export default function MindNodeView({ data }: NodeProps<MindFlowNode>): React.JSX.Element {
  const t = useT()
  const { mind, depth, width, height, fontSize, expanded, selected, dragging, dropTarget, marked } = data
  const expandable = depth > 0 && mind.children.length > 0
  const count = depth > 0 && mind.count != null && mind.count > 0 ? mind.count : 0
  const hot = count >= 2

  return (
    <div
      className={`relative ${dragging ? 'cursor-grabbing opacity-80' : 'cursor-pointer'}`}
      style={{ width, height }}
    >
      {HANDLES.map((h) => (
        <Handle
          key={`in-${h.id}`}
          id={h.id}
          type="target"
          position={h.target}
          style={h.style}
          isConnectable={false}
        />
      ))}
      {marked && !dragging && (
        // Nodes holding questions: a static dashed outline around the pill.
        <span
          className="pointer-events-none absolute -inset-[5px] rounded-full border-2 border-dashed"
          style={{ borderColor: 'var(--graph-hot)' }}
        />
      )}
      {dropTarget && (
        <span
          className="pointer-events-none absolute -inset-[8px] rounded-full border-[3px]"
          style={{
            borderColor: 'var(--focus-ring)',
            background: 'color-mix(in srgb, var(--graph-hot) 15%, transparent)'
          }}
        />
      )}
      <div
        className="flex h-full w-full items-center rounded-full"
        style={{
          ...pillStyle(mind, depth),
          gap: 6,
          padding: count ? '0 7px 0 16px' : '0 16px',
          justifyContent: 'center',
          fontSize,
          fontWeight: depth === 0 ? 800 : 650,
          outline: selected ? '2px solid var(--focus-ring)' : undefined,
          outlineOffset: 3
        }}
        title={mind.detail ? `${mind.label}\n\n${mind.detail}` : mind.label}
      >
        <span className="min-w-0 truncate leading-none">{mind.label}</span>
        {expandable && (
          // Collapsed/expanded affordance: points right while children are hidden, down when shown.
          <Chevron className={expanded ? 'mind-chev' : 'mind-chev collapsed'} />
        )}
        {count > 0 && (
          <span
            className="grid shrink-0 place-items-center rounded-full"
            style={{
              width: 20,
              marginLeft: 'auto',
              height: 20,
              fontSize: 11.5,
              fontWeight: 800,
              fontVariantNumeric: 'tabular-nums',
              background: hot ? 'var(--graph-hot)' : 'var(--graph-cnt)',
              color: hot ? 'var(--graph-hot-ink)' : 'var(--ink)'
            }}
            title={t('질문 {{count}}개', { count })}
          >
            {count}
          </span>
        )}
      </div>
      {mind.badge && (
        <span
          className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full px-1.5 text-[10px] leading-4"
          style={{
            background: 'var(--surface-1)',
            color: 'var(--ink-muted)',
            border: '1px solid var(--hairline)'
          }}
        >
          {mind.badge}
        </span>
      )}
      {HANDLES.map((h) => (
        <Handle
          key={`out-${h.id}`}
          id={h.id}
          type="source"
          position={h.source}
          style={h.style}
          isConnectable={false}
        />
      ))}
    </div>
  )
}

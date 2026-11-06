import { BaseEdge, Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import type { MindNode } from '../../lib/trees'
import { isUnclassified, type MindFlowNode } from './layout'
import { useT } from '../../../../shared/i18n/react'
import { Chevron } from '../../personal/ToolbarIcons'

/** Invisible handle pinned to the pill centre so edges run centre-to-centre. */
const centerHandle: React.CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  background: 'transparent',
  opacity: 0
}

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

/** Gentle quadratic curve between two pill centres, bowed to the left of the travel direction. */
export function CurveEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps): React.JSX.Element {
  const dx = targetX - sourceX,
    dy = targetY - sourceY
  const bow = Math.min(36, Math.hypot(dx, dy) * 0.12)
  const len = Math.hypot(dx, dy) || 1
  const cx = (sourceX + targetX) / 2 + (dy / len) * bow
  const cy = (sourceY + targetY) / 2 - (dx / len) * bow
  return <BaseEdge id={id} path={`M${sourceX} ${sourceY} Q${cx} ${cy} ${targetX} ${targetY}`} style={style} />
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
      <Handle type="target" position={Position.Top} style={centerHandle} isConnectable={false} />
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
      <Handle type="source" position={Position.Bottom} style={centerHandle} isConnectable={false} />
    </div>
  )
}

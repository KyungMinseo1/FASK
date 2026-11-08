import { BaseEdge, Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import type { MindNode } from '../../lib/trees'
import { HANDLE, isUnclassified, type MindFlowNode, type NodeTag } from './layout'
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

/** Invisible 1px handles on the pill sides, where tree edges attach. */
const HANDLES = [
  { id: HANDLE.left, style: handleStyle('0%'), position: Position.Left },
  { id: HANDLE.right, style: handleStyle('100%'), position: Position.Right }
]

/** Opacity of nodes and edges outside the current highlight. */
export const DIMMED_OPACITY = 0.35

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

/** `선행 →` (this node → the focus node), `← 선행` (the focus node → this node), or the bare label. */
function tagText(tag: NodeTag, t: (key: string) => string): string {
  const label = t(tag.label)
  return tag.arrow === 'out' ? `${label} →` : tag.arrow === 'in' ? `← ${label}` : label
}

export default function MindNodeView({ data }: NodeProps<MindFlowNode>): React.JSX.Element {
  const t = useT()
  const { mind, depth, width, height, fontSize, expanded, selected, dragging, dropTarget, marked, dimmed, tags } =
    data
  const expandable = depth > 0 && mind.children.length > 0
  const count = depth > 0 && mind.count != null && mind.count > 0 ? mind.count : 0
  const hot = count >= 2

  return (
    <div
      className={`relative ${dragging ? 'cursor-grabbing opacity-80' : 'cursor-pointer'}`}
      style={{
        width,
        height,
        opacity: dimmed && !dragging ? DIMMED_OPACITY : undefined,
        transition: 'opacity 0.2s'
      }}
    >
      {HANDLES.map((h) => (
        <Handle
          key={`in-${h.id}`}
          id={h.id}
          type="target"
          position={h.position}
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
      {tags && tags.length > 0 && (
        // Relation type to the focus node, notched onto the pill's top edge.
        <span className="mind-tag">{tags.map((tag) => tagText(tag, t)).join(' · ')}</span>
      )}
      {HANDLES.map((h) => (
        <Handle
          key={`out-${h.id}`}
          id={h.id}
          type="source"
          position={h.position}
          style={h.style}
          isConnectable={false}
        />
      ))}
    </div>
  )
}

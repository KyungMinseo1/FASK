import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { MindNodeKind } from '../../lib/trees'
import type { MindFlowNode } from './layout'
import { useT } from '../../../../shared/i18n/react'

/** Invisible handle pinned to the circle centre so straight edges run centre-to-centre. */
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

const tint = (color: string, pct: number): string => `color-mix(in srgb, ${color} ${pct}%, white)`
const shade = (color: string, pct: number): string => `color-mix(in srgb, ${color} ${pct}%, black)`

function circleStyle(kind: MindNodeKind, depth: number, color: string): React.CSSProperties {
  if (depth === 0) {
    return { background: color, color: 'white', boxShadow: `0 6px 18px ${tint(color, 45)}` }
  }
  if (kind === 'question') {
    return {
      background: 'white',
      border: `1.5px solid ${tint(color, 70)}`,
      color: shade(color, 55)
    }
  }
  if (depth === 1) {
    return { background: color, color: 'white', border: `2px solid ${shade(color, 88)}` }
  }
  return {
    background: tint(color, depth === 2 ? 26 : 16),
    border: `1.5px solid ${tint(color, 80)}`,
    color: shade(color, 50)
  }
}

export default function MindNodeView({ data }: NodeProps<MindFlowNode>): React.JSX.Element {
  const t = useT()
  const { mind, depth, diameter, color, expanded, open, selected, dragging, dropTarget, marked } =
    data
  const hiddenChildren = mind.children.length > 0 && !expanded ? mind.children.length : 0
  const showDetail = mind.kind === 'question' && open && mind.detail
  const fontSize = depth === 0 ? 13 : depth === 1 ? 11.5 : mind.kind === 'question' ? 10 : 10.5

  return (
    <div
      className={`group relative ${dragging ? 'cursor-grabbing opacity-80' : 'cursor-pointer'}`}
      style={{ width: diameter, height: diameter }}
    >
      <Handle type="target" position={Position.Top} style={centerHandle} isConnectable={false} />
      {marked && !dragging && (
        // Distinct marker for nodes holding student questions: a breathing amber halo.
        <span
          className="question-halo pointer-events-none absolute -inset-[7px] rounded-full border-2 border-dashed border-amber-400"
          style={{ background: 'rgb(251 191 36 / 0.10)' }}
        />
      )}
      {dropTarget && (
        <span className="pointer-events-none absolute -inset-[11px] rounded-full border-[3px] border-brand-500 bg-brand-500/15" />
      )}
      <div
        className={`flex h-full w-full items-center justify-center rounded-full px-1.5 text-center shadow-sm ${
          dragging ? 'shadow-lg' : 'transition-transform duration-150 group-hover:scale-[1.07]'
        }`}
        style={{
          ...circleStyle(mind.kind, depth, color),
          fontSize,
          outline: selected ? `2.5px solid ${shade(color, 80)}` : undefined,
          outlineOffset: 3
        }}
        title={mind.detail ? `${mind.label}\n\n${mind.detail}` : mind.label}
      >
        <span
          className={`line-clamp-3 break-keep leading-tight ${depth <= 1 ? 'font-semibold' : 'font-medium'}`}
        >
          {mind.label}
        </span>
      </div>
      {mind.count != null && mind.count > 0 && (
        <span
          className="absolute -right-1.5 -top-1.5 flex items-center gap-0.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-white shadow-sm"
          title={t('질문 {{count}}개', { count: mind.count })}
        >
          <span className="text-[9px]">💬</span>
          {mind.count}
        </span>
      )}
      {hiddenChildren > 0 && (
        <span
          className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-full px-1.5 text-[9.5px] font-semibold leading-4 text-white shadow-sm"
          style={{ background: shade(color, 85) }}
        >
          +{hiddenChildren}
        </span>
      )}
      {mind.badge && (
        <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gray-800/75 px-1.5 text-[9.5px] leading-4 text-white">
          {mind.badge}
        </span>
      )}
      {showDetail && (
        <div
          className="absolute left-1/2 top-full mt-6 w-60 -translate-x-1/2 cursor-default rounded-lg border bg-white p-2.5 text-xs leading-[18px] text-gray-800 shadow-lg"
          style={{ borderColor: tint(color, 55) }}
        >
          <p className="whitespace-pre-wrap break-words">{mind.detail}</p>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={centerHandle} isConnectable={false} />
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodeDrag,
  type XYPosition
} from '@xyflow/react'
import type { MindNode } from '../../lib/trees'
import { layoutMindMap, type MindFlowNode } from './layout'
import MindNodeView from './MindNodeView'
import { useT } from '../../../../shared/i18n/react'

export interface MindMapProps {
  root: MindNode
  selectedId?: string
  onSelect?: (node: MindNode) => void
  onContextMenu?: (node: MindNode, event: MouseEvent) => void
  height?: number | string
  /** Highlight nodes whose subtree holds student questions. */
  markQuestions?: boolean
  /** Enables Shift+drag: drop `node` onto `target` to move it under that group. */
  onMoveNode?: (node: MindNode, target: MindNode) => void
  canMove?: (node: MindNode) => boolean
  canDrop?: (node: MindNode, target: MindNode) => boolean
}

const nodeTypes: NodeTypes = { mind: MindNodeView }

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

const centerOf = (n: MindFlowNode, pos: XYPosition = n.position): XYPosition => ({
  x: pos.x + n.data.diameter / 2,
  y: pos.y + n.data.diameter / 2
})

/** Tracks whether Shift is held (reset on window blur so it never gets stuck). */
function useShiftKey(enabled: boolean): boolean {
  const [shift, setShift] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const down = (e: KeyboardEvent): void => setShift(e.shiftKey)
    const reset = (): void => setShift(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', down)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', down)
      window.removeEventListener('blur', reset)
    }
  }, [enabled])
  return enabled && shift
}

function MindMapInner({
  root,
  selectedId,
  onSelect,
  onContextMenu,
  markQuestions,
  onMoveNode,
  canMove,
  canDrop
}: MindMapProps): React.JSX.Element {
  const t = useT()
  const { fitView } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  // Only the root and its direct children are visible initially (max-depth = 1).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.id]))
  const [openQuestions, setOpenQuestions] = useState<Set<string>>(() => new Set())
  const shift = useShiftKey(!!onMoveNode)
  const [drag, setDrag] = useState<{ id: string; position: XYPosition } | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)

  const layout = useMemo(
    () => layoutMindMap(root, expanded, openQuestions, selectedId),
    [root, expanded, openQuestions, selectedId]
  )

  // Releasing Shift mid-drag cancels the move (React Flow drops the drag once nodes turn undraggable).
  const activeDrag = shift ? drag : null
  const activeDropId = shift ? dropId : null

  // Static per-layout node objects. Fixed width/height mean React Flow never has to re-measure
  // (and briefly hide) a node when it receives a new object during a drag.
  const baseNodes = useMemo(
    () =>
      layout.nodes.map((n) => ({
        ...n,
        width: n.data.diameter,
        height: n.data.diameter,
        draggable: shift && n.data.depth > 0 && (canMove?.(n.data.mind) ?? true),
        data: {
          ...n.data,
          marked: markQuestions && n.data.depth > 0 && !!n.data.mind.hasQuestions
        }
      })),
    [layout.nodes, shift, canMove, markQuestions]
  )

  // During a drag only the dragged node and the drop target get new objects; the rest keep
  // their identity so they don't re-render on every pointer move.
  const nodes = useMemo(
    () =>
      baseNodes.map((n) => {
        const dragging = activeDrag?.id === n.id
        const dropTarget = n.id === activeDropId
        if (!dragging && !dropTarget) return n
        return {
          ...n,
          position: dragging ? activeDrag.position : n.position,
          zIndex: dragging ? 2000 : n.zIndex,
          data: { ...n.data, dragging, dropTarget }
        }
      }),
    [baseNodes, activeDrag, activeDropId]
  )

  const fittedExpansion = useRef<Set<string> | null>(null)
  // Fit only on first render and when the expansion state changes — not on live data updates.
  useEffect(() => {
    if (!nodesInitialized || fittedExpansion.current === expanded) return
    const timer = setTimeout(() => {
      fittedExpansion.current = expanded
      void fitView({ padding: 0.15, duration: 400, maxZoom: 1.2 })
    }, 50)
    return () => clearTimeout(timer)
  }, [expanded, fitView, nodesInitialized])

  const onNodeClick: NodeMouseHandler<MindFlowNode> = useCallback(
    (_event, node) => {
      const mind = node.data.mind
      if (mind.kind === 'question') {
        setOpenQuestions((s) => toggled(s, mind.id))
      } else if (mind.children.length > 0) {
        setExpanded((s) => toggled(s, mind.id))
      }
      onSelect?.(mind)
    },
    [onSelect]
  )

  const onNodesChange = useCallback((changes: NodeChange<MindFlowNode>[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position && c.dragging) {
        setDrag({ id: c.id, position: c.position })
      }
    }
  }, [])

  /** Nearest valid node whose circle overlaps the dragged circle's centre. */
  const findDropTarget = useCallback(
    (dragged: MindFlowNode, position: XYPosition): MindFlowNode | null => {
      const c = centerOf(dragged, position)
      let best: MindFlowNode | null = null
      let bestDist = Infinity
      for (const n of layout.nodes) {
        if (n.id === dragged.id || n.data.mind.kind === 'question') continue
        if (canDrop && !canDrop(dragged.data.mind, n.data.mind)) continue
        const t = centerOf(n)
        const dist = Math.hypot(c.x - t.x, c.y - t.y)
        if (dist < n.data.diameter / 2 + 14 && dist < bestDist) {
          best = n
          bestDist = dist
        }
      }
      return best
    },
    [layout.nodes, canDrop]
  )

  const onNodeDrag: OnNodeDrag<MindFlowNode> = useCallback(
    (_event, node) => setDropId(findDropTarget(node, node.position)?.id ?? null),
    [findDropTarget]
  )

  const onNodeDragStop: OnNodeDrag<MindFlowNode> = useCallback(
    (_event, node) => {
      const target = findDropTarget(node, node.position)
      setDrag(null)
      setDropId(null)
      if (target && onMoveNode) onMoveNode(node.data.mind, target.data.mind)
    },
    [findDropTarget, onMoveNode]
  )

  return (
    <ReactFlow
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
      nodes={nodes}
      edges={layout.edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onNodeContextMenu={(event, node) => {
        if (onContextMenu) {
          event.preventDefault()
          onContextMenu(node.data.mind, event)
        }
      }}
      onNodesChange={onMoveNode ? onNodesChange : undefined}
      onNodeDrag={onMoveNode ? onNodeDrag : undefined}
      onNodeDragStop={onMoveNode ? onNodeDragStop : undefined}
      nodesDraggable={shift}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#d3d2ca" />
      <Controls showInteractive={false} />
      {onMoveNode && (
        <div
          className={`pointer-events-none absolute left-3 top-3 z-10 rounded-full px-3 py-1 text-xs shadow-sm transition ${
            shift ? 'bg-brand-600 text-white' : 'bg-white/90 text-gray-500'
          }`}
        >
          {shift
            ? t('노드를 끌어서 옮길 묶음 위에 놓으세요')
            : t('Shift + 드래그로 노드를 다른 묶음으로 이동')}
        </div>
      )}
    </ReactFlow>
  )
}

export default function MindMap(props: MindMapProps): React.JSX.Element {
  return (
    <div
      style={{ height: props.height ?? '100%', width: '100%' }}
      className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50"
    >
      <ReactFlowProvider>
        {/* Remount (reset expansion) when the root identity changes, e.g. switching tabs/modes. */}
        <MindMapInner key={props.root.id} {...props} />
      </ReactFlowProvider>
    </div>
  )
}

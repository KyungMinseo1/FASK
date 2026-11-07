import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  useNodesInitialized,
  type EdgeTypes,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodeDrag,
  type Edge,
  type XYPosition
} from '@xyflow/react'
import type { MindNode } from '../../lib/trees'
import { HANDLE, layoutMindMap, type MindFlowNode } from './layout'
import MindNodeView, { CurveEdge, RelationEdgeView, type RelationFlowEdge } from './MindNodeView'
import { useT } from '../../../../shared/i18n/react'

/** A non-tree edge drawn over the graph between two node ids (e.g. a selected concept's relation). */
export interface RelationEdge {
  id: string
  source: string
  target: string
  /** Korean source text, shown through `t()`. */
  label: string
  /** Not yet approved: drawn fainter. */
  pending?: boolean
}

export interface MindMapProps {
  root: MindNode
  selectedId?: string
  onSelect?: (node: MindNode) => void
  onContextMenu?: (node: MindNode, event: MouseEvent) => void
  height?: number | string
  /** Highlight nodes whose subtree holds student questions. */
  markQuestions?: boolean
  /** Enables long-press drag: drop `node` onto `target`; `copy` when Ctrl was held at release. */
  onMoveNode?: (node: MindNode, target: MindNode, copy: boolean) => void
  /** Ctrl at press or release turns a move into a copy; off on touch-only clients. */
  allowCopy?: boolean
  /** Extra buttons for the corner dock (e.g. "+ concept"). */
  actions?: ReactNode
  canMove?: (node: MindNode) => boolean
  canDrop?: (node: MindNode, target: MindNode) => boolean
  /** Overlay edges; only those whose both ends are currently visible are drawn. */
  relations?: RelationEdge[]
  /** When set, automatic fits frame these node ids (those currently visible) instead of the whole graph. */
  focusIds?: string[]
}

const nodeTypes: NodeTypes = { mind: MindNodeView }
const edgeTypes: EdgeTypes = { curve: CurveEdge, relation: RelationEdgeView }

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

const centerOf = (n: MindFlowNode, pos: XYPosition = n.position): XYPosition => ({
  x: pos.x + n.data.width / 2,
  y: pos.y + n.data.height / 2
})

const LONG_PRESS_MS = 380
/** Holding a picked-up node over a collapsed one this long expands it. */
const HOVER_EXPAND_MS = 650
const MOVE_SLOP = 6

/**
 * Long press arms a node for moving: hold still for LONG_PRESS_MS, then drag.
 * A drag that starts earlier is ignored, so quick drags never move anything by accident.
 */
function useLongPress(enabled: boolean): {
  armed: string | null
  /** Ctrl/Cmd was down when the press started. */
  ctrlAtPress: boolean
  disarm: () => void
  onPointerDown: (e: ReactPointerEvent) => void
} {
  const [armed, setArmed] = useState<string | null>(null)
  const [ctrlAtPress, setCtrlAtPress] = useState(false)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }, [])
  useEffect(() => {
    if (!enabled) return
    const move = (e: PointerEvent): void => {
      const p = press.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancel()
    }
    const up = (): void => {
      cancel()
      // Drag-stop handlers run first; clear the armed node right after them.
      setTimeout(() => setArmed(null), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
    }
  }, [enabled, cancel])
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!enabled || e.button !== 0) return
      const id = (e.target as Element).closest('.react-flow__node')?.getAttribute('data-id')
      if (!id) return
      cancel()
      setCtrlAtPress(e.ctrlKey || e.metaKey)
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          press.current = null
          setArmed(id)
          navigator.vibrate?.(15)
        }, LONG_PRESS_MS)
      }
    },
    [enabled, cancel]
  )
  return { armed, ctrlAtPress, disarm: () => setArmed(null), onPointerDown }
}

function MindMapInner({
  root,
  selectedId,
  onSelect,
  onContextMenu,
  markQuestions,
  onMoveNode,
  canMove,
  canDrop,
  allowCopy = true,
  actions,
  relations,
  focusIds
}: MindMapProps): React.JSX.Element {
  const t = useT()
  const { fitView, setViewport, zoomIn, zoomOut } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  // Only the root and its direct children are visible initially (max-depth = 1).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.id]))
  const press = useLongPress(!!onMoveNode)
  const armed = press.armed
  // Live Ctrl state while a node is held, so the hint can say "copy" before the drop.
  const [ctrl, setCtrl] = useState(false)
  useEffect(() => {
    if (!armed) return
    const key = (e: KeyboardEvent): void => setCtrl(e.ctrlKey || e.metaKey)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      setCtrl(false)
    }
  }, [armed])
  const copying = allowCopy && (press.ctrlAtPress || ctrl)
  const [drag, setDrag] = useState<{ id: string; position: XYPosition } | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)

  const layout = useMemo(
    () => layoutMindMap(root, expanded, selectedId),
    [root, expanded, selectedId]
  )

  const edges = useMemo((): Edge[] => {
    if (!relations?.length) return layout.edges
    const shown = new Map(layout.nodes.map((n) => [n.id, n.data]))
    return [
      ...layout.edges,
      ...relations.flatMap((r): RelationFlowEdge[] => {
        const from = shown.get(r.source)
        const to = shown.get(r.target)
        if (!from || !to || r.source === r.target) return []
        return [
          {
            id: `rel:${r.id}`,
            source: r.source,
            target: r.target,
            sourceHandle: HANDLE.center,
            targetHandle: HANDLE.center,
            type: 'relation',
            zIndex: 5,
            data: {
              label: r.label,
              pending: !!r.pending,
              sourceSize: [from.width, from.height],
              targetSize: [to.width, to.height]
            }
          }
        ]
      })
    ]
  }, [layout, relations])

  // Only a long-pressed node follows the pointer; other drags are ignored.
  const activeDrag = armed && drag?.id === armed ? drag : null
  const activeDropId = activeDrag ? dropId : null

  // Static per-layout node objects. Fixed width/height mean React Flow never has to re-measure
  // (and briefly hide) a node when it receives a new object during a drag.
  const baseNodes = useMemo(
    () =>
      layout.nodes.map((n) => ({
        ...n,
        width: n.data.width,
        height: n.data.height,
        draggable: !!onMoveNode && n.data.depth > 0 && (canMove?.(n.data.mind) ?? true),
        data: {
          ...n.data,
          marked: markQuestions && n.data.depth > 0 && !!n.data.mind.hasQuestions
        }
      })),
    [layout.nodes, onMoveNode, canMove, markQuestions]
  )

  // During a drag only the dragged node and the drop target get new objects; the rest keep
  // their identity so they don't re-render on every pointer move.
  const nodes = useMemo(
    () =>
      baseNodes.map((n) => {
        const dragging = armed === n.id
        const dropTarget = n.id === activeDropId
        if (!dragging && !dropTarget) return n
        return {
          ...n,
          position: activeDrag?.id === n.id ? activeDrag.position : n.position,
          zIndex: dragging ? 2000 : n.zIndex,
          data: { ...n.data, dragging, dropTarget }
        }
      }),
    [baseNodes, armed, activeDrag, activeDropId]
  )

  const focusKey = focusIds?.join('\n') ?? ''
  const boxRef = useRef<HTMLDivElement | null>(null)
  /**
   * Frames the visible focus nodes, or the whole graph when there are none.
   * The focus frame is computed from the layout and the live container size and applied directly:
   * a queued fitView waits for React Flow to re-measure nodes and can land late or not at all.
   */
  const fitTarget = useCallback(
    (duration: number) => {
      const focus = new Set(focusKey ? focusKey.split('\n') : [])
      const shown = layout.nodes.filter((n) => focus.has(n.id))
      const flow = boxRef.current?.closest('.react-flow')
      if (!shown.length || !flow?.clientWidth || !flow.clientHeight) {
        void fitView({ padding: 0.15, duration, maxZoom: 1.2 })
        return
      }
      const x = Math.min(...shown.map((n) => n.position.x))
      const y = Math.min(...shown.map((n) => n.position.y))
      const right = Math.max(...shown.map((n) => n.position.x + n.data.width))
      const bottom = Math.max(...shown.map((n) => n.position.y + n.data.height))
      const viewport = getViewportForBounds(
        { x, y, width: right - x, height: bottom - y },
        flow.clientWidth,
        flow.clientHeight,
        0.1,
        1.2,
        0.25
      )
      void setViewport(viewport, { duration })
    },
    [fitView, setViewport, focusKey, layout.nodes]
  )
  const fitTargetRef = useRef(fitTarget)
  fitTargetRef.current = fitTarget

  const fittedExpansion = useRef<Set<string> | null>(null)
  // Fit only on first render and when the expansion state changes — not on live data updates.
  useEffect(() => {
    if (!nodesInitialized || fittedExpansion.current === expanded) return
    // Expanding under a held node must not move the viewport out from under the pointer.
    if (armed) {
      fittedExpansion.current = expanded
      return
    }
    const timer = setTimeout(() => {
      fittedExpansion.current = expanded
      fitTargetRef.current(400)
    }, 50)
    return () => clearTimeout(timer)
  }, [expanded, nodesInitialized, armed])

  // A new focus set reframes after the container settles (the host may shrink or scroll it);
  // the second pass catches a resize that landed after the first. The focus frame uses layout
  // sizes, so it needs no node measurement to have finished.
  useEffect(() => {
    if (!focusKey) return
    const first = setTimeout(() => fitTargetRef.current(300), 150)
    const settled = setTimeout(() => fitTargetRef.current(300), 600)
    return () => {
      clearTimeout(first)
      clearTimeout(settled)
    }
  }, [focusKey])

  const onNodeClick: NodeMouseHandler<MindFlowNode> = useCallback(
    (_event, node) => {
      const mind = node.data.mind
      if (mind.kind !== 'question' && mind.children.length > 0) {
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

  /** Nearest valid node whose pill holds the dragged pill's centre. */
  const findDropTarget = useCallback(
    (dragged: MindFlowNode, position: XYPosition): MindFlowNode | null => {
      const c = centerOf(dragged, position)
      let best: MindFlowNode | null = null
      let bestDist = Infinity
      for (const n of layout.nodes) {
        if (n.id === dragged.id || n.data.mind.kind === 'question') continue
        if (canDrop && !canDrop(dragged.data.mind, n.data.mind)) continue
        const t = centerOf(n)
        // Inside the target pill (plus a margin), measured on each axis.
        const inside =
          Math.abs(c.x - t.x) < n.data.width / 2 + 14 && Math.abs(c.y - t.y) < n.data.height / 2 + 14
        const dist = Math.hypot(c.x - t.x, c.y - t.y)
        if (inside && dist < bestDist) {
          best = n
          bestDist = dist
        }
      }
      return best
    },
    [layout.nodes, canDrop]
  )

  const onNodeDrag: OnNodeDrag<MindFlowNode> = useCallback(
    (_event, node) => {
      if (node.id === armed) setDropId(findDropTarget(node, node.position)?.id ?? null)
    },
    [findDropTarget, armed]
  )

  const onNodeDragStop: OnNodeDrag<MindFlowNode> = useCallback(
    (event, node) => {
      const target = node.id === armed ? findDropTarget(node, node.position) : null
      setDrag(null)
      setDropId(null)
      press.disarm()
      const copy = allowCopy && (press.ctrlAtPress || event.ctrlKey || event.metaKey)
      if (target && onMoveNode) onMoveNode(node.data.mind, target.data.mind, copy)
    },
    [findDropTarget, onMoveNode, armed, press, allowCopy]
  )

  // Hovering a held node over a collapsed group for a moment opens it.
  useEffect(() => {
    if (!activeDropId) return
    const target = layout.nodes.find((n) => n.id === activeDropId)?.data.mind
    if (!target || target.children.length === 0 || expanded.has(target.id)) return
    const timer = setTimeout(() => setExpanded((s) => new Set(s).add(target.id)), HOVER_EXPAND_MS)
    return () => clearTimeout(timer)
  }, [activeDropId, layout.nodes, expanded])

  // When the box resizes (e.g. the question panel opens beside it), refit into the new area.
  // With a focus set, height changes count too, so the focus stays framed in the visible area.
  const focusedRef = useRef(false)
  focusedRef.current = !!focusKey
  useEffect(() => {
    const box = boxRef.current?.closest('.mind-map-box')
    if (!box) return
    let timer = 0
    let lastWidth = box.clientWidth
    let lastHeight = box.clientHeight
    const observer = new ResizeObserver(() => {
      const widthMoved = Math.abs(box.clientWidth - lastWidth) >= 8
      const heightMoved = focusedRef.current && Math.abs(box.clientHeight - lastHeight) >= 2
      if (!widthMoved && !heightMoved) return
      lastWidth = box.clientWidth
      lastHeight = box.clientHeight
      clearTimeout(timer)
      // Long enough for React Flow's own observer to store the new size first.
      timer = window.setTimeout(() => fitTargetRef.current(300), 120)
    })
    observer.observe(box)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [])

  const [dockOpen, setDockOpen] = useState(false)
  const [full, setFull] = useState(false)
  const toggleFull = (): void => {
    const box = document.querySelector('.mind-map-box.instance-' + root.id.replace(/[^\w-]/g, ''))
    if (!full) {
      setFull(true)
      void (box as HTMLElement | null)?.requestFullscreen?.().catch(() => {})
    } else {
      setFull(false)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }
  useEffect(() => {
    const sync = (): void => {
      if (!document.fullscreenElement) setFull(false)
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  useEffect(() => {
    if (!full) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [full])
  useEffect(() => {
    document.querySelector('.mind-map-box.instance-' + root.id.replace(/[^\w-]/g, ''))?.classList.toggle('full', full)
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 300, maxZoom: 1.2 }), 120)
    return () => clearTimeout(timer)
  }, [full, fitView, root.id])

  return (
    <ReactFlow
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
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
      nodesDraggable={!!onMoveNode}
      onPointerDownCapture={press.onPointerDown}
      zoomActivationKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--graph-dots)" />
      <div
        ref={boxRef}
        className={`graph-dock${dockOpen ? ' open' : ''}`}
        onMouseEnter={() => setDockOpen(true)}
        onMouseLeave={() => setDockOpen(false)}
      >
        <button
          className="graph-dock-toggle"
          aria-label={t('그래프 도구')}
          aria-expanded={dockOpen}
          onClick={() => setDockOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="6" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="18" r="1.6" />
          </svg>
        </button>
        <div className="graph-dock-items">
          {actions}
          <button onClick={() => void zoomIn({ duration: 200 })}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4 4M8.5 11h5M11 8.5v5" />
            </svg>
            {t('확대')}
          </button>
          <button onClick={() => void zoomOut({ duration: 200 })}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4 4M8.5 11h5" />
            </svg>
            {t('축소')}
          </button>
          <button onClick={() => void fitView({ padding: 0.15, duration: 300, maxZoom: 1.2 })}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle cx="6" cy="12" r="2.2" />
              <circle cx="18" cy="6.5" r="2.2" />
              <circle cx="18" cy="17.5" r="2.2" />
              <path d="M8 11l8-3.5M8 13l8 3.5" />
            </svg>
            {t('전체 보기')}
          </button>
          <button onClick={toggleFull}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <rect x="3.5" y="5" width="17" height="12" rx="1.8" />
              <path d="M9 20.5h6" />
              {full ? <path d="M14 8l-4 4M10 9v3h3" /> : <path d="M10 13l4-4M11 8.5h3.5V12" />}
            </svg>
            {full ? t('전체 화면 끝내기') : t('전체 화면')}
          </button>
        </div>
      </div>
      {armed && (
        <div className={`graph-hint${copying ? ' copy' : ''}`}>
          {copying
            ? t('복제: 놓을 개념 위로 끌어 오세요')
            : allowCopy
              ? t('놓을 개념 위로 끌어 오세요 · Ctrl을 누른 채 놓으면 복제')
              : t('놓을 개념 위로 끌어 오세요')}
        </div>
      )}
    </ReactFlow>
  )
}

export default function MindMap(props: MindMapProps): React.JSX.Element {
  return (
    <div
      style={{
        height: props.height ?? '100%',
        width: '100%',
        background: 'var(--graph-board)',
        border: '1px solid var(--hairline)'
      }}
      className={`mind-map-box instance-${props.root.id.replace(/[^\w-]/g, '')} overflow-hidden rounded-[10px]`}
    >
      <ReactFlowProvider>
        {/* Remount (reset expansion) when the root identity changes, e.g. switching tabs/modes. */}
        <MindMapInner key={props.root.id} {...props} />
      </ReactFlowProvider>
    </div>
  )
}

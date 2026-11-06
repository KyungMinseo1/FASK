import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy'
import type { Edge, Node } from '@xyflow/react'
import type { MindNode } from '../../lib/trees'

/** Pill heights (root, others) and font sizes (root, concepts, questions) of the G1 graph. */
const ROOT_HEIGHT = 46
const NODE_HEIGHT = 34
const FONT = { root: 16, node: 14, question: 13 }
/** Horizontal padding inside a pill, and the count circle (20px + gap) on its right. */
const PAD_X = 16
const COUNT_W = 28
/** Expandable pills carry a 12px chevron (plus gap) before the count. */
const CHEVRON_W = 18
const MIN_W = 64
const MAX_W = 240
/** Minimum empty space between neighbouring pills on a ring, and between rings. */
const ARC_GAP = 18
const RING_GAP = 40

export interface MindNodeData extends Record<string, unknown> {
  mind: MindNode
  depth: number
  width: number
  height: number
  fontSize: number
  expanded: boolean
  selected: boolean
  /** Shift-drag state: this node is being dragged / is the current drop target. */
  dragging?: boolean
  dropTarget?: boolean
  /** Show the "holds questions" marker on this node. */
  marked?: boolean
}

export type MindFlowNode = Node<MindNodeData, 'mind'>

interface VisibleNode {
  mind: MindNode
  children: VisibleNode[]
}

type PointNode = HierarchyPointNode<VisibleNode>

function visible(mind: MindNode, expanded: Set<string>): VisibleNode {
  return {
    mind,
    children: expanded.has(mind.id) ? mind.children.map((c) => visible(c, expanded)) : []
  }
}

/** The catch-all group for questions without a concept (desktop project graph and type trees). */
export const isUnclassified = (mind: MindNode): boolean => mind.id === 'unfiled' || mind.id === 'group-unclassified'

/** Estimated rendered width of a label: Hangul/CJK glyphs are about 1em, Latin about 0.58em. */
function textWidth(label: string, fontSize: number): number {
  let em = 0
  for (const ch of label) em += /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : ch === ' ' ? 0.3 : 0.58
  return em * fontSize
}

function sizeOf(mind: MindNode, depth: number): { width: number; height: number; fontSize: number } {
  const fontSize = depth === 0 ? FONT.root : mind.kind === 'question' ? FONT.question : FONT.node
  const count = depth > 0 && mind.count != null && mind.count > 0 ? COUNT_W : 0
  const chevron = depth > 0 && mind.children.length > 0 ? CHEVRON_W : 0
  const width = Math.round(textWidth(mind.label, fontSize) + PAD_X * 2 + count + chevron)
  return {
    width: Math.min(MAX_W, Math.max(MIN_W, width)),
    height: depth === 0 ? ROOT_HEIGHT : NODE_HEIGHT,
    fontSize
  }
}

/** Half-extents of a w×h box at `angle` (0 = up): along the ray, and across it. */
function extents(w: number, h: number, angle: number): { radial: number; tangential: number } {
  const s = Math.abs(Math.sin(angle)),
    c = Math.abs(Math.cos(angle))
  return { radial: (w / 2) * s + (h / 2) * c, tangential: (w / 2) * c + (h / 2) * s }
}

/**
 * Radial pill layout: the root sits in the centre and each depth is a ring around it.
 * Angles come from a radial tidy tree; each ring's radius grows until its pills clear the inner
 * ring and their angular neighbours (pill extents projected along and across each ray).
 */
export function layoutMindMap(
  root: MindNode,
  expanded: Set<string>,
  selectedId: string | undefined
): { nodes: MindFlowNode[]; edges: Edge[] } {
  const laidOut = tree<VisibleNode>()
    .size([2 * Math.PI, 1])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.6) / Math.max(1, a.depth))(
    hierarchy(visible(root, expanded))
  )
  const all = laidOut.descendants()
  const size = new Map(all.map((d) => [d, sizeOf(d.data.mind, d.depth)]))

  const byDepth = new Map<number, PointNode[]>()
  for (const d of all) {
    const ring = byDepth.get(d.depth)
    if (ring) ring.push(d)
    else byDepth.set(d.depth, [d])
  }
  const maxDepth = Math.max(...byDepth.keys())
  const radius = [0]
  const rootSize = size.get(laidOut)!
  // Outer reach of the previous ring: the root is a box, rings reach radius + radial extent.
  let prevReach = Math.hypot(rootSize.width, rootSize.height) / 2
  for (let depth = 1; depth <= maxDepth; depth++) {
    const ring = [...byDepth.get(depth)!].sort((a, b) => a.x - b.x)
    const ext = ring.map((d) => {
      const s = size.get(d)!
      return extents(s.width, s.height, d.x)
    })
    let r = prevReach + RING_GAP + Math.max(...ext.map((e) => e.radial))
    for (let i = 0; i < ring.length && ring.length > 1; i++) {
      const j = (i + 1) % ring.length
      const gap = j === 0 ? 2 * Math.PI - ring[i].x + ring[0].x : ring[j].x - ring[i].x
      const chord = 2 * Math.sin(Math.min(gap, Math.PI) / 2)
      if (chord > 0) r = Math.max(r, (ext[i].tangential + ext[j].tangential + ARC_GAP) / chord)
    }
    radius.push(r)
    prevReach = r + Math.max(...ext.map((e) => e.radial))
  }

  const nodes: MindFlowNode[] = []
  const edges: Edge[] = []
  for (const d of all) {
    const mind = d.data.mind
    const { width, height, fontSize } = size.get(d)!
    const r = radius[d.depth]
    // Angle 0 points up; positions are the top-left corner of the pill.
    const cx = r * Math.cos(d.x - Math.PI / 2)
    const cy = r * Math.sin(d.x - Math.PI / 2)
    nodes.push({
      id: mind.id,
      type: 'mind',
      position: { x: cx - width / 2, y: cy - height / 2 },
      zIndex: d.depth === 0 ? 10 : 1,
      data: {
        mind,
        depth: d.depth,
        width,
        height,
        fontSize,
        expanded: expanded.has(mind.id),
        selected: mind.id === selectedId
      },
      draggable: false,
      connectable: false
    })
    if (d.parent) {
      edges.push({
        id: `${d.parent.data.mind.id}->${mind.id}`,
        source: d.parent.data.mind.id,
        target: mind.id,
        type: 'curve',
        style: {
          stroke: 'var(--graph-edge)',
          strokeWidth: 1.6,
          strokeDasharray: isUnclassified(mind) ? '4 4' : undefined
        }
      })
    }
  }
  return { nodes, edges }
}

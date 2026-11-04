import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy'
import type { Edge, Node } from '@xyflow/react'
import type { QuestionType } from '../../api/types'
import { QUESTION_TYPE_COLOR } from '../../lib/questionTypes'
import type { MindNode } from '../../lib/trees'

/** Circle diameters by depth (root, 1st ring, 2nd ring, deeper); question leaves are smallest. */
const DIAMETERS = [108, 80, 64, 56]
const QUESTION_DIAMETER = 48
/** Minimum empty space between neighbouring circles on a ring, and between rings. */
const ARC_GAP = 16
const RING_GAP = 44

export const ROOT_COLOR = '#6558cc'
const GROUP_COLOR = '#8892aa'
/** Cool branch colors coordinated with the personal workspace theme. */
const BRANCH_COLORS = [
  '#7586ce',
  '#8a73c2',
  '#589eb4',
  '#798cc1',
  '#679b9a',
  '#9d82b5',
  '#8078bb',
  '#7a859f'
]

export interface MindNodeData extends Record<string, unknown> {
  mind: MindNode
  depth: number
  diameter: number
  color: string
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

function diameterOf(mind: MindNode, depth: number): number {
  if (mind.kind === 'question' && depth > 0) return QUESTION_DIAMETER
  return DIAMETERS[Math.min(depth, DIAMETERS.length - 1)]
}

/** Color of a first-ring node; every descendant inherits its branch's color. */
function branchColor(mind: MindNode, index: number): string {
  if (mind.kind === 'type') {
    return QUESTION_TYPE_COLOR[mind.id.slice('type-'.length) as QuestionType]
  }
  if (mind.kind === 'group') return GROUP_COLOR
  return BRANCH_COLORS[index % BRANCH_COLORS.length]
}

/**
 * Radial bubble layout: the root sits in the centre and each depth is a ring around it.
 * Angles come from a radial tidy tree; each ring's radius grows until its circles no longer overlap.
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

  // Ring radius per depth: clear the previous ring, and leave ARC_GAP between angular neighbours.
  const byDepth = new Map<number, PointNode[]>()
  for (const d of all) {
    const ring = byDepth.get(d.depth)
    if (ring) ring.push(d)
    else byDepth.set(d.depth, [d])
  }
  const maxDepth = Math.max(...byDepth.keys())
  const radius = [0]
  let prevDiameter = diameterOf(root, 0)
  for (let depth = 1; depth <= maxDepth; depth++) {
    const ring = byDepth.get(depth)!
    const diameter = Math.max(...ring.map((d) => diameterOf(d.data.mind, depth)))
    let r = radius[depth - 1] + (prevDiameter + diameter) / 2 + RING_GAP
    if (ring.length > 1) {
      const angles = ring.map((d) => d.x).sort((a, b) => a - b)
      let minGap = 2 * Math.PI - angles[angles.length - 1] + angles[0]
      for (let i = 1; i < angles.length; i++) minGap = Math.min(minGap, angles[i] - angles[i - 1])
      const chord = 2 * Math.sin(Math.min(minGap, Math.PI) / 2)
      r = Math.max(r, (diameter + ARC_GAP) / chord)
    }
    radius.push(r)
    prevDiameter = diameter
  }

  const branch = new Map<PointNode, string>()
  laidOut.children?.forEach((c, i) => branch.set(c, branchColor(c.data.mind, i)))
  const colorOf = (d: PointNode): string => {
    if (d.depth === 0) return ROOT_COLOR
    let cur = d
    while (cur.depth > 1) cur = cur.parent!
    return branch.get(cur)!
  }

  const nodes: MindFlowNode[] = []
  const edges: Edge[] = []
  for (const d of all) {
    const mind = d.data.mind
    const diameter = diameterOf(mind, d.depth)
    const color = colorOf(d)
    const r = radius[d.depth]
    // Angle 0 points up; positions are the top-left corner of the circle.
    const cx = r * Math.cos(d.x - Math.PI / 2)
    const cy = r * Math.sin(d.x - Math.PI / 2)
    nodes.push({
      id: mind.id,
      type: 'mind',
      position: { x: cx - diameter / 2, y: cy - diameter / 2 },
      zIndex: d.depth === 0 ? 10 : 0,
      data: {
        mind,
        depth: d.depth,
        diameter,
        color,
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
        type: 'straight',
        style: { stroke: color, strokeOpacity: 0.55, strokeWidth: d.depth === 1 ? 2 : 1.5 }
      })
    }
  }
  return { nodes, edges }
}

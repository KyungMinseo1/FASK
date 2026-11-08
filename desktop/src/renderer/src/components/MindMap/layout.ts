import { hierarchy, tree } from 'd3-hierarchy'
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
export const MIN_W = 64
export const MAX_W = 240
/** Empty space between a column's widest pill and the next column. */
export const H_GAP = 48
/** Empty space between vertically neighbouring pills; pills of different parents get BRANCH_GAP more. */
const V_GAP = 14
const BRANCH_GAP = 10
/** A badge hangs below its pill (8px margin + 16px line). */
const BADGE_H = 24

/**
 * Handle ids on every pill. Tree edges leave the parent's side facing the child and enter the
 * child's near side.
 */
export const HANDLE = { left: 'left', right: 'right' } as const

/** A short tag on an emphasized node: Korean source label (shown through `t()`) and an optional arrow. */
export interface NodeTag {
  label: string
  /** `out`: this node → the focus node (`label →`); `in`: the focus node → this node (`← label`). */
  arrow?: 'out' | 'in'
}

/** Emphasis over the graph (e.g. a selected concept and the concepts related to it). */
export interface GraphHighlight {
  /** The emphasized node. */
  focus: string
  /** Other emphasized node ids and their tags; every node not listed (nor `focus`) is dimmed. */
  related: Record<string, NodeTag[]>
}

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
  /** Outside the current highlight: drawn faded. */
  dimmed?: boolean
  /** Tags from the current highlight. */
  tags?: NodeTag[]
}

export type MindFlowNode = Node<MindNodeData, 'mind'>

interface VisibleNode {
  mind: MindNode
  width: number
  height: number
  fontSize: number
  children: VisibleNode[]
}

/** The catch-all group for questions without a concept (desktop project graph and type trees). */
export const isUnclassified = (mind: MindNode): boolean => mind.id === 'unfiled' || mind.id === 'group-unclassified'

/** Estimated rendered width of a label: Hangul/CJK glyphs are about 1em, Latin about 0.58em. */
export function textWidth(label: string, fontSize: number): number {
  let em = 0
  for (const ch of label) em += /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : ch === ' ' ? 0.3 : 0.58
  return em * fontSize
}

function visible(mind: MindNode, expanded: Set<string>, depth: number): VisibleNode {
  const fontSize = depth === 0 ? FONT.root : mind.kind === 'question' ? FONT.question : FONT.node
  const count = depth > 0 && mind.count != null && mind.count > 0 ? COUNT_W : 0
  const chevron = depth > 0 && mind.children.length > 0 ? CHEVRON_W : 0
  const width = Math.round(textWidth(mind.label, fontSize) + PAD_X * 2 + count + chevron)
  return {
    mind,
    width: Math.min(MAX_W, Math.max(MIN_W, width)),
    height: depth === 0 ? ROOT_HEIGHT : NODE_HEIGHT,
    fontSize,
    children: expanded.has(mind.id) ? mind.children.map((c) => visible(c, expanded, depth + 1)) : []
  }
}

function subtreeSize(mind: MindNode): number {
  return mind.children.reduce((n, c) => n + subtreeSize(c), 1)
}

/**
 * How many of the root's children go to the right side (the rest go left). Balances full subtree
 * sizes, not visible ones, so expanding or collapsing never moves a branch to the other side.
 */
function rightCount(children: VisibleNode[]): number {
  const weights = children.map((c) => subtreeSize(c.mind))
  const total = weights.reduce((a, b) => a + b, 0)
  let best = 0
  let bestDiff = Infinity
  let right = 0
  for (let k = 0; k <= children.length; k++) {
    if (k > 0) right += weights[k - 1]
    const diff = Math.abs(2 * right - total)
    // Ties go to the right, so a single child sits right of the root.
    if (diff <= bestDiff) {
      best = k
      bestDiff = diff
    }
  }
  return best
}

/** Vertical tidy tree with per-pill heights: centre distance between same-depth neighbours. */
const tidy = tree<VisibleNode>()
  .nodeSize([1, 1])
  .separation(
    (a, b) =>
      (a.data.height + b.data.height) / 2 +
      (a.data.mind.badge || b.data.mind.badge ? BADGE_H : 0) +
      V_GAP +
      (a.parent === b.parent ? 0 : BRANCH_GAP)
  )

/**
 * Two-sided mind-map layout: the root sits in the middle; its children split into a right and a
 * left side, each laid out as a horizontal tidy tree. Every depth is a column whose x follows
 * from the widest pill of the previous column, so pills of different depths never share x-space
 * and same-depth pills are kept apart by the tidy tree. Left-side pills right-align toward
 * their parent.
 */
export function layoutMindMap(
  root: MindNode,
  expanded: Set<string>,
  selectedId: string | undefined
): { nodes: MindFlowNode[]; edges: Edge[] } {
  const top = visible(root, expanded, 0)
  const nodes: MindFlowNode[] = []
  const edges: Edge[] = []

  const place = (v: VisibleNode, depth: number, x: number, cy: number): void => {
    const { mind, width, height, fontSize } = v
    nodes.push({
      id: mind.id,
      type: 'mind',
      position: { x, y: cy - height / 2 },
      zIndex: depth === 0 ? 10 : 1,
      data: {
        mind,
        depth,
        width,
        height,
        fontSize,
        expanded: expanded.has(mind.id),
        selected: mind.id === selectedId
      },
      draggable: false,
      connectable: false
    })
  }
  place(top, 0, -top.width / 2, 0)

  const split = rightCount(top.children)
  const sides: [1 | -1, VisibleNode[]][] = [
    [1, top.children.slice(0, split)],
    [-1, top.children.slice(split)]
  ]
  for (const [side, children] of sides) {
    if (!children.length) continue
    const laidOut = tidy(hierarchy<VisibleNode>({ ...top, children }))
    const all = laidOut.descendants()
    const widest: number[] = []
    for (const d of all) widest[d.depth] = Math.max(widest[d.depth] ?? 0, d.data.width)
    // Distance from the root's centre to the near edge of each depth's column.
    const column = [0, top.width / 2 + H_GAP]
    for (let depth = 2; depth < widest.length; depth++) column[depth] = column[depth - 1] + widest[depth - 1] + H_GAP
    for (const d of all) {
      if (!d.parent) continue
      const near = column[d.depth]
      place(d.data, d.depth, side > 0 ? near : -near - d.data.width, d.x)
      const mind = d.data.mind
      edges.push({
        id: `${d.parent.data.mind.id}->${mind.id}`,
        source: d.parent.data.mind.id,
        target: mind.id,
        sourceHandle: side > 0 ? HANDLE.right : HANDLE.left,
        targetHandle: side > 0 ? HANDLE.left : HANDLE.right,
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

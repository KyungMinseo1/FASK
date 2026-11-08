import type { Relation, RelationType } from '../../../preload/personal'
import { textWidth } from '../components/MindMap/layout'
import { RELATION_LABELS } from './questionTree'

/** Where a related concept sits around the centre, by its relation type. */
const SLOT: Record<RelationType, 'left' | 'right' | 'below'> = {
  prerequisite: 'left',
  part: 'right',
  uses: 'right',
  contrast: 'below',
  example: 'below'
}
const TYPES = Object.keys(RELATION_LABELS) as RelationType[]

/** Narrowest layout; a narrower container scales it down. */
export const EGO_MIN_WIDTH = 320
export const EGO_FONT = 12.5
export const CHIP_FONT = 11
/** Line height and padding of a label chip (one line per relation type). */
export const CHIP_LINE = 14
const CHIP_PAD_X = 6
const CHIP_PAD_Y = 2
const NODE_H = 28
const PAD_X = 11
const MARGIN = 6
/** Gap between stacked side pills and between pills of a row below. */
const GAP = 10
const ARROW = 8
/** Clear space between a label chip and the arrowheads at both ends of its gap. */
const CHIP_CLEAR = 4
/** Pills never get narrower than this to make room for the centre. */
const MIN_SIDE = 56

/** Centre and size. */
export interface EgoBox {
  x: number
  y: number
  width: number
  height: number
}

export interface EgoNode extends EgoBox {
  id: string
  /** Label truncated to the pill; `name` is the full concept name. */
  label: string
  name: string
}

/** The relation types of an edge, stacked one per line. */
export interface EgoChip extends EgoBox {
  lines: string[]
}

export interface EgoEdge {
  id: string
  /** Border points on the centre pill and on the related pill. */
  start: [number, number]
  end: [number, number]
  /** Drawn segment: shortened where an arrowhead sits so the stroke stops at its base. */
  line: [number, number, number, number]
  /** Arrowhead polygons (SVG `points`), tips exactly on the pill borders. */
  arrows: string[]
  chip: EgoChip
}

export interface EgoLayout {
  width: number
  height: number
  center: EgoNode
  nodes: EgoNode[]
  edges: EgoEdge[]
}

/** `label` cut with an ellipsis so the pill fits `max`; returns the label and pill width. */
function fit(label: string, max: number): [string, number] {
  const width = (s: string): number => Math.ceil(textWidth(s, EGO_FONT)) + PAD_X * 2
  if (width(label) <= max) return [label, width(label)]
  const chars = [...label]
  while (chars.length > 1 && width(chars.join('') + '…') > max) chars.pop()
  return [chars.join('') + '…', Math.min(max, width(chars.join('') + '…'))]
}

/** Distance from a pill's centre to its (stadium-shaped) border along the unit vector (ux, uy). */
export function pillBorder(width: number, height: number, ux: number, uy: number): number {
  const r = height / 2
  const a = Math.max(0, width / 2 - r)
  const ax = Math.abs(ux),
    ay = Math.abs(uy)
  if (ay > 0 && (r / ay) * ax <= a) return r / ay
  return a * ax + Math.sqrt(Math.max(0, r * r - a * a * ay * ay))
}

function arrowAt(tipX: number, tipY: number, ux: number, uy: number): string {
  const bx = tipX - ux * ARROW,
    by = tipY - uy * ARROW
  return [
    [tipX, tipY],
    [bx - uy * ARROW * 0.5, by + ux * ARROW * 0.5],
    [bx + uy * ARROW * 0.5, by - ux * ARROW * 0.5]
  ]
    .map(([x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`)
    .join(' ')
}

/**
 * Pushes chips apart along one axis (sorted by it) so neighbours keep a 2px gap, then shifts the
 * group back by its mean displacement so it stays centred on the edges.
 */
function spread(chips: EgoChip[], axis: 'x' | 'y'): void {
  const size = axis === 'x' ? 'width' : 'height'
  const sorted = [...chips].sort((a, b) => a[axis] - b[axis])
  const before = sorted.map((c) => c[axis])
  for (let i = 1; i < sorted.length; i++) {
    const min = sorted[i - 1][axis] + (sorted[i - 1][size] + sorted[i][size]) / 2 + 2
    if (sorted[i][axis] < min) sorted[i][axis] = min
  }
  const shift = sorted.reduce((sum, c, i) => sum + c[axis] - before[i], 0) / (sorted.length || 1)
  for (const c of sorted) c[axis] -= shift
}

/**
 * Ego graph of a concept, laid out for `width` (at least EGO_MIN_WIDTH): the concept centred, each
 * related concept once, placed by its first relation type (prerequisite left, part/uses right,
 * contrast/example in rows below). One straight edge per related concept carries a chip listing
 * all its types (`label` translates them); arrowheads follow the stored direction (contrast gets
 * both). The gaps between the centre and the side columns, and above the rows below, are sized to
 * the widest/tallest chip, and chips sit inside those gaps, so they never cover a pill.
 * Pass approved, active relations of `center` only.
 */
export function egoLayout(
  center: { id: string; name: string },
  relations: Pick<Relation, 'id' | 'from' | 'to' | 'type'>[],
  nameOf: (id: string) => string | undefined,
  label: (type: RelationType) => string,
  width = EGO_MIN_WIDTH
): EgoLayout {
  const W = Math.max(EGO_MIN_WIDTH, Math.round(width))
  const groups = new Map<string, { name: string; types: Set<RelationType>; toCenter: boolean; fromCenter: boolean }>()
  for (const r of relations) {
    if (r.from === r.to || (r.from !== center.id && r.to !== center.id)) continue
    const other = r.from === center.id ? r.to : r.from
    const name = nameOf(other)
    if (name === undefined) continue
    const g = groups.get(other) ?? { name, types: new Set(), toCenter: false, fromCenter: false }
    g.types.add(r.type)
    if (r.type === 'contrast' || r.from === center.id) g.fromCenter = true
    if (r.type === 'contrast' || r.to === center.id) g.toCenter = true
    groups.set(other, g)
  }
  const related = [...groups].map(([id, g]) => {
    const types = TYPES.filter((type) => g.types.has(type))
    const lines = types.map(label)
    const chip: EgoChip = {
      x: 0,
      y: 0,
      width: Math.ceil(Math.max(...lines.map((l) => textWidth(l, CHIP_FONT)))) + CHIP_PAD_X * 2,
      height: lines.length * CHIP_LINE + CHIP_PAD_Y * 2,
      lines
    }
    return { id, ...g, chip, rank: TYPES.indexOf(types[0]), slot: SLOT[types[0]] }
  })
  related.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  const left = related.filter((r) => r.slot === 'left'),
    right = related.filter((r) => r.slot === 'right'),
    below = related.filter((r) => r.slot === 'below')

  // Horizontal gap on each side: the widest chip plus room for both arrowheads.
  const gapOf = (side: typeof related): number =>
    side.length ? Math.max(...side.map((r) => r.chip.width)) + 2 * (ARROW + CHIP_CLEAR) : 0
  const gapL = gapOf(left),
    gapR = gapOf(right)
  const centerMax = Math.max(72, Math.min(200, W * 0.3, W - 2 * (Math.max(gapL, gapR) + MARGIN + MIN_SIDE)))
  const [centerLabel, centerWidth] = fit(center.name, centerMax)
  const centre: EgoNode = {
    id: center.id,
    label: centerLabel,
    name: center.name,
    x: W / 2,
    y: 0,
    width: centerWidth,
    height: NODE_H
  }
  const edgeL = W / 2 - centerWidth / 2 - gapL,
    edgeR = W / 2 + centerWidth / 2 + gapR

  const nodes: EgoNode[] = []
  /** Stacks a side column around the centre's height; pitches leave room for the chips between. */
  const column = (side: typeof related, x: (width: number) => number, max: number): void => {
    const pitches = side.slice(1).map((r, i) => Math.max(NODE_H + GAP, side[i].chip.height + r.chip.height + 4))
    const height = pitches.reduce((a, b) => a + b, 0)
    let y = -height / 2
    side.forEach((r, i) => {
      const [text, w] = fit(r.name, max)
      nodes.push({ id: r.id, label: text, name: r.name, x: x(w), y, width: w, height: NODE_H })
      y += pitches[i] ?? 0
    })
  }
  column(left, (w) => edgeL - w / 2, edgeL - MARGIN)
  column(right, (w) => edgeR + w / 2, W - MARGIN - edgeR)
  const nodeOf = (id: string): EgoNode => nodes.find((n) => n.id === id) as EgoNode

  /** Border points of the edge between the centre and `n`. */
  const segment = (n: EgoNode): { start: [number, number]; end: [number, number] } => {
    const dx = n.x - centre.x,
      dy = n.y - centre.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len,
      uy = dy / len
    const s = pillBorder(centre.width, centre.height, ux, uy)
    const e = pillBorder(n.width, n.height, ux, uy)
    return { start: [centre.x + ux * s, centre.y + uy * s], end: [n.x - ux * e, n.y - uy * e] }
  }
  // Side chips sit mid-gap, where their edge crosses it.
  for (const [side, gapX] of [
    [left, (edgeL + W / 2 - centerWidth / 2) / 2],
    [right, (edgeR + W / 2 + centerWidth / 2) / 2]
  ] as const) {
    for (const r of side) {
      const { start, end } = segment(nodeOf(r.id))
      r.chip.x = gapX
      r.chip.y = start[1] + ((end[1] - start[1]) * (gapX - start[0])) / (end[0] - start[0] || 1)
    }
    spread(
      side.map((r) => r.chip),
      'y'
    )
  }

  // Rows below every side pill and chip; their chips sit in the band just above the first row.
  const sideBottom = Math.max(
    centre.height / 2,
    ...nodes.map((n) => n.y + n.height / 2),
    ...[...left, ...right].map((r) => r.chip.y + r.chip.height / 2)
  )
  const band = below.length ? Math.max(...below.map((r) => r.chip.height)) + 2 * (ARROW + CHIP_CLEAR) : 0
  const belowMax = Math.min(160, (W - MARGIN * 2 - GAP) / 2)
  let top = sideBottom + band
  for (let i = 0; i < below.length; ) {
    const row: [(typeof related)[number], string, number][] = []
    let used = 0
    while (i < below.length) {
      const [text, w] = fit(below[i].name, belowMax)
      if (row.length && used + GAP + w > W - MARGIN * 2) break
      used += (row.length ? GAP : 0) + w
      row.push([below[i++], text, w])
    }
    let x = (W - used) / 2
    for (const [r, text, w] of row) {
      nodes.push({ id: r.id, label: text, name: r.name, x: x + w / 2, y: top + NODE_H / 2, width: w, height: NODE_H })
      x += w + GAP
    }
    top += NODE_H + GAP
  }
  const bandY = sideBottom + band / 2
  for (const r of below) {
    const { start, end } = segment(nodeOf(r.id))
    r.chip.y = bandY
    r.chip.x = start[0] + ((end[0] - start[0]) * (bandY - start[1])) / (end[1] - start[1] || 1)
  }
  spread(
    below.map((r) => r.chip),
    'x'
  )

  // Shift everything down so the topmost pill or chip starts at the margin.
  const boxes: EgoBox[] = [centre, ...nodes, ...related.map((r) => r.chip)]
  const dy = MARGIN - Math.min(...boxes.map((b) => b.y - b.height / 2))
  for (const b of boxes) b.y += dy
  const height = Math.max(...boxes.map((b) => b.y + b.height / 2)) + MARGIN

  const edges = related.map((r): EgoEdge => {
    const { start, end } = segment(nodeOf(r.id))
    const len = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1
    const ux = (end[0] - start[0]) / len,
      uy = (end[1] - start[1]) / len
    const arrows: string[] = []
    if (r.fromCenter) arrows.push(arrowAt(end[0], end[1], ux, uy))
    if (r.toCenter) arrows.push(arrowAt(start[0], start[1], -ux, -uy))
    return {
      id: r.id,
      start,
      end,
      line: [
        start[0] + (r.toCenter ? ux * ARROW : 0),
        start[1] + (r.toCenter ? uy * ARROW : 0),
        end[0] - (r.fromCenter ? ux * ARROW : 0),
        end[1] - (r.fromCenter ? uy * ARROW : 0)
      ],
      arrows,
      chip: r.chip
    }
  })
  return { width: W, height, center: centre, nodes, edges }
}

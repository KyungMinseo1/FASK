import test from 'node:test'
import assert from 'node:assert/strict'
import type { MindNode } from '../src/renderer/src/lib/trees'
import { HANDLE, H_GAP, MAX_W, MIN_W, layoutMindMap } from '../src/renderer/src/components/MindMap/layout'

const LABELS = [
  '선형대수학의 고유값과 고유벡터 분해',
  'Eigendecomposition of symmetric matrices',
  '행렬',
  'SVD',
  '확률 변수와 기댓값의 선형성에 대한 아주 긴 개념 이름',
  'Gradient descent with momentum and adaptive learning rates',
  '미분',
  'Fourier'
]

/** A wide tree: `breadth[d]` children at depth d+1, labels cycling through short and very long ones. */
function wideTree(breadth: number[]): MindNode {
  let n = 0
  const build = (id: string, depth: number): MindNode => {
    const label = LABELS[n++ % LABELS.length]
    const children =
      depth < breadth.length ? Array.from({ length: breadth[depth] }, (_, i) => build(`${id}.${i}`, depth + 1)) : []
    return {
      id,
      label: depth === 0 ? '프로젝트: 기계학습 기초 정리' : label,
      kind: depth === 0 ? 'root' : children.length ? 'concept' : 'question',
      count: depth > 0 ? n % 4 : undefined,
      badge: n % 7 === 0 ? '공유' : undefined,
      children
    }
  }
  return build('r', 0)
}

test('mind-map layout: no overlapping pills and short parent→child gaps when expanded at several depths', () => {
  const root = wideTree([7, 5, 4, 3])
  const expanded = new Set(['r'])
  // Expand some branches on both sides, down to depth 3.
  for (const top of ['r.0', 'r.1', 'r.3', 'r.5', 'r.6']) expanded.add(top)
  for (const mid of ['r.0.0', 'r.0.4', 'r.1.2', 'r.5.1', 'r.5.3', 'r.6.0']) expanded.add(mid)
  for (const deep of ['r.0.0.1', 'r.0.4.3', 'r.5.1.0', 'r.6.0.2']) expanded.add(deep)

  const { nodes, edges } = layoutMindMap(root, expanded, undefined)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length)
  assert.ok(nodes.length > 60, `expected a large graph, got ${nodes.length} nodes`)
  assert.equal(edges.length, nodes.length - 1)

  // Pill rects (plus the badge hanging below) never intersect.
  const rects = nodes.map((n) => ({
    id: n.id,
    x0: n.position.x,
    y0: n.position.y,
    x1: n.position.x + n.data.width,
    y1: n.position.y + n.data.height + (n.data.mind.badge ? 24 : 0)
  }))
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i],
        b = rects[j]
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`)
    }
  }

  // Root in the middle, children on both sides.
  const r = byId.get('r')!
  const rootCx = r.position.x + r.data.width / 2
  assert.equal(rootCx, 0)
  const tops = nodes.filter((n) => n.data.depth === 1)
  assert.ok(tops.some((n) => n.position.x > 0) && tops.some((n) => n.position.x < 0))

  // Expanding or collapsing never moves a top-level branch to the other side.
  const sideOf = (ns: typeof nodes): string[] =>
    ns.filter((n) => n.data.depth === 1).map((n) => `${n.id}:${n.position.x > 0 ? 'R' : 'L'}`)
  const expandedSides = sideOf(nodes)
  assert.deepEqual(sideOf(layoutMindMap(root, new Set(['r']), undefined).nodes), expandedSides)
  assert.deepEqual(sideOf(layoutMindMap(root, new Set([...expanded, 'r.2', 'r.4']), undefined).nodes), expandedSides)

  // Each edge leaves the parent's side facing the child, with a short horizontal gap.
  for (const e of edges) {
    const p = byId.get(e.source)!,
      c = byId.get(e.target)!
    const right = c.position.x > p.position.x
    assert.equal(e.sourceHandle, right ? HANDLE.right : HANDLE.left)
    assert.equal(e.targetHandle, right ? HANDLE.left : HANDLE.right)
    const gap = right ? c.position.x - (p.position.x + p.data.width) : p.position.x - (c.position.x + c.data.width)
    assert.ok(gap >= H_GAP, `${e.id}: gap ${gap}`)
    assert.ok(gap <= MAX_W - MIN_W + H_GAP, `${e.id}: gap ${gap} too long`)
  }

  // Left-side pills of a column right-align toward the root.
  const leftTops = tops.filter((n) => n.position.x < 0)
  assert.equal(new Set(leftTops.map((n) => n.position.x + n.data.width)).size, 1)
})

test('mind-map layout: a single child sits right of the root; collapsed root shows only itself', () => {
  const root: MindNode = {
    id: 'r',
    label: 'root',
    kind: 'root',
    children: [{ id: 'a', label: 'a', kind: 'concept', children: [] }]
  }
  const one = layoutMindMap(root, new Set(['r']), 'a')
  const a = one.nodes.find((n) => n.id === 'a')!
  assert.ok(a.position.x > 0)
  assert.equal(a.data.selected, true)
  assert.deepEqual(
    layoutMindMap(root, new Set(), undefined).nodes.map((n) => n.id),
    ['r']
  )
})

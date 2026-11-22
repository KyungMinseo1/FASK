export interface Point {
  x: number
  y: number
}

export interface Stroke {
  points: Point[]
  color: string
}

export const PEN_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#111827'
] as const
export const STROKE_WIDTH = 4
export const ERASER_RADIUS = 12

function drawStroke(ctx: CanvasRenderingContext2D, { points }: Stroke): void {
  if (points.length === 0) return
  const [first] = points
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(first.x, first.y, STROKE_WIDTH / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  // Quadratic curves through midpoints for smooth lines.
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const next = points[i + 1]
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

/** Clears and redraws all strokes. `ctx` is expected to be scaled by devicePixelRatio already. */
export function redraw(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  cssWidth: number,
  cssHeight: number
): void {
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.lineWidth = STROKE_WIDTH
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes) {
    ctx.strokeStyle = ctx.fillStyle = s.color
    drawStroke(ctx, s)
  }
}

/** Removes whole strokes that have any point within ERASER_RADIUS of `p`. */
export function eraseAt(strokes: Stroke[], p: Point): Stroke[] {
  const r2 = ERASER_RADIUS * ERASER_RADIUS
  return strokes.filter((s) => !s.points.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2))
}

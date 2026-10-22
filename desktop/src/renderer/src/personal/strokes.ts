export interface Point {
  x: number
  y: number
}

export interface Stroke {
  points: Point[]
}

export const STROKE_COLOR = '#ef4444'
export const STROKE_WIDTH = 4
export const ERASER_RADIUS = 12
const CAPTURE_MAX_WIDTH = 1600
const CAPTURE_QUALITY = 0.85

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
  ctx.strokeStyle = STROKE_COLOR
  ctx.fillStyle = STROKE_COLOR
  ctx.lineWidth = STROKE_WIDTH
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes) drawStroke(ctx, s)
}

/** Removes whole strokes that have any point within ERASER_RADIUS of `p`. */
export function eraseAt(strokes: Stroke[], p: Point): Stroke[] {
  const r2 = ERASER_RADIUS * ERASER_RADIUS
  return strokes.filter((s) => !s.points.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2))
}

/**
 * Screenshot + stroke canvas → JPEG data URL. The stroke canvas is stretched to the screenshot's size
 * so coordinates line up even if the capture resolution differs from the canvas backing size.
 */
export async function composeCapture(
  screenshot: string,
  strokeCanvas: HTMLCanvasElement
): Promise<string> {
  const img = new Image()
  img.src = screenshot
  await img.decode()
  const full = document.createElement('canvas')
  full.width = img.naturalWidth
  full.height = img.naturalHeight
  const fctx = full.getContext('2d')!
  fctx.drawImage(img, 0, 0)
  fctx.drawImage(strokeCanvas, 0, 0, full.width, full.height)

  let out = full
  if (full.width > CAPTURE_MAX_WIDTH) {
    out = document.createElement('canvas')
    out.width = CAPTURE_MAX_WIDTH
    out.height = Math.round((full.height * CAPTURE_MAX_WIDTH) / full.width)
    const octx = out.getContext('2d')!
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(full, 0, 0, out.width, out.height)
  }
  return out.toDataURL('image/jpeg', CAPTURE_QUALITY)
}

// Shared with the mobile app (imported as @desktop/renderer/src/personal/ProfileAvatar): no desktop-only imports.
import { AVATAR_PALETTES, defaultAvatar, validAvatar, type AvatarSpec } from '../../../shared/avatar'

type Palette = (typeof AVATAR_PALETTES)[keyof typeof AVATAR_PALETTES]

/** Deterministic 0..1 numbers from the seed (FNV-1a hash into mulberry32). */
function random(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One Hangul/CJK syllable, or the first letters of up to two words. */
function initials(name: string): string {
  const trimmed = name.trim()
  const first = [...trimmed][0] ?? '?'
  if (/[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]/.test(first)) return first
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase()
}

const polar = (r: number, a: number): [number, number] => [32 + r * Math.cos(a), 32 + r * Math.sin(a)]

/** Quarter, half or full circle, or a square, inside one 32px tile of the 2×2 Bauhaus grid. */
function tile(x: number, y: number, kind: number, turn: number, fill: string, opacity = 1): React.JSX.Element {
  const shape =
    kind === 0 ? (
      <path d="M0 0H32V32A32 32 0 0 1 0 0Z" />
    ) : kind === 1 ? (
      <path d="M0 32A16 16 0 0 1 32 32Z" />
    ) : kind === 2 ? (
      <circle cx="16" cy="16" r="11" />
    ) : (
      <rect x="6" y="6" width="20" height="20" />
    )
  return (
    <g key={`${x}${y}`} transform={`translate(${x} ${y}) rotate(${turn * 90} 16 16)`} fill={fill} opacity={opacity}>
      {shape}
    </g>
  )
}

function pattern(spec: AvatarSpec, name: string, p: Palette): React.JSX.Element {
  const r = random(spec.seed)
  switch (spec.style) {
    case 'monogram': {
      const text = initials(name)
      return (
        <>
          <text
            x="32"
            y="30"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={text.length > 1 ? 23 : 27}
            fontWeight={700}
            letterSpacing="-0.5"
            fill={p.fg}
          >
            {text}
          </text>
          <rect x="27" y="49" width="10" height="2.5" rx="1.25" fill={p.accent} />
        </>
      )
    }
    case 'bauhaus': {
      const accent = Math.floor(r() * 4)
      return (
        <>
          {[0, 1, 2, 3].map((i) =>
            tile(
              (i % 2) * 32,
              Math.floor(i / 2) * 32,
              Math.floor(r() * 4),
              Math.floor(r() * 4),
              i === accent ? p.accent : p.fg,
              i === accent ? 1 : i % 3 === 0 ? 0.92 : 0.38
            )
          )}
        </>
      )
    }
    case 'eclipse': {
      const a = r() * Math.PI * 2
      const [sx, sy] = polar(5, a)
      const [cx, cy] = polar(9, a + Math.PI)
      const [dx, dy] = polar(22, a + Math.PI * (0.75 + r() * 0.5))
      return (
        <>
          <circle cx={sx} cy={sy} r="18" fill={p.fg} />
          <circle cx={cx} cy={cy} r="16" fill={p.bg} />
          <circle cx={dx} cy={dy} r="4" fill={p.accent} />
        </>
      )
    }
    case 'orbit': {
      const [ax, ay] = polar(17, r() * Math.PI * 2)
      const [bx, by] = polar(25, r() * Math.PI * 2)
      return (
        <g fill="none" stroke={p.fg} strokeWidth="1.5">
          <circle cx="32" cy="32" r="9" opacity="0.55" />
          <circle cx="32" cy="32" r="17" opacity="0.35" />
          <circle cx="32" cy="32" r="25" opacity="0.2" />
          <circle cx="32" cy="32" r="4" fill={p.fg} stroke="none" />
          <circle cx={ax} cy={ay} r="4" fill={p.accent} stroke="none" />
          <circle cx={bx} cy={by} r="2.6" fill={p.fg} stroke="none" />
        </g>
      )
    }
    case 'dots': {
      // A 5×5 grid mirrored left-right; the middle column holds one accent dot.
      const cells: React.JSX.Element[] = []
      const accentRow = 1 + Math.floor(r() * 3)
      for (let row = 0; row < 5; row++)
        for (let col = 0; col < 3; col++) {
          const on = r() < 0.55
          const accent = col === 2 && row === accentRow
          for (const c of col === 2 ? [2] : [col, 4 - col])
            cells.push(
              <circle
                key={`${row}-${c}`}
                cx={12 + c * 10}
                cy={12 + row * 10}
                r={accent || on ? 3.4 : 1.3}
                fill={accent ? p.accent : p.fg}
                opacity={accent || on ? 1 : 0.3}
              />
            )
        }
      return <>{cells}</>
    }
    case 'waves': {
      const accent = Math.floor(r() * 4)
      return (
        <g fill="none" strokeWidth="3.2" strokeLinecap="round">
          {[17, 27, 37, 47].map((y, i) => {
            const amp = 3 + r() * 3
            const shift = -8 + r() * 8
            return (
              <path
                key={y}
                d={`M${shift} ${y}Q${shift + 8} ${y - amp} ${shift + 16} ${y}T${shift + 32} ${y}T${shift + 48} ${y}T${shift + 64} ${y}T${shift + 80} ${y}`}
                stroke={i === accent ? p.accent : p.fg}
                opacity={i === accent ? 1 : 0.85 - i * 0.12}
              />
            )
          })}
        </g>
      )
    }
  }
}

/** A flat profile picture drawn from a spec; an unknown spec (older build) falls back to the default. */
export default function ProfileAvatar({
  avatar,
  name,
  size
}: {
  avatar: AvatarSpec
  name: string
  size: number
}): React.JSX.Element {
  const spec = validAvatar(avatar) ? avatar : defaultAvatar(name || 'fask')
  const palette = AVATAR_PALETTES[spec.background]
  return (
    <svg className="profile-avatar" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" fill={palette.bg} />
      {pattern(spec, name, palette)}
    </svg>
  )
}

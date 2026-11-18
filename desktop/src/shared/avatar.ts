/**
 * Profile avatar spec: a pattern, a seed that varies it, and a palette taken from the app's themes.
 * Drawn by the renderer's ProfileAvatar as flat SVG; shared by main, renderer and mobile.
 */
export const AVATAR_STYLES = ['monogram', 'bauhaus', 'eclipse', 'orbit', 'dots', 'waves'] as const
export type AvatarStyle = (typeof AVATAR_STYLES)[number]

/** One palette per app theme: each theme's sidebar colors, so an avatar reads as that theme. */
export const AVATAR_PALETTES = {
  navy: { bg: '#14213d', fg: '#f4ede0', accent: '#ff6b5b' },
  white: { bg: '#f6f6f5', fg: '#0b0b0c', accent: '#8fb31f' },
  ivory: { bg: '#1f3d2b', fg: '#f3ecdd', accent: '#d9c69e' },
  lavender: { bg: '#cbb3e8', fg: '#2a1a40', accent: '#f6f0fc' },
  night: { bg: '#0b0b0b', fg: '#f2f2ec', accent: '#d4ff3f' }
} as const
export type AvatarColor = keyof typeof AVATAR_PALETTES
export const AVATAR_COLORS = Object.keys(AVATAR_PALETTES) as AvatarColor[]

export interface AvatarSpec {
  style: AvatarStyle
  seed: string
  background: AvatarColor
}

export function defaultAvatar(profileId: string): AvatarSpec {
  return { style: 'monogram', seed: profileId.slice(0, 64) || 'fask', background: 'navy' }
}

export function validAvatar(v: unknown): v is AvatarSpec {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return (
    (AVATAR_STYLES as readonly unknown[]).includes(a.style) &&
    typeof a.seed === 'string' &&
    a.seed.length >= 1 &&
    a.seed.length <= 64 &&
    (AVATAR_COLORS as readonly unknown[]).includes(a.background)
  )
}

export function validCard(v: unknown): v is { name: string; avatar: AvatarSpec } {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  if (typeof c.name !== 'string') return false
  const name = c.name.trim()
  return name.length >= 1 && name.length <= 40 && validAvatar(c.avatar)
}

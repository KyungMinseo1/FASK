/** Profile avatar spec, rendered with DiceBear styles by the renderer; no DiceBear import here. */
export const AVATAR_STYLES = ['shapes', 'glass', 'thumbs', 'rings', 'identicon', 'initials'] as const
export type AvatarStyle = (typeof AVATAR_STYLES)[number]
export const AVATAR_COLORS = [
  '#3b5bdb',
  '#0c8599',
  '#2b8a3e',
  '#e67700',
  '#c2255c',
  '#7048e8',
  '#495057',
  '#d9480f'
] as const
export type AvatarColor = (typeof AVATAR_COLORS)[number]
export interface AvatarSpec {
  style: AvatarStyle
  seed: string
  background: AvatarColor
}

export function defaultAvatar(profileId: string): AvatarSpec {
  let sum = 0
  for (let i = 0; i < profileId.length; i++) sum += profileId.charCodeAt(i)
  return { style: 'shapes', seed: profileId.slice(0, 64) || 'fask', background: AVATAR_COLORS[sum % AVATAR_COLORS.length] }
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

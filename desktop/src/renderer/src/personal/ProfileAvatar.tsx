// Shared with the mobile app (imported as @desktop/renderer/src/personal/ProfileAvatar): no desktop-only imports.
import { useMemo } from 'react'
import { Avatar, Style } from '@dicebear/core'
import shapes from '@dicebear/styles/shapes.json'
import glass from '@dicebear/styles/glass.json'
import thumbs from '@dicebear/styles/thumbs.json'
import rings from '@dicebear/styles/rings.json'
import identicon from '@dicebear/styles/identicon.json'
import initials from '@dicebear/styles/initials.json'
import type { AvatarSpec, AvatarStyle } from '../../../shared/avatar'

const DEFINITIONS: Record<AvatarStyle, unknown> = { shapes, glass, thumbs, rings, identicon, initials }
// Validated once per style and reused across avatars.
const STYLES = new Map<AvatarStyle, Style>()

/** A profile picture drawn by DiceBear from a validated spec; `initials` draws the name instead of the seed. */
export default function ProfileAvatar({
  avatar,
  name,
  size
}: {
  avatar: AvatarSpec
  name: string
  size: number
}): React.JSX.Element {
  const src = useMemo(() => {
    let style = STYLES.get(avatar.style)
    if (!style) {
      style = new Style(DEFINITIONS[avatar.style])
      STYLES.set(avatar.style, style)
    }
    return new Avatar(style, {
      seed: avatar.style === 'initials' ? name : avatar.seed,
      backgroundColor: [avatar.background],
      size: 64
    }).toDataUri()
  }, [avatar.style, avatar.seed, avatar.background, name])
  return <img className="profile-avatar" src={src} width={size} height={size} alt="" />
}

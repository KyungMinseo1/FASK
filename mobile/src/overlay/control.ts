import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { Pairing } from '../transport'

export interface OverlayStatus {
  overlayAllowed: boolean
  running: boolean
  sessionId?: string
  profileId?: string
  projectId?: string
  questionId?: string
}

interface OverlayPlugin {
  status(): Promise<OverlayStatus>
  requestOverlayPermission(): Promise<{ granted: boolean }>
  start(options: {
    pairing: Pairing
    profileId: string
    projectId: string
    questionId?: string
  }): Promise<{ sessionId: string }>
  stop(): Promise<void>
  consumeRevocation(): Promise<{ fingerprint: string } | null>
}

export const isAndroidOverlay = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

const plugin = registerPlugin<
  OverlayPlugin & {
    addListener(e: 'revoked', cb: (x: { fingerprint: string }) => void): Promise<PluginListenerHandle>
  }
>('FaskOverlay')

export const overlayControl: OverlayPlugin = {
  status: () => plugin.status(),
  requestOverlayPermission: () => plugin.requestOverlayPermission(),
  start: (options) => plugin.start(options),
  stop: () => plugin.stop(),
  consumeRevocation: async () => (await plugin.consumeRevocation()) ?? null
}

export function isOverlayCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return error.code === 'CANCELLED' || error.code === 'CANCELED'
}

/** Ends any screen-question session; an already-stopped session is not an error. */
export async function stopOverlay(): Promise<void> {
  if (!isAndroidOverlay()) return
  await plugin.stop().catch(() => {})
}

/** True when the service saw this pairing's token rejected (401) since it was last consumed. */
export async function overlayRevoked(fingerprint: string): Promise<boolean> {
  if (!isAndroidOverlay()) return false
  const mark = await overlayControl.consumeRevocation().catch(() => null)
  return mark?.fingerprint === fingerprint
}

/** Live notice while the Activity exists; the mark is still consumed via overlayRevoked. */
export function onOverlayRevoked(cb: () => void): () => void {
  if (!isAndroidOverlay()) return () => {}
  const handle = plugin.addListener('revoked', () => cb())
  return () => void handle.then((h) => h.remove())
}

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { Pairing } from '../transport'
import { t } from '@desktop/shared/i18n'

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
  }): Promise<{ sessionId: string }>
  stop(): Promise<void>
  consumeRevocation(): Promise<{ fingerprint: string } | null>
}

export const isAndroidOverlay = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

const plugin = registerPlugin<
  OverlayPlugin & {
    addListener(e: 'revoked', cb: (x: { fingerprint: string }) => void): Promise<PluginListenerHandle>
    preview(): Promise<void>
    setTheme(options: { pref: string }): Promise<void>
    setLanguage(options: { lang: 'ko' | 'en' }): Promise<void>
    setAnswerBlink(options: { enabled: boolean }): Promise<void>
  }
>('FaskOverlay')

export const overlayControl: OverlayPlugin = {
  status: () => plugin.status(),
  requestOverlayPermission: () => plugin.requestOverlayPermission(),
  start: (options) => plugin.start(options),
  stop: () => plugin.stop(),
  consumeRevocation: async () => (await plugin.consumeRevocation()) ?? null
}

/** Mirrors the app's theme choice (system/light/dark/sepia/forest/rose) to the native overlay toolbar. */
export function syncOverlayTheme(pref: string): void {
  if (isAndroidOverlay()) void plugin.setTheme({ pref }).catch(() => {})
}

/** Mirrors this phone's answer-completed blink preference to the native toggle. */
export function syncOverlayAnswerBlink(enabled: boolean): void {
  if (isAndroidOverlay()) void plugin.setAnswerBlink({ enabled }).catch(() => {})
}

/** Mirrors the resolved UI language to the native overlay toolbar and panel. */
export function syncOverlayLanguage(lang: 'ko' | 'en'): void {
  if (isAndroidOverlay()) void plugin.setLanguage({ lang }).catch(() => {})
}

/** Native overlay UI check without a PC; only `apk:test` (vite --mode pairing-test) shows it. */
export const overlayPreviewAvailable = (): boolean =>
  import.meta.env.MODE === 'pairing-test' && isAndroidOverlay()

/** Shows the native toggle/toolbar without a hub or screen capture. */
export async function previewOverlay(): Promise<void> {
  const { granted } = await plugin.requestOverlayPermission()
  if (!granted) throw new Error(t('다른 앱 위에 표시 권한을 허용해 주세요.'))
  await plugin.preview()
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

// Panel ↔ service message bridge. The native side owns the token, the pinned TLS and the
// session; the page only correlates replies, applies per-operation timeouts and drops anything
// that belongs to another (older) session.
import type { HubIdentity } from '../transport'
import { t } from '@desktop/shared/i18n'

export type Op =
  | 'bootstrap'
  | 'request'
  | 'openEvents'
  | 'closeEvents'
  | 'selectRegion'
  | 'captureSelectedRegion'
  | 'setInteractionState'
  | 'setQuestion'
  | 'notifyAnswered'
  | 'setProject'
  | 'setProjects'
  | 'clearInk'
  | 'setPanelVisible'
  | 'stop'

export type OverlayState = {
  hasInk: boolean
  captureRevision: number
  /** Native ink revision, used only as clearInk's expectedRevision. */
  inkRevision: number
  region?: { width: number; height: number }
  mode: string
  theme: 'light' | 'dark'
  /** App palette mirrored by the native chrome: light, dark, sepia, forest or rose. */
  palette?: string
  /** Resolved UI language from the app (FaskOverlay.setLanguage); the panel's origin has no shared localStorage. */
  lang?: 'ko' | 'en'
}
export type Bootstrap = OverlayState & {
  identity: HubIdentity
  profileId: string
  projectId: string
  questionId?: string
  sessionId: string
  /** Test-build preview only: no hub; the page serves an in-memory snapshot. */
  preview?: boolean
}
export type Push =
  | { event: 'hubEvent'; payload: { id: string; event: string; data: string } }
  | { event: 'hubClosed'; payload: { id: string; error: string } }
  | { event: 'overlayState'; payload: OverlayState }
  | { event: 'panelShown'; payload: Record<string, never> }
  | { event: 'sessionInvalidated'; payload: Record<string, never> }
  | { event: 'projectPicker'; payload: Record<string, never> }
  | { event: 'selectProject'; payload: { projectId: string } }

export class BridgeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** The native WebMessage listener object injected for the exact panel origin only. */
export interface Port {
  postMessage(message: string): void
  onmessage: ((event: { data: unknown }) => void) | null
}

const CONTROL_MS = 10000
const CAPTURE_MS = 5000
const EVENTS_MS = 65000

export function timeoutFor(op: Op, payload: Record<string, unknown>): number {
  if (op === 'captureSelectedRegion') return CAPTURE_MS
  if (op === 'openEvents') return EVENTS_MS
  if (op === 'request') return Number(payload.timeoutMs) + 5000
  return CONTROL_MS
}

export function createBridge(port: Port) {
  let sessionId = ''
  let disposed = false
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const listeners = new Set<(p: Push) => void>()
  const settle = (id: string): ReturnType<typeof pending.get> => {
    const entry = pending.get(id)
    if (entry) {
      pending.delete(id)
      clearTimeout(entry.timer)
    }
    return entry
  }
  const failAll = (code: string, message: string): void => {
    for (const id of [...pending.keys()]) settle(id)?.reject(new BridgeError(code, message))
  }
  port.onmessage = (event) => {
    if (disposed || typeof event.data !== 'string') return
    let m: Record<string, unknown>
    try {
      m = JSON.parse(event.data)
    } catch {
      return
    }
    if (!m || m.v !== 1) return
    // Before bootstrap only its own reply is accepted; afterwards only the bound session.
    if (sessionId && m.sessionId !== sessionId) return
    if (typeof m.id === 'string') {
      const entry = settle(m.id)
      if (!entry) return
      const error = m.error as { code?: unknown; message?: unknown } | undefined
      if (error)
        entry.reject(new BridgeError(String(error.code ?? 'CLOSED'), String(error.message ?? '')))
      else entry.resolve(m.result)
      return
    }
    if (!sessionId || typeof m.event !== 'string') return
    const push = { event: m.event, payload: (m.payload ?? {}) as never } as Push
    if (push.event === 'sessionInvalidated') {
      disposed = true
      failAll('CLOSED', t('화면 질문 세션이 종료되었습니다.'))
    }
    for (const cb of listeners) cb(push)
  }
  function call<T>(op: Op, payload: Record<string, unknown> = {}): Promise<T> {
    if (disposed) return Promise.reject(new BridgeError('CLOSED', t('화면 질문 세션이 종료되었습니다.')))
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settle(id)) reject(new BridgeError('TIMEOUT', t('화면 질문 응답이 지연되고 있습니다.')))
      }, timeoutFor(op, payload))
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      port.postMessage(JSON.stringify({ v: 1, id, sessionId, op, payload }))
    })
  }
  return {
    call,
    async bootstrap(): Promise<Bootstrap> {
      const result = await call<Bootstrap>('bootstrap')
      sessionId = result.sessionId
      return result
    },
    onPush(cb: (p: Push) => void): () => void {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    dispose(): void {
      disposed = true
      failAll('CLOSED', t('화면 질문 세션이 종료되었습니다.'))
      listeners.clear()
    }
  }
}
export type Bridge = ReturnType<typeof createBridge>

/** Mirrors the native chrome's theme onto the panel, including light-based palettes. */
export function applyOverlayTheme(state: Pick<OverlayState, 'theme' | 'palette'>): void {
  const root = document.documentElement
  root.dataset.theme = state.theme
  if (state.palette && state.palette !== 'light' && state.palette !== 'dark') root.dataset.palette = state.palette
  else delete root.dataset.palette
}

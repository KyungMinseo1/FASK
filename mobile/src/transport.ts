// Hub transports. The WebView cannot pin a self-signed certificate, so native builds talk to the
// hub through the FaskHub plugin (OkHttp + leaf-certificate pin). The fetch transport exists only
// for `vite` dev mode in a desktop browser.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type HubIdentity = { addresses: string[]; port: number; fingerprint: string }
export type Pairing = HubIdentity & { token: string }
/** CLOSED: result arriving after the client was closed; never triggers failover, cache, or status. */
export type HubErrorCode = 'PIN_MISMATCH' | 'NETWORK' | 'UNAUTHORIZED' | 'CLOSED'

export class HubError extends Error {
  readonly code: HubErrorCode
  constructor(message: string, code: HubErrorCode) {
    super(message)
    this.name = 'HubError'
    this.code = code
  }
}
export function toHubError(code: unknown): HubError {
  if (code === 'PIN_MISMATCH')
    return new HubError('인증서가 일치하지 않는 연결을 차단했습니다.', 'PIN_MISMATCH')
  // A revoked token must lead to unpairing, not to offline retries.
  if (code === 'UNAUTHORIZED')
    return new HubError('페어링이 해제되었습니다. 다시 연결해 주세요.', 'UNAUTHORIZED')
  return new HubError(
    'PC의 FASK에 연결할 수 없습니다. 네트워크와 모바일 연결 허용을 확인해 주세요.',
    'NETWORK'
  )
}

export interface HubTransport<P extends HubIdentity = Pairing> {
  /** Resolves for every HTTP response except 401, which rejects with UNAUTHORIZED. */
  request(
    p: P,
    address: string,
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    timeoutMs: number
  ): Promise<{ status: number; body: string }>
  /**
   * Resolves only after TLS verification, HTTP 200, an event-stream content type and the
   * `: connected` line; earlier failures reject and never call `onClose`. After resolving,
   * `onClose` fires once when the stream ends. Nothing fires after the returned release().
   */
  openEvents(
    p: P,
    address: string,
    onEvent: (event: string, data: string) => void,
    onClose: (code: HubErrorCode) => void
  ): Promise<() => void>
}

const hubUrl = (p: HubIdentity, address: string, path: string): string =>
  `https://${address}:${p.port}${path}`
const errorCode = (e: unknown): unknown =>
  e && typeof e === 'object' && 'code' in e ? e.code : undefined

interface FaskHubPlugin {
  request(o: {
    url: string
    method: string
    body?: string
    fingerprint: string
    token: string
    timeoutMs: number
  }): Promise<{ status: number; body: string }>
  openEvents(o: { id: string; url: string; fingerprint: string; token: string }): Promise<void>
  closeEvents(o: { id: string }): Promise<void>
  addListener(
    e: 'hubEvent',
    cb: (x: { id: string; event: string; data: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    e: 'hubClosed',
    cb: (x: { id: string; error: string }) => void
  ): Promise<PluginListenerHandle>
}
const FaskHub = registerPlugin<FaskHubPlugin>('FaskHub')

export const nativeTransport: HubTransport = {
  async request(p, address, method, path, body, timeoutMs) {
    let res: { status: number; body: string }
    try {
      res = await FaskHub.request({
        url: hubUrl(p, address, path),
        method,
        ...(body === undefined ? {} : { body }),
        fingerprint: p.fingerprint,
        token: p.token,
        timeoutMs
      })
    } catch (e) {
      throw toHubError(errorCode(e))
    }
    if (res.status === 401) throw toHubError('UNAUTHORIZED')
    return res
  },
  async openEvents(p, address, onEvent, onClose) {
    const id = crypto.randomUUID()
    let live = true
    let handles: PluginListenerHandle[] = []
    const removeListeners = (): void => {
      for (const h of handles) void h.remove()
      handles = []
    }
    // Listeners are registered before the stream opens so no early event is missed.
    handles = await Promise.all([
      FaskHub.addListener('hubEvent', (x) => {
        if (live && x.id === id) onEvent(x.event, x.data)
      }),
      FaskHub.addListener('hubClosed', (x) => {
        if (!live || x.id !== id) return
        live = false
        removeListeners()
        onClose(toHubError(x.error).code)
      })
    ])
    try {
      await FaskHub.openEvents({
        id,
        url: hubUrl(p, address, '/events'),
        fingerprint: p.fingerprint,
        token: p.token
      })
    } catch (e) {
      live = false
      removeListeners()
      throw toHubError(errorCode(e))
    }
    return () => {
      live = false
      removeListeners()
      void FaskHub.closeEvents({ id })
    }
  }
}

/** Feeds `event:`/`data:` lines; a blank line dispatches one event and `:` comments are skipped. */
export async function parseSse(
  lines: AsyncIterable<string>,
  onEvent: (event: string, data: string) => void
): Promise<void> {
  let event = '',
    data: string[] = []
  for await (const line of lines) {
    if (!line) {
      if (data.length) onEvent(event || 'message', data.join('\n'))
      event = ''
      data = []
    } else if (line.startsWith(':')) continue
    else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
}
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
    }
  }
  if (buffer) yield buffer
}

/** Browser dev mode only: no certificate pinning is possible here. */
export const devWebTransport: HubTransport = {
  async request(p, address, method, path, body, timeoutMs) {
    let res: Response
    try {
      res = await fetch(hubUrl(p, address, path), {
        method,
        headers: {
          Authorization: `Bearer ${p.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      throw toHubError('NETWORK')
    }
    if (res.status === 401) throw toHubError('UNAUTHORIZED')
    return { status: res.status, body: await res.text() }
  },
  async openEvents(p, address, onEvent, onClose) {
    const abort = new AbortController()
    let live = true
    let res: Response
    try {
      res = await fetch(hubUrl(p, address, '/events'), {
        headers: { Authorization: `Bearer ${p.token}` },
        signal: abort.signal
      })
    } catch {
      throw toHubError('NETWORK')
    }
    const fail = (code: unknown): never => {
      abort.abort()
      throw toHubError(code)
    }
    if (res.status === 401) fail('UNAUTHORIZED')
    if (
      res.status !== 200 ||
      !res.headers.get('content-type')?.startsWith('text/event-stream') ||
      !res.body
    )
      fail('NETWORK')
    const lines = readLines(res.body!)
    let first = await lines.next().catch(() => ({ done: true, value: '' }) as const)
    while (!first.done && !first.value) first = await lines.next()
    if (first.done || first.value !== ': connected') fail('NETWORK')
    void parseSse(lines, (event, data) => {
      if (live) onEvent(event, data)
    })
      .catch(() => {})
      .finally(() => {
        if (!live) return
        live = false
        onClose('NETWORK')
      })
    return () => {
      live = false
      abort.abort()
    }
  }
}

const unsupportedTransport: HubTransport = {
  request: () => Promise.reject(new Error('Android 앱에서만 연결할 수 있습니다.')),
  openEvents: () => Promise.reject(new Error('Android 앱에서만 연결할 수 있습니다.'))
}
export const isDevWeb = !Capacitor.isNativePlatform() && import.meta.env.DEV
export const transport: HubTransport = Capacitor.isNativePlatform()
  ? nativeTransport
  : import.meta.env.DEV
    ? devWebTransport
    : unsupportedTransport

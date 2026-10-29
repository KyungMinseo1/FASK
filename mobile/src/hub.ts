// Hub client: the desktop KnowledgeApi over HTTPS RPC plus an SSE event stream, with address
// failover, encrypted offline snapshots, and generation guards against late callbacks.
import type {
  AskResult,
  KnowledgeApi,
  Snapshot,
  StreamEvent,
  TurnState
} from '@desktop/preload/personal'
import type { SnapshotCache } from './cache'
import { HubError, toHubError, type HubErrorCode, type HubIdentity, type HubTransport, type Pairing } from './transport'

export type HubConn = { state: 'online' | 'offline' | 'blocked'; savedAt?: string }
export type HubClient = KnowledgeApi & {
  /** Address of the last successful RPC or event stream. */
  address(): string
  reconnect(): void
  close(): void
}

const PAIRING_ERROR = 'FASK 페어링 QR이 아닙니다.'
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
export function parsePairing(text: string): Pairing {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    throw new Error(PAIRING_ERROR)
  }
  const q = url.searchParams
  const port = Number(q.get('p'))
  const fingerprint = q.get('fp') ?? '',
    token = q.get('t') ?? ''
  const addresses = q.getAll('a')
  if (
    url.protocol !== 'fask:' ||
    q.get('v') !== '1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[A-Za-z0-9_-]{43}$/.test(fingerprint) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !addresses.length ||
    !addresses.every((a) => IPV4.test(a))
  )
    throw new Error(PAIRING_ERROR)
  return { addresses, port, fingerprint, token }
}

// Only RPCs whose resend yields the same result. `ask` qualifies: the hub replays a known
// requestId with identical content. create/remove/merge-concept go to the active address only.
const FAILOVER_SAFE: ReadonlySet<string> = new Set([
  'snapshot',
  'attachment',
  'turn-state',
  'refine',
  'ask',
  'cancel',
  'update-question',
  'rename',
  'clear-attachment',
  'edit-concept'
])
const RETRY_MS = [1000, 2000, 5000, 10000]

export function createHubClient<P extends HubIdentity>(
  p: P,
  deps: {
    transport: HubTransport<P>
    cache?: SnapshotCache
    onStatus: (s: HubConn) => void
    onUnpaired: (message: string) => void
  }
): HubClient {
  let active = p.addresses[0]
  let closed = false
  let gen = 0
  let handle: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  // Fixed at creation: a cache clear (unpair/re-pair) makes this client's saves no-ops.
  const cacheEpoch = deps.cache?.epoch()
  let memorySnapshot: { snapshot: Snapshot; savedAt: string } | undefined
  const streamSubs = new Set<(e: StreamEvent) => void>()
  const changedSubs = new Set<() => void>()
  const closedError = (): HubError => new HubError('연결이 해제되었습니다.', 'CLOSED')
  const ordered = (): string[] => [active, ...p.addresses.filter((a) => a !== active)]

  async function rpc(name: string, args: unknown[]): Promise<unknown> {
    if (closed) throw closedError()
    const body = JSON.stringify({ args })
    let pinMismatch = false
    let last: HubError | undefined
    for (const address of FAILOVER_SAFE.has(name) ? ordered() : [active]) {
      let res: { status: number; body: string }
      try {
        res = await deps.transport.request(
          p,
          address,
          'POST',
          `/rpc/${name}`,
          body,
          name === 'ask' ? 60000 : 15000
        )
      } catch (e) {
        if (closed) throw closedError()
        const error = e instanceof HubError ? e : toHubError(undefined)
        if (error.code === 'UNAUTHORIZED') {
          deps.onUnpaired(error.message)
          throw error
        }
        if (error.code === 'CLOSED') throw error
        if (error.code === 'PIN_MISMATCH') pinMismatch = true
        last = error
        continue
      }
      if (closed) throw closedError()
      let parsed: unknown
      try {
        parsed = JSON.parse(res.body)
      } catch {
        parsed = undefined
      }
      const field = (key: string): unknown =>
        parsed && typeof parsed === 'object' ? Reflect.get(parsed, key) : undefined
      if (res.status === 200) {
        active = address
        return field('result')
      }
      // The hub processed the request; resending it elsewhere could apply it twice.
      const message = field('error')
      throw new Error(
        typeof message === 'string' ? message : `요청이 실패했습니다. (${res.status})`
      )
    }
    // A forged certificate never deletes the pairing: that would let a hostile network
    // force a re-pair.
    if (pinMismatch) {
      deps.onStatus({ state: 'blocked' })
      throw toHubError('PIN_MISMATCH')
    }
    throw last ?? toHubError('NETWORK')
  }

  function dispatch(event: string, data: string): void {
    if (event === 'changed') for (const cb of changedSubs) cb()
    else if (event === 'stream') {
      let parsed: StreamEvent
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      for (const cb of streamSubs) cb(parsed)
    }
  }
  function schedule(): void {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(open, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)])
  }
  function fail(codes: HubErrorCode[]): void {
    if (closed) return
    if (codes.includes('UNAUTHORIZED')) {
      deps.onUnpaired(toHubError('UNAUTHORIZED').message)
      return
    }
    if (codes.length && codes.every((c) => c === 'PIN_MISMATCH')) {
      deps.onStatus({ state: 'blocked' })
      return
    }
    deps.onStatus({ state: 'offline' })
    schedule()
  }
  function drop(code: HubErrorCode): void {
    handle = null
    fail([code])
  }
  async function connect(addresses: string[]): Promise<void> {
    const codes: HubErrorCode[] = []
    for (const address of addresses) {
      if (closed) return
      const my = ++gen
      let release: () => void
      try {
        release = await deps.transport.openEvents(
          p,
          address,
          (event, data) => {
            if (my === gen && !closed) dispatch(event, data)
          },
          (code) => {
            if (my === gen && !closed) drop(code)
          }
        )
      } catch (e) {
        if (my !== gen) return
        codes.push(e instanceof HubError ? e.code : 'NETWORK')
        continue
      }
      // A newer attempt or close() superseded this one while it was opening.
      if (my !== gen || closed) {
        release()
        return
      }
      handle = release
      active = address
      attempt = 0
      deps.onStatus({ state: 'online' })
      // Subscribers re-read whatever changed while the stream was down.
      for (const cb of changedSubs) cb()
      return
    }
    fail(codes)
  }
  function open(): void {
    if (closed) return
    clearTimeout(timer)
    // Invalidate the generation before closing the previous stream so its callbacks are dropped.
    const previous = handle
    handle = null
    gen++
    previous?.()
    void connect(ordered())
  }

  const client: HubClient = {
    async snapshot() {
      let s: Snapshot
      try {
        s = (await rpc('snapshot', [])) as Snapshot
      } catch (e) {
        if (closed) throw closedError()
        if (!(e instanceof HubError) || (e.code !== 'NETWORK' && e.code !== 'PIN_MISMATCH'))
          throw e
        const cached = deps.cache ? await deps.cache.load(p.fingerprint) : memorySnapshot
        if (closed) throw closedError()
        if (!cached) throw e
        deps.onStatus({
          state: e.code === 'PIN_MISMATCH' ? 'blocked' : 'offline',
          savedAt: cached.savedAt
        })
        return cached.snapshot
      }
      try {
        if (deps.cache)
          await deps.cache.save(s, { epoch: cacheEpoch!, fingerprint: p.fingerprint })
      } catch {
        /* The live snapshot is still valid without a cached copy. */
      }
      if (closed) throw closedError()
      if (!deps.cache) memorySnapshot = { snapshot: s, savedAt: new Date().toISOString() }
      deps.onStatus({ state: 'online' })
      return s
    },
    create: (kind, name, parentId) => rpc('create', [kind, name, parentId]) as Promise<string>,
    rename: async (kind, id, name) => void (await rpc('rename', [kind, id, name])),
    remove: async (kind, id) => void (await rpc('remove', [kind, id])),
    moveQuestion: async (id, projectId) => void (await rpc('move-question', [id, projectId])),
    updateQuestion: async (id, patch) => void (await rpc('update-question', [id, patch])),
    moveQuestion: async (id, projectId) => void (await rpc('move-question', [id, projectId])),
    editConcept: async (id, name, parentId) =>
      void (await rpc('edit-concept', [id, name, parentId])),
    mergeConcept: async (source, target) => void (await rpc('merge-concept', [source, target])),
    ask: (input) => rpc('ask', [input]) as Promise<AskResult>,
    cancel: async (id) => void (await rpc('cancel', [id])),
    turnState: (questionId, turnId) =>
      rpc('turn-state', [questionId, turnId]) as Promise<TurnState>,
    refine: (raw, image) => rpc('refine', [raw, image]) as Promise<string>,
    attachment: (id) => rpc('attachment', [id]) as Promise<string | null>,
    clearAttachment: async (questionId, turnId) =>
      void (await rpc('clear-attachment', [questionId, turnId])),
    onStream(cb) {
      streamSubs.add(cb)
      return () => void streamSubs.delete(cb)
    },
    onChanged(cb) {
      changedSubs.add(cb)
      return () => void changedSubs.delete(cb)
    },
    address: () => active,
    reconnect() {
      attempt = 0
      open()
    },
    close() {
      closed = true
      memorySnapshot = undefined
      gen++
      clearTimeout(timer)
      handle?.()
      handle = null
    }
  }
  open()
  return client
}

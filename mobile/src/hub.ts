// Hub client: the desktop KnowledgeApi over HTTPS RPC plus an SSE event stream, with staggered
// address racing, relay→direct path upgrades, encrypted offline snapshots, and stream ownership
// tokens that silence callbacks from superseded streams.
import type {
  AskResult,
  KnowledgeApi,
  Snapshot,
  StreamEvent,
  TurnState
} from '@desktop/preload/personal'
import type { SnapshotCache } from './cache'
import {
  HubError,
  parseRelay,
  RELAY_ADDRESS,
  toHubError,
  type HubErrorCode,
  type HubIdentity,
  type HubTransport,
  type Pairing
} from './transport'
import { t } from '@desktop/shared/i18n'

export type HubConn = { state: 'online' | 'offline' | 'blocked'; savedAt?: string }
export type HubClient = KnowledgeApi & {
  /** Address of the last successful RPC or event stream. */
  address(): string
  reconnect(): void
  close(): void
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
export function parsePairing(text: string): Pairing {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    throw new Error(t('FASK 페어링 QR이 아닙니다.'))
  }
  const q = url.searchParams
  const port = Number(q.get('p'))
  const fingerprint = q.get('fp') ?? '',
    token = q.get('t') ?? ''
  const addresses = q.getAll('a')
  const relayUrl = q.get('r'),
    relayRoom = q.get('rk')
  const relay = relayUrl === null && relayRoom === null ? null : parseRelay(relayUrl, relayRoom)
  if (
    url.protocol !== 'fask:' ||
    q.get('v') !== '1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[A-Za-z0-9_-]{43}$/.test(fingerprint) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    ((relayUrl !== null || relayRoom !== null) && !relay) ||
    !(addresses.length || relay) ||
    !addresses.every((a) => IPV4.test(a))
  )
    throw new Error(t('FASK 페어링 QR이 아닙니다.'))
  return relay
    ? { addresses: [...addresses, RELAY_ADDRESS], port, fingerprint, token, relay }
    : { addresses, port, fingerprint, token }
}

export const STAGGER_MS = 2000
/**
 * Attempt i starts when attempt i-1 fails or STAGGER_MS after it started; first fulfilled wins;
 * later fulfilments go to onLate; rejects with { errors } (address order) when all fail.
 */
export function staggered<T>(
  addresses: string[],
  attempt: (address: string) => Promise<T>,
  onLate: (value: T) => void,
  cancelled: () => boolean
): Promise<{ address: string; value: T }> {
  return new Promise((resolve, reject) => {
    const errors: unknown[] = []
    let settled = false,
      started = 0,
      failed = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const giveUp = (): void => {
      settled = true
      clearTimeout(timer)
      reject({ errors })
    }
    const launch = (): void => {
      clearTimeout(timer)
      if (settled) return
      if (started === addresses.length || cancelled()) {
        if (failed === started) giveUp()
        return
      }
      const index = started++
      const address = addresses[index]
      if (started < addresses.length) timer = setTimeout(launch, STAGGER_MS)
      attempt(address).then(
        (value) => {
          if (settled) return onLate(value)
          settled = true
          clearTimeout(timer)
          resolve({ address, value })
        },
        (error: unknown) => {
          errors[index] = error
          failed++
          if (settled) return
          // The newest attempt failing starts the next one at once; launch() also settles the race
          // once every started attempt failed and nothing more may start.
          if (index === started - 1 || failed === started) launch()
        }
      )
    }
    launch()
  })
}
export const UPGRADE_PROBE_MS = 30000
/** An open event stream plus the ownership token its callbacks check before dispatching. */
type OpenedStream = { token: object; release: () => void }

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
  /** Bumped by open()/close(); a connect race whose generation is stale releases its winner. */
  let gen = 0
  let handle: (() => void) | null = null
  /** Ownership token of the live event stream; callbacks of any other stream are dropped. */
  let current: object | null = null
  /** Address the live event stream runs over. */
  let streamAt = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let probe: ReturnType<typeof setInterval> | undefined
  let candidate: { cancelled: boolean } | null = null
  let attempt = 0
  // Fixed at creation: a cache clear (unpair/re-pair) makes this client's saves no-ops.
  const cacheEpoch = deps.cache?.epoch()
  let memorySnapshot: { snapshot: Snapshot; savedAt: string } | undefined
  const streamSubs = new Set<(e: StreamEvent) => void>()
  const changedSubs = new Set<() => void>()
  const closedError = (): HubError => new HubError(t('연결이 해제되었습니다.'), 'CLOSED')
  const ordered = (): string[] => [active, ...p.addresses.filter((a) => a !== active)]

  async function rpc(name: string, args: unknown[]): Promise<unknown> {
    if (closed) throw closedError()
    const body = JSON.stringify({ args })
    // A path switch while this request is in flight wins over the address it completes on.
    const startedOn = active
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
        if (active === startedOn) active = address
        return field('result')
      }
      // The hub processed the request; resending it elsewhere could apply it twice.
      const message = field('error')
      throw new Error(
        typeof message === 'string' ? message : t('요청이 실패했습니다. ({{status}})', { status: res.status })
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
  function stopUpgrade(): void {
    clearInterval(probe)
    probe = undefined
    if (candidate) candidate.cancelled = true
    candidate = null
  }
  function drop(code: HubErrorCode): void {
    handle = null
    current = null
    stopUpgrade()
    fail([code])
  }
  async function openStream(address: string): Promise<OpenedStream> {
    const token = {}
    const release = await deps.transport.openEvents(
      p,
      address,
      (event, data) => {
        if (current === token && !closed) dispatch(event, data)
      },
      (code) => {
        if (current === token && !closed) drop(code)
      }
    )
    return { token, release }
  }
  /** Makes `opened` the live stream; the previous one is released only after the swap. */
  function promote(address: string, opened: OpenedStream): void {
    const previous = handle
    current = opened.token
    handle = opened.release
    active = streamAt = address
    attempt = 0
    previous?.()
    deps.onStatus({ state: 'online' })
    // Subscribers re-read whatever changed while the stream was down or switching.
    for (const cb of changedSubs) cb()
    if (address === RELAY_ADDRESS && p.addresses.length > 1) probe = setInterval(upgrade, UPGRADE_PROBE_MS)
  }
  async function connect(order: string[]): Promise<void> {
    const my = ++gen
    const superseded = (): boolean => my !== gen || closed
    let winner: { address: string; value: OpenedStream }
    try {
      winner = await staggered(order, openStream, (late) => late.release(), superseded)
    } catch (e) {
      if (superseded()) return
      const errors = e && typeof e === 'object' && 'errors' in e && Array.isArray(e.errors) ? e.errors : []
      fail(errors.filter((x) => x !== undefined).map((x) => (x instanceof HubError ? x.code : 'NETWORK')))
      return
    }
    if (superseded()) return winner.value.release()
    promote(winner.address, winner.value)
  }
  /**
   * While streaming over the relay, look for a direct path every UPGRADE_PROBE_MS and move the
   * event stream there make-before-break. RPCs in flight finish on the connection they started on.
   */
  function upgrade(): void {
    if (closed || candidate || streamAt !== RELAY_ADDRESS || handle === null) return
    const mine = { cancelled: false }
    candidate = mine
    const finish = (): void => {
      if (candidate === mine) candidate = null
    }
    const direct = p.addresses.filter((a) => a !== RELAY_ADDRESS)
    // /health requires the token, so a 200 from the FASK hub proves the authenticated path.
    const healthy = async (address: string): Promise<void> => {
      const res = await deps.transport.request(p, address, 'GET', '/health', undefined, 3000)
      let app: unknown
      try {
        app = Reflect.get(JSON.parse(res.body) ?? {}, 'app')
      } catch {
        app = undefined
      }
      if (res.status !== 200 || app !== 'fask') throw toHubError('NETWORK')
    }
    void (async () => {
      let target: string
      try {
        target = (await staggered(direct, healthy, () => {}, () => mine.cancelled)).address
      } catch {
        return finish()
      }
      if (mine.cancelled) return
      let opened: OpenedStream
      try {
        opened = await openStream(target)
      } catch {
        return finish()
      }
      if (mine.cancelled || closed || streamAt !== RELAY_ADDRESS || handle === null) {
        opened.release()
        return finish()
      }
      finish()
      clearInterval(probe)
      probe = undefined
      promote(target, opened)
    })()
  }
  function open(): void {
    if (closed) return
    clearTimeout(timer)
    stopUpgrade()
    // Drop ownership before closing the previous stream so its callbacks are ignored.
    const previous = handle
    handle = null
    current = null
    previous?.()
    void connect(active === RELAY_ADDRESS ? [...p.addresses] : ordered())
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
      stopUpgrade()
      current = null
      handle?.()
      handle = null
    }
  }
  open()
  return client
}

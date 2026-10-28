import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '@desktop/preload/personal'
import { createSnapshotCache, type SnapshotCacheIo } from '../src/cache'
import { createHubClient, parsePairing, type HubConn } from '../src/hub'
import { HubError, toHubError, type HubErrorCode, type HubIdentity, type HubTransport, type Pairing } from '../src/transport'

const fp1 = 'A'.repeat(43),
  fp2 = 'B'.repeat(43)
const pairing = (fingerprint = fp1): Pairing => ({
  addresses: ['10.0.0.1', '10.0.0.2'],
  port: 47615,
  fingerprint,
  token: 'T'.repeat(43)
})
const A = '10.0.0.1',
  B = '10.0.0.2'
const snapshot = (marker: string): Snapshot =>
  ({ activeProfileId: marker, questions: [], profiles: [] }) as unknown as Snapshot

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
function memoryIo(): SnapshotCacheIo & { state: { key: string | null; file: string | null } } {
  const state = { key: null as string | null, file: null as string | null }
  return {
    state,
    getKey: async () => state.key,
    setKey: async (v) => void (state.key = v),
    removeKey: async () => void (state.key = null),
    read: async () => state.file,
    write: async (t) => void (state.file = t),
    remove: async () => void (state.file = null)
  }
}
type Request = HubTransport['request']
type Open = HubTransport['openEvents']
function fakeTransport(
  request: (address: string, path: string, body: string | undefined) => ReturnType<Request>,
  openEvents: (...a: [string, Parameters<Open>[2], Parameters<Open>[3]]) => ReturnType<Open> = () =>
    new Promise(() => {})
): HubTransport & { requests: string[]; opens: string[] } {
  const requests: string[] = [],
    opens: string[] = []
  return {
    requests,
    opens,
    request: (_p, address, _m, path, body) => {
      requests.push(`${address}${path}`)
      return request(address, path, body)
    },
    openEvents: (_p, address, onEvent, onClose) => {
      opens.push(address)
      return openEvents(address, onEvent, onClose)
    }
  }
}
const ok = (result: unknown): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({ result })
})
/** Fake hub that, like the desktop, deduplicates ask by requestId. */
function fakeHub(): {
  turns: string[]
  ask: (body: string | undefined) => { questionId: string; turnId: string }
} {
  const byRequest = new Map<string, { questionId: string; turnId: string }>()
  const turns: string[] = []
  return {
    turns,
    ask(body) {
      const [input] = JSON.parse(body ?? '{}').args as [{ requestId: string }]
      const known = byRequest.get(input.requestId)
      if (known) return known
      const result = { questionId: 'q1', turnId: `t${turns.length + 1}` }
      turns.push(input.requestId)
      byRequest.set(input.requestId, result)
      return result
    }
  }
}
function client(
  transport: HubTransport,
  cache = createSnapshotCache(memoryIo()),
  p = pairing()
): {
  c: ReturnType<typeof createHubClient>
  statuses: HubConn[]
  unpaired: string[]
} {
  const statuses: HubConn[] = [],
    unpaired: string[] = []
  const c = createHubClient(p, {
    transport,
    cache,
    onStatus: (s) => statuses.push(s),
    onUnpaired: (m) => unpaired.push(m)
  })
  return { c, statuses, unpaired }
}
const askInput = (requestId: string) => ({
  requestId,
  profileId: 'p',
  projectId: 'pr',
  raw: '질문',
  model: ''
})

afterEach(() => {
  vi.useRealTimers()
})

describe('identity-only hub client without persistent cache', () => {
  const identity: HubIdentity = { addresses: [A], port: 47615, fingerprint: fp1 }
  function memoryClient(transport: HubTransport<HubIdentity>) {
    const statuses: HubConn[] = []
    const unpaired: string[] = []
    const c = createHubClient(identity, {
      transport,
      onStatus: (status) => statuses.push(status),
      onUnpaired: (message) => unpaired.push(message)
    })
    return { c, statuses, unpaired }
  }

  it('loads a snapshot and sends a new question followed by a turn in the same question', async () => {
    const inputs: unknown[] = []
    const transport: HubTransport<HubIdentity> = {
      async request(_identity, _address, _method, path, body) {
        if (path === '/rpc/snapshot') return ok(snapshot('profile'))
        const [input] = JSON.parse(body!).args
        inputs.push(input)
        return ok({ questionId: 'q1', turnId: `t${inputs.length}` })
      },
      openEvents: () => new Promise(() => {})
    }
    const { c } = memoryClient(transport)
    expect(await c.snapshot()).toEqual(snapshot('profile'))
    const first = await c.ask(askInput('first'))
    const followup = { ...askInput('followup'), questionId: first.questionId }
    expect(await c.ask(followup)).toEqual({ questionId: 'q1', turnId: 't2' })
    expect(inputs).toEqual([askInput('first'), followup])
    c.close()
  })

  it.each(['NETWORK', 'PIN_MISMATCH'] as const)(
    'returns only the last successful in-memory snapshot on %s',
    async (code) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      let failure = false
      const transport: HubTransport<HubIdentity> = {
        async request() {
          if (failure) throw toHubError(code)
          return ok(snapshot('remembered'))
        },
        openEvents: () => new Promise(() => {})
      }
      const { c, statuses } = memoryClient(transport)
      await c.snapshot()
      failure = true
      vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
      expect(await c.snapshot()).toEqual(snapshot('remembered'))
      expect(statuses.at(-1)).toEqual({
        state: code === 'NETWORK' ? 'offline' : 'blocked',
        savedAt: '2026-01-01T00:00:00.000Z'
      })
      c.close()
      const fresh = memoryClient(transport)
      await expect(fresh.c.snapshot()).rejects.toMatchObject({ code })
      fresh.c.close()
    }
  )

  it('rejects an initial failure rather than inventing an offline snapshot', async () => {
    const { c } = memoryClient({
      request: async () => { throw toHubError('NETWORK') },
      openEvents: () => new Promise(() => {})
    })
    await expect(c.snapshot()).rejects.toMatchObject({ code: 'NETWORK' })
    c.close()
  })

  it('cannot restore snapshot, status or events through callbacks arriving after close', async () => {
    const response = deferred<{ status: number; body: string }>()
    const stream = deferred<() => void>()
    let onEvent!: Parameters<HubTransport<HubIdentity>['openEvents']>[2]
    let onClose!: Parameters<HubTransport<HubIdentity>['openEvents']>[3]
    const { c, statuses, unpaired } = memoryClient({
      request: () => response.promise,
      openEvents: (_identity, _address, event, close) => {
        onEvent = event
        onClose = close
        return stream.promise
      }
    })
    const changed = vi.fn()
    const received = vi.fn()
    c.onChanged(changed)
    c.onStream(received)
    const pending = c.snapshot()
    c.close()
    const released = vi.fn()
    stream.resolve(released)
    response.resolve(ok(snapshot('late')))
    onEvent('changed', '{}')
    onEvent('stream', JSON.stringify({ delta: 'late' }))
    onClose('UNAUTHORIZED')
    await expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(c.snapshot()).rejects.toMatchObject({ code: 'CLOSED' })
    expect(released).toHaveBeenCalledOnce()
    expect(statuses).toEqual([])
    expect(unpaired).toEqual([])
    expect(changed).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
  })
})

describe('hub client', () => {
  it('Wi-Fi drop after the hub applied ask: retry on B returns the same turn', async () => {
    const hub = fakeHub()
    const t = fakeTransport(async (address, _path, body) => {
      const result = hub.ask(body)
      if (address === A) throw toHubError('NETWORK') // applied, response lost
      return ok(result)
    })
    const { c } = client(t)
    const first = await c.ask(askInput('r1'))
    expect(first).toEqual({ questionId: 'q1', turnId: 't1' })
    expect(hub.turns).toEqual(['r1'])
    await c.snapshot().catch(() => {})
    // B is now active, so the next failover-safe RPC tries it first.
    expect(t.requests.find((r) => r.endsWith('/rpc/snapshot'))).toBe(`${B}/rpc/snapshot`)
    c.close()
  })
  it('non-idempotent RPC is never resent to another address', async () => {
    const t = fakeTransport(async (address) => {
      if (address === A) throw toHubError('NETWORK')
      return ok('id')
    })
    const { c } = client(t)
    await expect(c.create('concept', 'x', 'pr')).rejects.toMatchObject({ code: 'NETWORK' })
    expect(t.requests.filter((r) => r.startsWith(B))).toHaveLength(0)
    c.close()
  })
  it('concurrent asks keep distinct turns across failover', async () => {
    const hub = fakeHub()
    const t = fakeTransport(async (address, _path, body) => {
      const id = JSON.parse(body ?? '{}').args[0].requestId
      if (address === A) {
        if (id === 'r1') hub.ask(body)
        throw toHubError('NETWORK')
      }
      return ok(hub.ask(body))
    })
    const { c } = client(t)
    const [r1, r2] = await Promise.all([c.ask(askInput('r1')), c.ask(askInput('r2'))])
    expect(r1).not.toEqual(r2)
    expect(hub.turns).toHaveLength(2)
    c.close()
  })
  it('a late stream event from the previous address is not delivered', async () => {
    const callbacks = new Map<
      string,
      { onEvent: (e: string, d: string) => void; onClose: (c: HubErrorCode) => void }
    >()
    const t = fakeTransport(
      async () => ok(null),
      async (address, onEvent, onClose) => {
        callbacks.set(address, { onEvent, onClose })
        return () => {}
      }
    )
    vi.useFakeTimers()
    const { c } = client(t)
    const received: string[] = []
    c.onStream((e) => received.push(String(e.delta)))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.opens).toEqual([A])
    // Force the reconnect to try B first by making A unreachable.
    t.openEvents = async (_p, address, onEvent, onClose) => {
      t.opens.push(address)
      if (address === A) throw toHubError('NETWORK')
      callbacks.set(address, { onEvent, onClose })
      return () => {}
    }
    const a = callbacks.get(A)!
    a.onClose('NETWORK')
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.opens).toEqual([A, A, B])
    a.onEvent('stream', JSON.stringify({ delta: 'late-A' }))
    callbacks.get(B)!.onEvent('stream', JSON.stringify({ delta: 'b' }))
    expect(received).toEqual(['b'])
    c.close()
  })
  it('all addresses failing the pin: blocked, never unpaired, no reconnect loop', async () => {
    vi.useFakeTimers()
    const t = fakeTransport(
      async () => {
        throw toHubError('PIN_MISMATCH')
      },
      async () => {
        throw toHubError('PIN_MISMATCH')
      }
    )
    const { c, statuses, unpaired } = client(t)
    await vi.advanceTimersByTimeAsync(0)
    await expect(c.ask(askInput('r1'))).rejects.toMatchObject({ code: 'PIN_MISMATCH' })
    expect(statuses.at(-1)).toEqual({ state: 'blocked' })
    expect(unpaired).toEqual([])
    const opens = t.opens.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(t.opens.length).toBe(opens)
    c.close()
  })
  it('stays offline until a later address actually opens', async () => {
    const b = deferred<() => void>()
    let releases = 0
    const t = fakeTransport(
      async () => ok(null),
      async (address) => {
        if (address === A) throw toHubError('NETWORK')
        return b.promise
      }
    )
    const { c, statuses } = client(t)
    await Promise.resolve()
    await Promise.resolve()
    expect(t.opens).toEqual([A, B])
    expect(statuses.some((s) => s.state === 'online')).toBe(false)
    b.resolve(() => releases++)
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: 'online' }))
    await c.snapshot()
    expect(t.requests.at(-1)).toBe(`${B}/rpc/snapshot`)
    c.close()
    expect(releases).toBe(1)
  })
  it('a slow earlier attempt resolving after reconnect is released and silenced', async () => {
    const pending: Array<{ address: string; d: ReturnType<typeof deferred<() => void>> }> = []
    const callbacks: Array<(e: string, d: string) => void> = []
    const t = fakeTransport(
      async () => ok(null),
      (address, onEvent) => {
        const d = deferred<() => void>()
        pending.push({ address, d })
        callbacks.push(onEvent)
        return d.promise
      }
    )
    const { c } = client(t)
    const got: string[] = []
    c.onStream((e) => got.push(String(e.delta)))
    c.reconnect()
    let releasedOld = 0
    pending[1].d.resolve(() => {})
    await Promise.resolve()
    pending[0].d.resolve(() => releasedOld++)
    await vi.waitFor(() => expect(releasedOld).toBe(1))
    callbacks[0]('stream', JSON.stringify({ delta: 'old' }))
    callbacks[1]('stream', JSON.stringify({ delta: 'new' }))
    expect(got).toEqual(['new'])
    c.close()
  })
  it('after close: late open is released and a late onClose schedules nothing', async () => {
    vi.useFakeTimers()
    const d = deferred<() => void>()
    let onCloseRef: ((c: HubErrorCode) => void) | undefined
    const t = fakeTransport(
      async () => ok(null),
      (_a, _e, onClose) => {
        onCloseRef = onClose
        return d.promise
      }
    )
    const { c } = client(t)
    c.close()
    let released = 0
    d.resolve(() => released++)
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(1)
    onCloseRef!('NETWORK')
    const opens = t.opens.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(t.opens.length).toBe(opens)
  })
  it('a snapshot resolving after close and cache.clear never writes the cache', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    const response = deferred<{ status: number; body: string }>()
    const t = fakeTransport(() => response.promise)
    const { c } = client(t, cache)
    const pending = c.snapshot()
    c.close()
    await cache.clear()
    response.resolve(ok(snapshot('late')))
    await expect(pending).rejects.toThrow('연결이 해제되었습니다.')
    expect(await cache.load(fp1)).toBeNull()
    expect(io.state).toEqual({ key: null, file: null })
  })
  it('re-pairing: the previous PC answer cannot overwrite the new cache', async () => {
    const cache = createSnapshotCache(memoryIo())
    const old = deferred<{ status: number; body: string }>()
    const c1 = client(fakeTransport(() => old.promise), cache, pairing(fp1)).c
    const pending = c1.snapshot()
    await cache.clear()
    const c2 = client(fakeTransport(async () => ok(snapshot('new'))), cache, pairing(fp2)).c
    await c2.snapshot()
    old.resolve(ok(snapshot('old')))
    await pending
    expect((await cache.load(fp2))?.snapshot.activeProfileId).toBe('new')
    c1.close()
    c2.close()
  })
  it('one mismatching address does not block a healthy one', async () => {
    const t = fakeTransport(async (address) => {
      if (address === A) throw toHubError('PIN_MISMATCH')
      return ok(snapshot('b'))
    })
    const { c, statuses } = client(t)
    expect((await c.snapshot()).activeProfileId).toBe('b')
    expect(statuses.at(-1)).toEqual({ state: 'online' })
    c.close()
  })
  it('UNAUTHORIZED unpairs exactly once', async () => {
    const t = fakeTransport(async () => {
      throw toHubError('UNAUTHORIZED')
    })
    const { c, unpaired } = client(t)
    await expect(c.snapshot()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(unpaired).toHaveLength(1)
    c.close()
  })
  it('offline: all addresses NETWORK returns the cached snapshot', async () => {
    const cache = createSnapshotCache(memoryIo())
    let online = true
    const t = fakeTransport(async () => {
      if (!online) throw toHubError('NETWORK')
      return ok(snapshot('cached'))
    })
    const { c, statuses } = client(t, cache)
    await c.snapshot()
    online = false
    expect((await c.snapshot()).activeProfileId).toBe('cached')
    expect(statuses.at(-1)?.state).toBe('offline')
    expect(statuses.at(-1)?.savedAt).toBeTypeOf('string')
    c.close()
  })
  it('plugin error codes are preserved', () => {
    expect(toHubError('UNAUTHORIZED').code).toBe('UNAUTHORIZED')
    expect(toHubError('PIN_MISMATCH').code).toBe('PIN_MISMATCH')
    expect(toHubError('boom').code).toBe('NETWORK')
    expect(toHubError('boom')).toBeInstanceOf(HubError)
  })
  it('event stream 401 unpairs without going offline or scheduling', async () => {
    vi.useFakeTimers()
    const t = fakeTransport(
      async () => ok(null),
      async () => {
        throw toHubError('UNAUTHORIZED')
      }
    )
    const { c, statuses, unpaired } = client(t)
    await vi.advanceTimersByTimeAsync(0)
    expect(unpaired).toHaveLength(1)
    expect(statuses.some((s) => s.state === 'offline')).toBe(false)
    const opens = t.opens.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(t.opens.length).toBe(opens)
    c.close()
  })
  it('close during the post-snapshot cache save: CLOSED, no online, no fallback', async () => {
    const io = memoryIo()
    const write = deferred<void>()
    let writing = false
    io.write = () => {
      writing = true
      return write.promise
    }
    const cache = createSnapshotCache(io)
    const load = vi.spyOn(cache, 'load')
    const t = fakeTransport(async () => ok(snapshot('s')))
    const { c, statuses } = client(t, cache)
    const pending = c.snapshot()
    await vi.waitFor(() => expect(writing).toBe(true))
    c.close()
    write.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
    expect(statuses.filter((s) => s.state === 'online')).toHaveLength(0)
    expect(load).not.toHaveBeenCalled()
  })
  it('a failure arriving after close is CLOSED with no further attempts', async () => {
    const cache = createSnapshotCache(memoryIo())
    const load = vi.spyOn(cache, 'load')
    const response = deferred<{ status: number; body: string }>()
    const t = fakeTransport(() => response.promise)
    const { c } = client(t, cache)
    const pending = c.snapshot()
    c.close()
    response.reject(toHubError('NETWORK'))
    await expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
    expect(t.requests).toEqual([`${A}/rpc/snapshot`])
    expect(load).not.toHaveBeenCalled()
  })
  it('HTTP errors from the hub are not retried elsewhere', async () => {
    const t = fakeTransport(async () => ({ status: 400, body: JSON.stringify({ error: '거절' }) }))
    const { c } = client(t)
    await expect(c.ask(askInput('r1'))).rejects.toThrow('거절')
    expect(t.requests).toHaveLength(1)
    c.close()
  })
})

describe('parsePairing', () => {
  const token = 'T'.repeat(43)
  it('accepts a desktop pairing link and keeps address order', () => {
    expect(
      parsePairing(`fask://pair?v=1&p=47615&fp=${fp1}&t=${token}&a=192.168.0.17&a=100.64.1.2`)
    ).toEqual({
      addresses: ['192.168.0.17', '100.64.1.2'],
      port: 47615,
      fingerprint: fp1,
      token
    })
  })
  it.each([
    `https://pair?v=1&p=47615&fp=${fp1}&t=${token}&a=1.2.3.4`,
    `fask://pair?v=2&p=47615&fp=${fp1}&t=${token}&a=1.2.3.4`,
    `fask://pair?v=1&p=70000&fp=${fp1}&t=${token}&a=1.2.3.4`,
    `fask://pair?v=1&p=47615&fp=short&t=${token}&a=1.2.3.4`,
    `fask://pair?v=1&p=47615&fp=${fp1}&t=${token}`,
    `fask://pair?v=1&p=47615&fp=${fp1}&t=${token}&a=999.1.1.1`,
    'not a url'
  ])('rejects %s', (text) => {
    expect(() => parsePairing(text)).toThrow('FASK 페어링 QR이 아닙니다.')
  })
})

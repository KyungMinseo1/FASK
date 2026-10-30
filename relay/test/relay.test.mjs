// Runs the relay under `wrangler dev` (local workerd, no Cloudflare account) and drives it with `ws` clients.
import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { WINDOW, ack, data, relayPipe } from './framing.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const MiB = 1024 * 1024

async function startWrangler(port, mode, config) {
  const args = [WRANGLER, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', `RATE_LIMIT_MODE:${mode}`]
  if (config) args.push('-c', config)
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  let log = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${log}`)), 60000)
    const onData = (chunk) => {
      log += chunk
      if (/Ready on/.test(log)) {
        clearTimeout(timer)
        resolve()
      }
    }
    // A force-killed child resets its pipes on Windows.
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', onData)
      stream.on('error', () => {})
    }
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`wrangler dev exited ${code}:\n${log}`))
    })
  })
  return { child, base: `127.0.0.1:${port}` }
}

async function stopWrangler(server) {
  if (!server || server.child.exitCode !== null) return
  const exited = once(server.child, 'exit')
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/pid', String(server.child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-server.child.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  await exited
}

let server
let ipSeq = 0
const sockets = new Set()

/** Each case uses its own client IP so the shared IP_LIMIT bucket never couples cases. */
const nextIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
const newKey = () => randomBytes(32).toString('base64url')
const roomOf = (key) => createHash('sha256').update(key).digest('base64url')

function open(path, { key, ip } = {}) {
  const headers = { 'cf-connecting-ip': ip ?? nextIp() }
  if (key) headers.Authorization = `Bearer ${key}`
  const sock = new WebSocket(`ws://${server.base}${path}`, { headers })
  sock.on('error', () => {})
  sockets.add(sock)
  sock.ready = new Promise((resolve, reject) => {
    sock.once('unexpected-response', (req, res) => {
      let body = ''
      // Node half-closes the socket after a rejected upgrade and leaves it without an error listener.
      const socket = res.socket
      socket.on('error', () => {})
      const finish = () => {
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body }))
        req.destroy()
        socket.destroy()
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', finish)
      res.on('error', finish)
    })
    sock.once('open', resolve)
    sock.once('error', reject)
  })
  // The relay's close frame decides the outcome. Under `wrangler dev` the server keeps TCP open for ~10 s
  // after a server-initiated close, so resolve on the frame (ws receiver internals) as well as on 'close'.
  sock.closed = new Promise((resolve) => {
    const done = (code, reason) => resolve({ code, reason: String(reason) })
    sock.once('close', done)
    sock.once('open', () => sock._receiver.once('conclude', done))
  })
  return sock
}

/** Plain HTTP without keep-alive, so killing the dev server never resets a pooled socket. */
function get(path) {
  return new Promise((resolve, reject) => {
    httpGet(`http://${server.base}${path}`, { agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}

/** 101 for a successful upgrade, otherwise the HTTP status. */
async function upgradeStatus(path, opts) {
  const sock = open(path, opts)
  try {
    await sock.ready
    return 101
  } catch (e) {
    return e.status
  }
}

async function startHost(key, ip, { accept = true } = {}) {
  const sock = open('/v1/host', { key, ip })
  await sock.ready
  const host = { sock, opens: [], dataSockets: [], waiters: [] }
  host.nextData = () =>
    host.dataSockets.length ? Promise.resolve(host.dataSockets.shift()) : new Promise((r) => host.waiters.push(r))
  sock.on('message', (msg, isBinary) => {
    if (isBinary) return
    const { id } = JSON.parse(String(msg))
    host.opens.push(id)
    if (!accept) return
    const dataSock = open(`/v1/accept/${id}`, { key, ip })
    dataSock.ready.then(
      () => (host.waiters.length ? host.waiters.shift()(dataSock) : host.dataSockets.push(dataSock)),
      () => {}
    )
  })
  return host
}

async function connectClient(room, ip) {
  const sock = open(`/v1/connect/${room}`, { ip })
  // Listen before the upgrade settles: `ready` can arrive in the same read as the 101 response.
  const ready = new Promise((resolve, reject) => {
    sock.once('message', (msg, isBinary) =>
      !isBinary && String(msg) === 'ready' ? resolve() : reject(new Error('expected ready'))
    )
    sock.closed.then(({ code }) => reject(new Error(`closed ${code} before ready`)))
  })
  ready.catch(() => {})
  await sock.ready
  await ready
  return sock
}

async function pair() {
  const ip = nextIp()
  const key = newKey()
  const host = await startHost(key, ip)
  const client = await connectClient(roomOf(key), ip)
  const dataSock = await host.nextData()
  return { ip, key, host, client, dataSock }
}

const nextMessage = (sock) => once(sock, 'message').then(([msg, isBinary]) => ({ msg: Buffer.from(msg), isBinary }))

async function waitFor(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function closeAll() {
  for (const sock of sockets) sock.terminate()
  sockets.clear()
}

describe('relay with rate limiting bindings', () => {
  before(async () => {
    server = await startWrangler(8799, 'required')
    const health = JSON.parse((await get('/v1/health')).body)
    if (!health.rateLimit) {
      console.log('notice: local dev lacks rate limiting bindings; main suite runs with RATE_LIMIT_MODE=off')
      await stopWrangler(server)
      server = await startWrangler(8799, 'off')
    }
  })
  after(async () => {
    closeAll()
    await stopWrangler(server)
  })
  afterEach(closeAll)

  test('validates routes before touching a room', async () => {
    assert.equal((await get('/x')).status, 404)
    assert.equal((await get('/v1/host')).status, 426)
    assert.equal(await upgradeStatus('/v1/host'), 401)
    assert.equal(await upgradeStatus('/v1/host', { key: 'short' }), 401)
    assert.equal(await upgradeStatus('/v1/connect/short'), 400)
    assert.equal(await upgradeStatus('/v1/accept/bad', { key: newKey() }), 400)
    const health = await get('/v1/health')
    assert.equal(health.status, 200)
    assert.deepEqual(Object.keys(JSON.parse(health.body)).sort(), ['ok', 'rateLimit'])
  })

  test('connect without a host is 503', async () => {
    assert.equal(await upgradeStatus(`/v1/connect/${roomOf(newKey())}`), 503)
  })

  test('pairs host and client and carries 64 KiB each way', async () => {
    const { client, dataSock } = await pair()
    const phone = relayPipe(client)
    const pc = relayPipe(dataSock)
    const up = randomBytes(64 * 1024)
    const down = randomBytes(64 * 1024)
    await Promise.all([phone.send(up), pc.send(down)])
    assert.deepEqual(await pc.until(up.length), up)
    assert.deepEqual(await phone.until(down.length), down)
  })

  test('answers host pings', async () => {
    const host = await startHost(newKey(), nextIp())
    host.sock.ping()
    await once(host.sock, 'pong')
  })

  test('rejects accept from another key', async () => {
    const ip = nextIp()
    const key = newKey()
    const host = await startHost(key, ip, { accept: false })
    const client = open(`/v1/connect/${roomOf(key)}`, { ip })
    await client.ready
    await waitFor(() => host.opens.length === 1)
    assert.equal(await upgradeStatus(`/v1/accept/${host.opens[0]}`, { key: newKey(), ip }), 404)
  })

  test('client close closes the data socket', async () => {
    const { client, dataSock } = await pair()
    client.close()
    await dataSock.closed
  })

  test('a second host replaces the first and drops its pairs', async () => {
    const { ip, key, host, client, dataSock } = await pair()
    await startHost(key, ip)
    assert.equal((await host.sock.closed).code, 4001)
    assert.equal((await client.closed).code, 4001)
    assert.equal((await dataSock.closed).code, 4001)
  })

  test('host close drops unpaired clients', async () => {
    const ip = nextIp()
    const key = newKey()
    const host = await startHost(key, ip, { accept: false })
    const client = open(`/v1/connect/${roomOf(key)}`, { ip })
    await client.ready
    await waitFor(() => host.opens.length === 1)
    host.sock.close()
    assert.equal((await client.closed).code, 4503)
  })

  test('text after ready closes both sides', async () => {
    const { client, dataSock } = await pair()
    client.send('hello')
    assert.equal((await client.closed).code, 4400)
    assert.equal((await dataSock.closed).code, 4400)
  })

  test('forwards a full frame and rejects a larger one', async () => {
    const { client, dataSock } = await pair()
    const full = data(randomBytes(16384))
    const forwarded = nextMessage(dataSock)
    client.send(full)
    const { msg, isBinary } = await forwarded
    assert.ok(isBinary)
    assert.deepEqual(msg, full)
    client.send(Buffer.alloc(16386))
    assert.equal((await client.closed).code, 1009)
    assert.equal((await dataSock.closed).code, 1009)
  })

  test('closes both sides when a sender overruns the window', async () => {
    const { client, dataSock } = await pair()
    for (let i = 0; i < 17; i++) client.send(data(randomBytes(16384)))
    assert.equal((await client.closed).code, 4400)
    assert.equal((await dataSock.closed).code, 4400)
  })

  test('rejects acks beyond the window or beyond unacked data', async () => {
    const first = await pair()
    first.client.send(ack(WINDOW + 1))
    assert.equal((await first.client.closed).code, 4400)
    assert.equal((await first.dataSock.closed).code, 4400)

    const second = await pair()
    const pc = relayPipe(second.dataSock)
    second.client.send(ack(100))
    await second.client.closed
    assert.equal(pc.violation, 'protocol')
  })

  test('moves 16 MiB each way through slow receivers within the window', async () => {
    const { client, dataSock } = await pair()
    const phone = relayPipe(client, { readDelayMs: 20 })
    const pc = relayPipe(dataSock, { readDelayMs: 20 })
    const up = randomBytes(16 * MiB)
    const down = randomBytes(16 * MiB)
    const sent = Promise.all([phone.send(up), pc.send(down)])
    const [gotUp, gotDown] = await Promise.all([pc.until(up.length, 120000), phone.until(down.length, 120000)])
    await sent
    assert.ok(gotUp.equals(up))
    assert.ok(gotDown.equals(down))
    for (const side of [phone, pc]) {
      assert.ok(side.maxUnacked <= WINDOW, `maxUnacked ${side.maxUnacked}`)
      assert.ok(side.maxFrame <= 16385, `maxFrame ${side.maxFrame}`)
    }
  })

  test('caps pending clients', async () => {
    const ip = nextIp()
    const key = newKey()
    const host = await startHost(key, ip, { accept: false })
    for (let i = 0; i < 8; i++) assert.equal(await upgradeStatus(`/v1/connect/${roomOf(key)}`, { ip }), 101)
    await waitFor(() => host.opens.length === 8)
    assert.equal(await upgradeStatus(`/v1/connect/${roomOf(key)}`, { ip }), 429)
  })

  test('caps clients per room', async () => {
    const ip = nextIp()
    const key = newKey()
    const host = await startHost(key, ip)
    for (let i = 0; i < 32; i++) {
      await connectClient(roomOf(key), ip)
      await host.nextData()
    }
    assert.equal(await upgradeStatus(`/v1/connect/${roomOf(key)}`, { ip }), 429)
  })
})

describe('relay without rate limiting bindings', () => {
  after(async () => {
    closeAll()
    await stopWrangler(server)
  })
  afterEach(closeAll)

  test('fails closed in required mode', async () => {
    server = await startWrangler(8798, 'required', 'test/wrangler.noratelimit.jsonc')
    assert.deepEqual(JSON.parse((await get('/v1/health')).body), { ok: false, rateLimit: false })
    const key = newKey()
    for (const [path, opts] of [
      ['/v1/host', { key }],
      [`/v1/connect/${roomOf(key)}`, {}],
      [`/v1/accept/${'A'.repeat(22)}`, { key }]
    ]) {
      const sock = open(path, opts)
      const err = await sock.ready.then(() => null, (e) => e)
      assert.equal(err?.status, 503, path)
      assert.equal(err.body, 'rate limiting unavailable')
    }
    await stopWrangler(server)
  })

  test('the room still limits host registrations on its own', async () => {
    server = await startWrangler(8798, 'off', 'test/wrangler.noratelimit.jsonc')
    assert.deepEqual(JSON.parse((await get('/v1/health')).body), { ok: true, rateLimit: false })
    const key = newKey()
    for (let i = 0; i < 10; i++) assert.equal(await upgradeStatus('/v1/host', { key }), 101)
    assert.equal(await upgradeStatus('/v1/host', { key }), 429)
  })
})

// Smoke test for a deployed relay: node scripts/smoke.mjs wss://fask-relay.<sub>.workers.dev
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { data, relayPipe } from '../test/framing.mjs'

const relayUrl = process.argv[2]
if (!relayUrl || !/^wss?:\/\/[^/]+$/.test(relayUrl)) {
  console.error('usage: npm run smoke -- wss://<relay-host>')
  process.exit(1)
}
const httpUrl = relayUrl.replace(/^ws/, 'http')
const sockets = []

function fail(reason) {
  console.error(`FAIL: ${reason}`)
  for (const sock of sockets) sock.terminate()
  process.exit(1)
}

function open(path, key) {
  const sock = new WebSocket(`${relayUrl}${path}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {})
  sock.on('error', () => {})
  sockets.push(sock)
  sock.ready = new Promise((resolve, reject) => {
    sock.once('unexpected-response', (req, res) => {
      res.socket.on('error', () => {})
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }))
      req.destroy()
      res.socket.destroy()
    })
    sock.once('open', resolve)
    sock.once('error', reject)
  })
  // Resolve on the relay's close frame (ws receiver internals) rather than waiting for TCP teardown.
  sock.closed = new Promise((resolve) => {
    sock.once('close', resolve)
    sock.once('open', () => sock._receiver.once('conclude', resolve))
  })
  return sock
}

const health = await fetch(`${httpUrl}/v1/health`).then((r) => r.json(), (e) => fail(`health: ${e.message}`))
console.log(`health: ok=${health.ok} rateLimit=${health.rateLimit}`)
if (health.rateLimit !== true) {
  console.error('RATE LIMITING UNAVAILABLE — relay running in RATE_LIMIT_MODE=off')
  process.exit(2)
}
if (health.ok !== true) fail('health is not ok')

const key = randomBytes(32).toString('base64url')
const room = createHash('sha256').update(key).digest('base64url')

const early = open(`/v1/connect/${room}`)
const earlyStatus = await early.ready.then(() => 101, (e) => e.status)
if (earlyStatus !== 503) fail(`connect without host returned ${earlyStatus}, expected 503`)
console.log('no host: 503')

const host = open('/v1/host', key)
await host.ready.catch((e) => fail(`host: ${e.message}`))
const accepted = new Promise((resolve) => {
  host.on('message', (msg, isBinary) => {
    if (isBinary) return
    const dataSock = open(`/v1/accept/${JSON.parse(String(msg)).id}`, key)
    dataSock.ready.then(() => resolve(dataSock), (e) => fail(`accept: ${e.message}`))
  })
})
const client = open(`/v1/connect/${room}`)
// `ready` can arrive in the same read as the 101 response, so listen first.
const firstMessage = once(client, 'message')
await client.ready.catch((e) => fail(`connect: ${e.message}`))
const [first] = await firstMessage
if (String(first) !== 'ready') fail('client did not receive ready')
const pcSock = await accepted
console.log('host/connect/ready: ok')

const phone = relayPipe(client)
const pc = relayPipe(pcSock)
const up = randomBytes(1024 * 1024)
const down = randomBytes(1024 * 1024)
await Promise.all([phone.send(up), pc.send(down)])
const [gotUp, gotDown] = await Promise.all([pc.until(up.length), phone.until(down.length)]).catch((e) =>
  fail(`bulk: ${e.message}`)
)
if (!gotUp.equals(up) || !gotDown.equals(down)) fail('bulk data corrupted')
console.log('1 MiB each way: ok')

host.ping()
await Promise.race([
  once(host, 'pong'),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
]).catch(() => fail('no pong'))
console.log('ping/pong: ok')

// Raw frames from here on; the pipes no longer track this pair's window.
const forwarded = once(pcSock, 'message')
client.send(data(randomBytes(16384)))
const [frame] = await forwarded
if (Buffer.from(frame).length !== 16385) fail('16385-byte frame was not forwarded intact')
client.send(Buffer.alloc(16386))
const code = await client.closed
if (code !== 1009) fail(`16386-byte frame closed with ${code}, expected 1009`)
console.log('frame limits: ok')

for (const sock of sockets) sock.terminate()
console.log('PASS')
process.exit(0)

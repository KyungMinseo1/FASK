// Smoke test for a deployed relay: node scripts/smoke.mjs wss://fask-relay.<sub>.workers.dev
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { relayPipe } from '../test/framing.mjs'
import { open, pair, sendFrame } from './relay-client.mjs'

const relayUrl = process.argv[2]
if (!relayUrl || !/^wss?:\/\/[^/]+$/.test(relayUrl)) {
  console.error('usage: npm run smoke -- wss://<relay-host>')
  process.exit(1)
}
const sockets = []
const track = (...socks) => sockets.push(...socks)

function fail(reason) {
  console.error(`FAIL: ${reason}`)
  for (const sock of sockets) sock.terminate()
  process.exit(1)
}

const health = await fetch(`${relayUrl.replace(/^ws/, 'http')}/v1/health`).then(
  (r) => r.json(),
  (e) => fail(`health: ${e.message}`)
)
console.log(`health: ok=${health.ok} rateLimit=${health.rateLimit}`)
if (health.rateLimit !== true) {
  console.error('RATE LIMITING UNAVAILABLE — relay running in RATE_LIMIT_MODE=off')
  process.exit(2)
}
if (health.ok !== true) fail('health is not ok')

const lonely = randomBytes(32).toString('base64url')
const early = open(relayUrl, `/v1/connect/${createHash('sha256').update(lonely).digest('base64url')}`)
track(early)
const earlyStatus = await early.ready.then(() => 101, (e) => e.status)
if (earlyStatus !== 503) fail(`connect without host returned ${earlyStatus}, expected 503`)
console.log('no host: 503')

const bulk = await pair(relayUrl).catch((e) => fail(`host/connect/ready: ${e.message}`))
track(bulk.host, bulk.phone, bulk.pc)
console.log(`host/connect/ready: ok (permessage-deflate: ${bulk.phone.extensions || 'not negotiated'})`)

const phone = relayPipe(bulk.phone)
const pc = relayPipe(bulk.pc)
const up = randomBytes(1024 * 1024)
const down = randomBytes(1024 * 1024)
await Promise.all([phone.send(up), pc.send(down)])
const [gotUp, gotDown] = await Promise.all([pc.until(up.length), phone.until(down.length)]).catch((e) =>
  fail(`bulk: ${e.message}`)
)
if (!gotUp.equals(up) || !gotDown.equals(down)) fail('bulk data corrupted')
console.log('1 MiB each way: ok')

bulk.host.ping()
await Promise.race([
  once(bulk.host, 'pong'),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
]).catch(() => fail('no pong'))
console.log('ping/pong: ok')

// Frame limits run on fresh idle pairs: the bulk pair still has ACKs in flight, and the first message a
// busy PC socket sees after the transfer can legitimately be one of them rather than the probe frame.
const describe = (r) =>
  `sent ${r.size}B ${r.sha256.slice(0, 12)}; received ${
    r.received.map((m) => `${m.bytes}B ${m.type} t${m.frameType} ${m.sha256.slice(0, 12)}`).join(' | ') || 'nothing'
  }; closes ${r.phoneClose?.code ?? 'open'}/${r.pcClose?.code ?? 'open'}`
for (const size of [16384, 16385]) {
  const idle = await pair(relayUrl)
  track(idle.host, idle.phone, idle.pc)
  const r = await sendFrame(idle, size)
  if (!r.intact) fail(`${size}-byte frame was not forwarded intact: ${describe(r)}`)
}
const oversize = await pair(relayUrl)
track(oversize.host, oversize.phone, oversize.pc)
const rejected = await sendFrame(oversize, 16386)
if (rejected.phoneClose?.code !== 1009 || rejected.pcClose?.code !== 1009 || rejected.received.length)
  fail(`16386-byte frame was not rejected with 1009 on both sides: ${describe(rejected)}`)
console.log('frame limits: ok (16384 and 16385 intact by SHA-256, 16386 closed 1009)')

for (const sock of sockets) sock.terminate()
console.log('PASS')
process.exit(0)

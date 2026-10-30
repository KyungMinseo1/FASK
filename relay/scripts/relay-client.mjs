// Relay client helpers shared by the deploy smoke test and the frame probe.
import { createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { DATA } from '../test/framing.mjs'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Opens `path`; `ready` resolves on 101 or rejects with `.status`, `closed` resolves on the close frame. */
export function open(relayUrl, path, { key, perMessageDeflate = true } = {}) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {}
  const sock = new WebSocket(`${relayUrl}${path}`, { headers, perMessageDeflate })
  sock.on('error', () => {})
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
  // The relay's close frame decides the outcome; TCP teardown can lag well behind it.
  sock.closed = new Promise((resolve) => {
    const done = (code, reason) => resolve({ code, reason: String(reason) })
    sock.once('close', done)
    sock.once('open', () => sock._receiver.once('conclude', done))
  })
  return sock
}

/**
 * Registers a fresh host and connects one phone. The PC data socket records every message from its
 * first byte, so nothing that arrives between open and a later listener goes unseen.
 */
export async function pair(relayUrl, { perMessageDeflate = true } = {}) {
  const key = randomBytes(32).toString('base64url')
  const room = createHash('sha256').update(key).digest('base64url')
  const host = open(relayUrl, '/v1/host', { key, perMessageDeflate })
  await host.ready
  const accepted = new Promise((resolve, reject) => {
    host.once('message', (msg) => {
      const pc = open(relayUrl, `/v1/accept/${JSON.parse(String(msg)).id}`, { key, perMessageDeflate })
      pc.messages = []
      pc.on('message', (m, isBinary) => {
        const bytes = Buffer.isBuffer(m) ? m : Buffer.concat(m)
        pc.messages.push({ bytes, isBinary })
      })
      pc.ready.then(() => resolve(pc), reject)
    })
  })
  const phone = open(relayUrl, `/v1/connect/${room}`, { perMessageDeflate })
  const first = new Promise((resolve) => phone.once('message', (m) => resolve(String(m))))
  await phone.ready
  if ((await first) !== 'ready') throw new Error('phone did not receive ready')
  return { key, room, host, phone, pc: await accepted }
}

/**
 * Sends one DATA frame of `size` bytes (type byte included) phone→PC on an otherwise idle pair and
 * reports what the PC side saw, matched by SHA-256, plus how both sides closed within `waitMs`.
 */
export async function sendFrame({ phone, pc }, size, waitMs = 3000) {
  const frame = Buffer.concat([Buffer.from([DATA]), randomBytes(size - 1)])
  const hash = sha256(frame)
  const before = pc.messages.length
  phone.send(frame)
  const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), waitMs))])
  const delivered = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (pc.messages.slice(before).some((m) => sha256(m.bytes) === hash)) {
        clearInterval(poll)
        resolve(true)
      }
    }, 5)
    setTimeout(() => clearInterval(poll), waitMs)
  })
  // Accepted frames do not close anything; rejected ones close both sides. Wait for whichever applies.
  const [phoneClose, pcClose] = await Promise.race([
    delivered.then(() => [null, null]),
    Promise.all([settle(phone.closed), settle(pc.closed)])
  ])
  const received = pc.messages.slice(before).map((m) => ({
    bytes: m.bytes.length,
    type: m.isBinary ? 'binary' : 'text',
    sha256: sha256(m.bytes),
    frameType: m.bytes[0]
  }))
  const intact = received.length === 1 && received[0].sha256 === hash && received[0].type === 'binary'
  return { size, sha256: hash, received, phoneClose, pcClose, intact }
}

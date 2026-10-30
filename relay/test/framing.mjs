// Relay data framing for Node test clients: DATA = 0x00 + payload, ACK = 0x01 + uint32 BE credit.
export const DATA = 0
export const ACK = 1
export const CHUNK = 16384
export const WINDOW = 262144
export const ACK_EVERY = 65536
export const MAX_FRAME = 16385

export const data = (payload) => Buffer.concat([Buffer.from([DATA]), payload])

export function ack(n) {
  const frame = Buffer.alloc(5)
  frame[0] = ACK
  frame.writeUInt32BE(n, 1)
  return frame
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Credit-window endpoint over an open relay WebSocket (phone side after `ready`, PC side after open).
 * The receiver credits bytes only after its simulated sink has consumed them, `readDelayMs` per 64 KiB.
 */
export function relayPipe(ws, { readDelayMs = 0 } = {}) {
  let unacked = 0
  let maxUnacked = 0
  let maxFrame = 0
  let receivedUnacked = 0
  let credit = 0
  let consumed = 0
  let sink = Promise.resolve()
  let closed = null
  const waiters = []
  const received = []
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve()
  }
  const violate = (reason) => {
    pipe.violation = reason
    ws.close(4400, reason)
  }
  ws.on('close', (code) => {
    closed = code
    wake()
  })
  ws.on('message', (msg, isBinary) => {
    if (!isBinary) return violate('protocol')
    const frame = Buffer.isBuffer(msg) ? msg : Buffer.concat(msg)
    maxFrame = Math.max(maxFrame, frame.length)
    if (frame[0] === DATA && frame.length > 1) {
      const payload = Buffer.from(frame.subarray(1))
      receivedUnacked += payload.length
      if (receivedUnacked > WINDOW) return violate('window')
      sink = sink.then(async () => {
        const boundary = Math.floor((consumed + payload.length) / ACK_EVERY) !== Math.floor(consumed / ACK_EVERY)
        if (readDelayMs && boundary) await sleep(readDelayMs)
        received.push(payload)
        consumed += payload.length
        receivedUnacked -= payload.length
        credit += payload.length
        if (credit >= ACK_EVERY && closed === null) {
          ws.send(ack(credit))
          credit = 0
        }
      })
    } else if (frame[0] === ACK && frame.length === 5) {
      const n = frame.readUInt32BE(1)
      if (n < 1 || n > unacked) return violate('protocol')
      unacked -= n
      wake()
    } else violate('protocol')
  })
  const pipe = {
    violation: '',
    received,
    get bytes() {
      return consumed
    },
    get maxUnacked() {
      return maxUnacked
    },
    get maxFrame() {
      return maxFrame
    },
    async send(buf) {
      for (let off = 0; off < buf.length; off += CHUNK) {
        const slice = buf.subarray(off, off + CHUNK)
        while (unacked + slice.length > WINDOW) {
          if (closed !== null) throw new Error(`relay closed ${closed}`)
          await new Promise((resolve) => waiters.push(resolve))
        }
        if (closed !== null) throw new Error(`relay closed ${closed}`)
        unacked += slice.length
        maxUnacked = Math.max(maxUnacked, unacked)
        maxFrame = Math.max(maxFrame, slice.length + 1)
        ws.send(data(slice))
      }
    },
    /** Resolves once `n` payload bytes reached the sink. */
    async until(n, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs
      while (consumed < n) {
        if (Date.now() > deadline) throw new Error(`received ${consumed}/${n} bytes`)
        await sleep(5)
      }
      return Buffer.concat(received)
    }
  }
  return pipe
}

// Frame-size diagnostics: node scripts/probe-frames.mjs wss://fask-relay.<sub>.workers.dev
// For each size, with and without offering permessage-deflate, a fresh idle pair sends one DATA frame
// phone→PC and records the negotiated extension, what the PC received (size, type, SHA-256) and close codes.
import { pair, sendFrame } from './relay-client.mjs'

const SIZES = [16384, 16385, 16386, 32768, 65536]
const relayUrl = process.argv[2]
if (!relayUrl || !/^wss?:\/\/[^/]+$/.test(relayUrl)) {
  console.error('usage: node scripts/probe-frames.mjs wss://<relay-host>')
  process.exit(1)
}

const rows = []
for (const perMessageDeflate of [true, false]) {
  for (const size of SIZES) {
    const sockets = await pair(relayUrl, { perMessageDeflate })
    const r = await sendFrame(sockets, size)
    const total = r.received.reduce((n, m) => n + m.bytes, 0)
    const verdict = r.intact
      ? 'intact'
      : r.phoneClose?.code === 1009 && !r.received.length
        ? 'rejected 1009'
        : r.received.length > 1 && total === size
          ? 'split'
          : r.received.some((m) => m.bytes === size)
            ? 'corrupted'
            : 'missing'
    rows.push({
      deflate: perMessageDeflate ? 'offered' : 'off',
      negotiated: `${sockets.phone.extensions || '-'} / ${sockets.pc.extensions || '-'}`,
      sent: size,
      sentSha: r.sha256.slice(0, 12),
      received: r.received.map((m) => `${m.bytes}B ${m.type} t${m.frameType} ${m.sha256.slice(0, 12)}`).join(' | ') || '-',
      phoneClose: r.phoneClose ? `${r.phoneClose.code} ${r.phoneClose.reason}` : 'open',
      pcClose: r.pcClose ? `${r.pcClose.code} ${r.pcClose.reason}` : 'open',
      verdict
    })
    for (const s of [sockets.host, sockets.phone, sockets.pc]) s.terminate()
  }
}
console.table(rows)
const bad = rows.filter((r) => r.verdict !== (r.sent <= 16385 ? 'intact' : 'rejected 1009'))
console.log(bad.length ? `UNEXPECTED: ${bad.length} row(s)` : 'all sizes behave as specified')
process.exit(bad.length ? 1 : 0)

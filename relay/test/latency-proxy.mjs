// TCP proxy that delays every chunk by a one-way latency, preserving order, so local `wrangler dev`
// runs see in-flight frames the way a real Cloudflare path does. `delayMs` may be a function of the
// first request line, e.g. to slow only phone connections the way an extra hop to the room does.
import { createConnection, createServer } from 'node:net'

export async function startLatencyProxy(targetPort, delayMs) {
  const sockets = new Set()
  const relayDelayed = (from, to, delay) => {
    from.on('data', (chunk) => setTimeout(() => to.writable && to.write(chunk), delay))
    from.on('end', () => setTimeout(() => to.end(), delay))
    from.on('error', () => to.destroy())
    from.on('close', () => setTimeout(() => to.destroy(), delay))
  }
  const server = createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.once('data', (head) => {
      const delay = typeof delayMs === 'function' ? delayMs(head.toString('latin1').split('\r\n')[0]) : delayMs
      const upstream = createConnection({ host: '127.0.0.1', port: targetPort })
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      setTimeout(() => upstream.write(head), delay)
      relayDelayed(client, upstream, delay)
      relayDelayed(upstream, client, delay)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      })
  }
}

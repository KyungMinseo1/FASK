import { parentPort, workerData } from 'node:worker_threads'
import * as webp from '@jsquash/webp/encode'

export interface WebpJob {
  id: string
  width: number
  height: number
  bgra: ArrayBuffer
}
export type WebpReply = { id: string; webp: ArrayBuffer } | { id: string; error: string }

// The published typings omit init's precompiled-module overload and use the DOM ImageData type.
const init = webp.init as unknown as (module: WebAssembly.Module) => Promise<unknown>
const encode = webp.default as unknown as (
  image: { data: Uint8ClampedArray; width: number; height: number; colorSpace: 'srgb' },
  options: { quality: number }
) => Promise<ArrayBuffer>

// The main thread compiles the wasm (it can read inside asar); this worker only instantiates it.
const wasm: WebAssembly.Module = workerData.wasm
let ready: Promise<unknown> | null = null
if (!parentPort) throw new Error('webp-worker must run in a worker thread')
const port = parentPort
port.on('message', async (job: WebpJob) => {
  try {
    ready ??= init(wasm)
    await ready
    // Electron bitmaps are BGRA; the encoder wants RGBA.
    const pixels = new Uint8ClampedArray(job.bgra)
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i]
      pixels[i] = pixels[i + 2]
      pixels[i + 2] = b
    }
    const out = await encode(
      { data: pixels, width: job.width, height: job.height, colorSpace: 'srgb' },
      { quality: 80 }
    )
    port.postMessage({ id: job.id, webp: out } satisfies WebpReply, [out])
  } catch (e) {
    port.postMessage({
      id: job.id,
      error: e instanceof Error ? e.message : String(e)
    } satisfies WebpReply)
  }
})

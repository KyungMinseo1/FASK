import { nativeImage } from 'electron'
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { PersonalStore } from './personal-store'
import type { WebpJob, WebpReply } from './webp-worker'

const MAX_WIDTH = 1600
const IDLE_MS = 30_000

// Generates the WebP copies the viewer loads; originals stay untouched for AI requests and backups.
export class DisplayImages {
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private running = false
  private closed = false
  private worker: Worker | null = null
  private wasm: Promise<WebAssembly.Module> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private pending: {
    id: string
    resolve: (webp: ArrayBuffer) => void
    reject: (e: Error) => void
  } | null = null

  constructor(
    private readonly store: PersonalStore,
    private readonly wasmPath: string,
    private readonly workerPath: string
  ) {}

  ensure(id: string): void {
    if (this.closed || this.queued.has(id)) return
    try {
      if (existsSync(this.store.displayPath(id)) || !existsSync(this.store.imagePath(id))) return
    } catch {
      return
    }
    this.queue.push(id)
    this.queued.add(id)
    void this.pump()
  }

  backfill(): void {
    let files: string[]
    try {
      files = readdirSync(join(this.store.root, 'attachments'))
    } catch {
      return
    }
    const present = new Set(files)
    for (const file of files)
      if (/^[a-f0-9]{64}\.(png|jpg)$/.test(file) && !present.has(`${file}.webp`)) this.ensure(file)
  }

  async close(): Promise<void> {
    this.closed = true
    this.queue.length = 0
    this.queued.clear()
    clearTimeout(this.idleTimer ?? undefined)
    await this.stopWorker()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    clearTimeout(this.idleTimer ?? undefined)
    for (let id = this.queue.shift(); id !== undefined && !this.closed; id = this.queue.shift()) {
      try {
        await this.convert(id)
      } catch (e) {
        if (!this.closed)
          console.warn('[fask] webp display copy failed', id, e instanceof Error ? e.message : e)
      } finally {
        this.queued.delete(id)
      }
    }
    this.running = false
    if (!this.closed) this.idleTimer = setTimeout(() => void this.stopWorker(), IDLE_MS)
  }

  private async convert(id: string): Promise<void> {
    const original = this.store.imagePath(id)
    const display = this.store.displayPath(id)
    if (existsSync(display) || !existsSync(original)) return
    let image = nativeImage.createFromPath(original)
    if (image.isEmpty()) throw new Error('image could not be decoded')
    if (image.getSize().width > MAX_WIDTH)
      image = image.resize({ width: MAX_WIDTH, quality: 'good' })
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    if (bitmap.length !== width * height * 4) throw new Error('unexpected bitmap size')
    // A standalone copy, so it can be transferred without detaching Node's pooled buffer memory.
    const bgra = new Uint8Array(bitmap).buffer
    const webp = await this.encode({ id, width, height, bgra })
    // The original may have been deleted (question removed, minimal retention) while encoding.
    if (this.closed || !existsSync(original)) return
    const tmp = `${display}.tmp`
    writeFileSync(tmp, Buffer.from(webp))
    if (existsSync(original)) renameSync(tmp, display)
    else unlinkSync(tmp)
  }

  private async encode(job: WebpJob): Promise<ArrayBuffer> {
    const worker = await this.spawn()
    const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>()
    this.pending = { id: job.id, resolve, reject }
    worker.postMessage(job, [job.bgra])
    return promise
  }

  private async spawn(): Promise<Worker> {
    if (this.worker) return this.worker
    // Compiled here: the main thread can read the wasm from inside app.asar.
    this.wasm ??= WebAssembly.compile(readFileSync(this.wasmPath))
    const wasm = await this.wasm
    if (this.worker) return this.worker
    if (this.closed) throw new Error('closed')
    const worker = new Worker(this.workerPath, { workerData: { wasm } })
    worker.on('message', (reply: WebpReply) => {
      const pending = this.pending
      if (!pending || pending.id !== reply.id) return
      this.pending = null
      if ('webp' in reply) pending.resolve(reply.webp)
      else pending.reject(new Error(reply.error))
    })
    const fail = (e: Error): void => {
      if (this.worker === worker) this.worker = null
      const pending = this.pending
      this.pending = null
      pending?.reject(e)
    }
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`webp worker exited (${code})`)))
    this.worker = worker
    return worker
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }
}

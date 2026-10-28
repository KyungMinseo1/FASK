// Offline snapshot cache: AES-256-GCM envelope; the key lives in Keystore-backed secure storage
// and the PC certificate fingerprint is bound as additional data. No plaintext fallback.
import type { Snapshot } from '@desktop/preload/personal'

export interface SnapshotCache {
  epoch(): number
  save(s: Snapshot, owner: { epoch: number; fingerprint: string }): Promise<void>
  load(fingerprint: string): Promise<{ savedAt: string; snapshot: Snapshot } | null>
  clear(): Promise<void>
}
export interface SnapshotCacheIo {
  getKey(): Promise<string | null>
  setKey(v: string): Promise<void>
  removeKey(): Promise<void>
  read(): Promise<string | null>
  write(text: string): Promise<void>
  remove(): Promise<void>
}

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
const aad = (fingerprint: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`fask-snapshot-v1:${fingerprint}`)
const aesKey = (raw: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', fromB64url(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])

export function createSnapshotCache(io: SnapshotCacheIo): SnapshotCache {
  let epoch = 0
  // Every operation runs in call order; a failed step never blocks the next one.
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn)
    queue = next.catch(() => {})
    return next
  }
  const wipe = async (): Promise<void> => {
    await io.remove()
    await io.removeKey()
  }
  return {
    epoch: () => epoch,
    save: (snapshot, owner) =>
      enqueue(async () => {
        // A response from a client created before the last clear() must not recreate the cache.
        if (owner.epoch !== epoch) return
        let key = await io.getKey()
        if (!key) {
          key = toB64url(crypto.getRandomValues(new Uint8Array(32)))
          await io.setKey(key)
        }
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad(owner.fingerprint) },
          await aesKey(key),
          new TextEncoder().encode(JSON.stringify({ savedAt: new Date().toISOString(), snapshot }))
        )
        await io.write(
          JSON.stringify({ v: 1, iv: toB64url(iv), c: toB64url(new Uint8Array(ciphertext)) })
        )
      }),
    load: (fingerprint) =>
      enqueue(async () => {
        const [key, text] = [await io.getKey(), await io.read()]
        if (!key || !text) return null
        try {
          const envelope: unknown = JSON.parse(text)
          if (
            !envelope ||
            typeof envelope !== 'object' ||
            !('v' in envelope && envelope.v === 1) ||
            !('iv' in envelope && typeof envelope.iv === 'string') ||
            !('c' in envelope && typeof envelope.c === 'string')
          )
            throw new Error('unsupported cache envelope')
          const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromB64url(envelope.iv), additionalData: aad(fingerprint) },
            await aesKey(key),
            fromB64url(envelope.c)
          )
          return JSON.parse(new TextDecoder().decode(plain)) as {
            savedAt: string
            snapshot: Snapshot
          }
        } catch {
          // Tampered, foreign-PC, or unknown-version data is discarded with its key.
          await wipe()
          return null
        }
      }),
    clear() {
      epoch++
      return enqueue(wipe)
    }
  }
}

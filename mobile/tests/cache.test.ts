import { describe, expect, it } from 'vitest'
import type { Snapshot } from '@desktop/preload/personal'
import { createSnapshotCache, type SnapshotCacheIo } from '../src/cache'

const fp1 = 'A'.repeat(43),
  fp2 = 'B'.repeat(43)
const snapshot = { activeProfileId: 'p', questions: [{ id: '비밀 질문 원문' }] } as unknown as Snapshot

function memoryIo(): SnapshotCacheIo & { state: { key: string | null; file: string | null } } {
  const state = { key: null as string | null, file: null as string | null }
  return {
    state,
    getKey: async () => state.key,
    setKey: async (v) => void (state.key = v),
    removeKey: async () => void (state.key = null),
    read: async () => state.file,
    write: async (t) => void (state.file = t),
    remove: async () => void (state.file = null)
  }
}

describe('snapshot cache', () => {
  it('round-trips and never stores plaintext', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    expect((await cache.load(fp1))?.snapshot).toEqual(snapshot)
    expect(io.state.file).not.toContain('비밀 질문 원문')
    expect(io.state.file).not.toContain('activeProfileId')
  })
  it('tampered ciphertext is discarded together with its key', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    const envelope = JSON.parse(io.state.file!)
    envelope.c = (envelope.c[0] === 'A' ? 'B' : 'A') + envelope.c.slice(1)
    io.state.file = JSON.stringify(envelope)
    expect(await cache.load(fp1)).toBeNull()
    expect(io.state).toEqual({ key: null, file: null })
  })
  it('a different key cannot decrypt', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    io.state.key = 'Q'.repeat(43)
    expect(await cache.load(fp1)).toBeNull()
  })
  it('an unknown envelope version is rejected', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    io.state.file = JSON.stringify({ ...JSON.parse(io.state.file!), v: 2 })
    expect(await cache.load(fp1)).toBeNull()
  })
  it('every save uses a fresh IV', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    const first = JSON.parse(io.state.file!).iv
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    expect(JSON.parse(io.state.file!).iv).not.toBe(first)
  })
  it('another PC fingerprint fails authentication and wipes the cache', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    expect(await cache.load(fp2)).toBeNull()
    expect(io.state).toEqual({ key: null, file: null })
  })
  it('a save from before clear() writes nothing', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    const epoch = cache.epoch()
    await cache.clear()
    await cache.save(snapshot, { epoch, fingerprint: fp1 })
    expect(io.state).toEqual({ key: null, file: null })
  })
  it('save then clear run in call order and end empty', async () => {
    const io = memoryIo()
    const cache = createSnapshotCache(io)
    await cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    const saving = cache.save(snapshot, { epoch: cache.epoch(), fingerprint: fp1 })
    const clearing = cache.clear()
    await Promise.all([saving, clearing])
    expect(io.state).toEqual({ key: null, file: null })
    expect(await cache.load(fp1)).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPairing, savePairing } from '../src/storage'
import { RELAY_ADDRESS } from '../src/transport'

const items = new Map<string, string>()
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => void items.set(key, value),
    removeItem: async (key: string) => void items.delete(key)
  }
}))
vi.mock('@capacitor/filesystem', () => ({ Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' }, Filesystem: {} }))

const base = { port: 47615, fingerprint: 'F'.repeat(43), token: 'T'.repeat(43) }
const relay = { url: 'wss://relay.example.dev', room: 'R'.repeat(43) }

describe('loadPairing', () => {
  beforeEach(() => items.clear())

  it('keeps a valid relay pairing', async () => {
    const pairing = { ...base, addresses: ['10.0.0.1', RELAY_ADDRESS], relay }
    await savePairing(pairing)
    expect(await loadPairing()).toEqual(pairing)
  })

  it.each([
    ['relay address without relay', { ...base, addresses: ['10.0.0.1', RELAY_ADDRESS] }],
    ['relay without relay address', { ...base, addresses: ['10.0.0.1'], relay }],
    ['non-normalized relay url', { ...base, addresses: [RELAY_ADDRESS], relay: { ...relay, url: 'wss://relay.example.dev/' } }],
    ['short relay room', { ...base, addresses: [RELAY_ADDRESS], relay: { ...relay, room: 'short' } }]
  ])('treats %s as unpaired', async (_name, stored) => {
    items.set('fask.pairing', JSON.stringify(stored))
    expect(await loadPairing()).toBeNull()
  })
})

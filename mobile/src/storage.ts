// Device storage: pairing secrets and the cache key in Keystore-backed secure storage;
// the encrypted snapshot in app-private files. Nothing secret goes to localStorage.
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { createSnapshotCache } from './cache'
import type { Pairing } from './transport'

const PAIRING_KEY = 'fask.pairing'
const CACHE_KEY = 'fask.cacheKey'
const CACHE_FILE = { path: 'snapshot.enc', directory: Directory.Data }

export async function loadPairing(): Promise<Pairing | null> {
  const text = await SecureStorage.getItem(PAIRING_KEY)
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    if (
      value &&
      typeof value === 'object' &&
      'addresses' in value &&
      Array.isArray(value.addresses) &&
      value.addresses.every((a) => typeof a === 'string') &&
      'port' in value &&
      typeof value.port === 'number' &&
      'fingerprint' in value &&
      typeof value.fingerprint === 'string' &&
      'token' in value &&
      typeof value.token === 'string'
    )
      return {
        addresses: value.addresses,
        port: value.port,
        fingerprint: value.fingerprint,
        token: value.token
      }
  } catch {
    /* Corrupt entry: treated as unpaired. */
  }
  return null
}
export const savePairing = (p: Pairing): Promise<void> =>
  SecureStorage.setItem(PAIRING_KEY, JSON.stringify(p))
export const clearPairing = (): Promise<void> => SecureStorage.removeItem(PAIRING_KEY)

export const snapshotCache = createSnapshotCache({
  getKey: () => SecureStorage.getItem(CACHE_KEY),
  setKey: (v) => SecureStorage.setItem(CACHE_KEY, v),
  removeKey: () => SecureStorage.removeItem(CACHE_KEY),
  async read() {
    try {
      const { data } = await Filesystem.readFile({ ...CACHE_FILE, encoding: Encoding.UTF8 })
      return typeof data === 'string' ? data : await data.text()
    } catch {
      return null
    }
  },
  async write(text) {
    await Filesystem.writeFile({ ...CACHE_FILE, data: text, encoding: Encoding.UTF8 })
  },
  async remove() {
    await Filesystem.deleteFile(CACHE_FILE).catch(() => {})
  }
})

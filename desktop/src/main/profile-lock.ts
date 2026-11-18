import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions
} from 'node:crypto'
import { promisify } from 'node:util'
import { t } from '../shared/i18n'
import type { PersonalStore } from './personal-store'

export const PROFILE_LOCKED = '프로필이 잠겨 있습니다. PC에서 잠금을 해제해 주세요.'
export const PIN_FORMAT = 'PIN은 숫자 6~12자리로 입력해 주세요.'
export const PIN_WRONG = 'PIN이 맞지 않습니다.'
export const PIN_WAIT = '{{sec}}초 후에 다시 시도해 주세요.'
const KEYSTORE = 'OS 키 저장소를 사용할 수 없습니다.'
const PIN = /^\d{6,12}$/
const SECRETS = ['key', 'jev-key'] as const

export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(v: string): Buffer
  decryptString(b: Buffer): string
}

type Kdf = { N: number; r: number; p: number }
type PinRecord = { v: 1; salt: string; check: string }
type Fail = { count: number; until: number }

const derive = promisify(scrypt) as (
  pin: string,
  salt: Buffer,
  len: number,
  options: ScryptOptions
) => Promise<Buffer>

/** The only access path to the profile's model/Jev keys; with a PIN they are also sealed by a PIN-derived key. */
export class ProfileLock {
  private kek: Buffer | null = null
  constructor(
    private readonly store: PersonalStore,
    private readonly cipher: Cipher,
    private readonly kdf: Kdf = { N: 2 ** 17, r: 8, p: 1 },
    private readonly now: () => number = Date.now
  ) {}

  get hasPin(): boolean {
    return !!this.store.pref('profile-pin')
  }
  get locked(): boolean {
    return this.hasPin && this.kek === null
  }
  state(): { hasPin: boolean; locked: boolean; retryAt: number | null } {
    const fail = this.fail()
    return {
      hasPin: this.hasPin,
      locked: this.locked,
      retryAt: fail && fail.until > this.now() ? fail.until : null
    }
  }
  async unlock(pin: string): Promise<void> {
    if (!this.hasPin) return
    const kek = await this.verify(pin)
    this.kek?.fill(0)
    this.kek = kek
  }
  lock(): void {
    this.kek?.fill(0)
    this.kek = null
  }
  async setPin(current: string | undefined, next: string): Promise<void> {
    if (typeof next !== 'string' || !PIN.test(next)) throw new Error(PIN_FORMAT)
    this.requireKeystore()
    const old = this.hasPin ? await this.verify(current ?? '') : null
    const plain = SECRETS.map((name) => this.unwrap(name, old))
    const salt = randomBytes(16)
    const derived = await this.derive(next, salt)
    const kek = Buffer.from(derived.subarray(0, 32))
    const record: PinRecord = {
      v: 1,
      salt: salt.toString('base64'),
      check: createHash('sha256').update(derived.subarray(32, 64)).digest('base64')
    }
    derived.fill(0)
    this.transaction(() => {
      this.store.pref(
        'profile-pin',
        this.cipher.encryptString(JSON.stringify(record)).toString('base64')
      )
      SECRETS.forEach((name, i) => this.wrap(name, plain[i], kek))
    })
    old?.fill(0)
    this.kek?.fill(0)
    this.kek = kek
  }
  async removePin(current: string): Promise<void> {
    if (!this.hasPin) return
    this.requireKeystore()
    const old = await this.verify(current)
    const plain = SECRETS.map((name) => this.unwrap(name, old))
    this.transaction(() => {
      this.delete('profile-pin')
      SECRETS.forEach((name, i) => this.wrap(name, plain[i], null))
    })
    old.fill(0)
    this.lock()
  }
  reset(): void {
    this.delete('profile-pin')
    this.delete('profile-pin-fail')
    for (const name of SECRETS) this.delete(this.prefName(name))
    this.lock()
  }
  readSecret(name: 'key' | 'jev-key'): string {
    if (this.locked) throw new Error(PROFILE_LOCKED)
    return this.unwrap(name, this.hasPin ? this.kek : null)
  }
  writeSecret(name: 'key' | 'jev-key', value: string): void {
    if (this.locked) throw new Error(PROFILE_LOCKED)
    if (value) this.requireKeystore()
    this.wrap(name, value, this.hasPin ? this.kek : null)
  }

  private prefName(name: 'key' | 'jev-key'): string {
    return `${name}:${this.store.active}`
  }
  private requireKeystore(): void {
    if (!this.cipher.isEncryptionAvailable()) throw new Error(KEYSTORE)
  }
  private delete(key: string): void {
    this.store.db.prepare('DELETE FROM preferences WHERE key=?').run(key)
  }
  private transaction(fn: () => void): void {
    this.store.db.exec('BEGIN')
    try {
      fn()
      this.store.db.exec('COMMIT')
    } catch (error) {
      this.store.db.exec('ROLLBACK')
      throw error
    }
  }
  private derive(pin: string, salt: Buffer): Promise<Buffer> {
    return derive(pin, salt, 64, { ...this.kdf, maxmem: 256 * 1024 * 1024 })
  }
  private fail(): Fail | null {
    const raw = this.store.pref('profile-pin-fail')
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as Partial<Fail>
      return { count: Number(v.count) || 0, until: Number(v.until) || 0 }
    } catch {
      return null
    }
  }
  /** Checks a PIN against the stored record with attempt throttling; returns the key-encryption key. */
  private async verify(pin: string): Promise<Buffer> {
    const fail = this.fail()
    const now = this.now()
    if (fail && now < fail.until)
      throw new Error(t(PIN_WAIT, { sec: Math.ceil((fail.until - now) / 1000) }))
    this.requireKeystore()
    const record = JSON.parse(
      this.cipher.decryptString(Buffer.from(this.store.pref('profile-pin'), 'base64'))
    ) as PinRecord
    const derived = await this.derive(String(pin), Buffer.from(record.salt, 'base64'))
    const check = createHash('sha256').update(derived.subarray(32, 64)).digest()
    const expected = Buffer.from(record.check, 'base64')
    if (check.length !== expected.length || !timingSafeEqual(check, expected)) {
      derived.fill(0)
      const count = (fail?.count ?? 0) + 1
      const until =
        count >= 5 ? this.now() + Math.min(30_000 * 2 ** (count - 5), 900_000) : 0
      this.store.pref('profile-pin-fail', JSON.stringify({ count, until }))
      throw new Error(PIN_WRONG)
    }
    this.delete('profile-pin-fail')
    const kek = Buffer.from(derived.subarray(0, 32))
    derived.fill(0)
    return kek
  }
  private unwrap(name: 'key' | 'jev-key', kek: Buffer | null): string {
    const stored = this.store.pref(this.prefName(name))
    if (!stored) return ''
    this.requireKeystore()
    const outer = this.cipher.decryptString(Buffer.from(stored, 'base64'))
    if (!kek) return outer
    const raw = Buffer.from(outer, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', kek, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }
  private wrap(name: 'key' | 'jev-key', value: string, kek: Buffer | null): void {
    if (!value) {
      this.delete(this.prefName(name))
      return
    }
    let inner = value
    if (kek) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', kek, iv)
      const ct = Buffer.concat([c.update(value, 'utf8'), c.final()])
      inner = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
    }
    this.store.pref(this.prefName(name), this.cipher.encryptString(inner).toString('base64'))
  }
}

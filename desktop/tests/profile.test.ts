import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonalStore } from '../src/main/personal-store'
import { PIN_FORMAT, PIN_WRONG, PROFILE_LOCKED, ProfileLock, type Cipher } from '../src/main/profile-lock'
import { defaultAvatar } from '../src/shared/avatar'
import type { Project, Question, Workspace } from '../src/preload/personal'

const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(Buffer.from(v, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}
const kdf = { N: 2 ** 10, r: 8, p: 1 }

function withStore(fn: (store: PersonalStore, path: string) => void | Promise<void>) {
  return async () => {
    const path = mkdtempSync(join(tmpdir(), 'fask-profile-'))
    const store = new PersonalStore(path)
    try {
      await fn(store, path)
    } finally {
      store.close()
      rmSync(path, { recursive: true, force: true })
    }
  }
}

/** A pre-1.2.2 extra profile: profile record, switched active, with its own workspace and project. */
function legacyProfile(store: PersonalStore, name: string): string {
  const id = store.put('profile', '*', { id: `legacy-${name}`, name })
  store.pref('active', id)
  store.create('project', '첫 프로젝트', store.create('workspace', '내 워크스페이스'))
  return id
}

const rawPref = (store: PersonalStore, key: string): string | undefined =>
  store.db.prepare('SELECT value FROM preferences WHERE key=?').get(key)?.value as string | undefined

describe('profile', () => {
  test(
    'profile() fills a default avatar; updateProfile validates name and avatar',
    withStore((store) => {
      const p = store.profile()
      assert.deepEqual(p.avatar, defaultAvatar(p.id))
      assert.throws(() => store.updateProfile({ name: 'a'.repeat(41) }), /1~40자/)
      assert.throws(() => store.updateProfile({ name: '   ' }), /1~40자/)
      assert.throws(
        () => store.updateProfile({ avatar: { style: 'bogus', seed: 'x', background: 'navy' } as never }),
        /요청 형식/
      )
      const avatar = { style: 'orbit', seed: 'abc', background: 'lavender' } as const
      store.updateProfile({ name: '  새 이름 ', avatar })
      assert.equal(store.profile().name, '새 이름')
      assert.deepEqual(store.profile().avatar, avatar)
      assert.equal(store.snapshot().profile.id, p.id)
    })
  )

  test(
    'ProfileLock wraps keys with the PIN, throttles guesses and restores the plain format',
    withStore(async (store) => {
      let clock = 1_000_000
      const lock = new ProfileLock(store, cipher, kdf, () => clock)
      const keyName = `key:${store.active}`
      lock.writeSecret('key', 'sk-model')
      lock.writeSecret('jev-key', 'sk-jev')
      const before = rawPref(store, keyName)
      assert.equal(lock.readSecret('key'), 'sk-model')
      await assert.rejects(lock.setPin(undefined, '12345'), { message: PIN_FORMAT })

      await lock.setPin(undefined, '123456')
      assert.equal(lock.hasPin, true)
      assert.equal(lock.locked, false)
      assert.notEqual(rawPref(store, keyName), before)
      assert.equal(lock.readSecret('key'), 'sk-model')

      lock.lock()
      assert.equal(lock.locked, true)
      assert.throws(() => lock.readSecret('key'), { message: PROFILE_LOCKED })
      assert.throws(() => lock.writeSecret('key', 'x'), { message: PROFILE_LOCKED })

      for (let i = 0; i < 5; i++) await assert.rejects(lock.unlock('000000'), { message: PIN_WRONG })
      await assert.rejects(lock.unlock('123456'), /초 후에 다시 시도/)
      assert.ok(lock.state().retryAt)
      clock += 30_001
      await lock.unlock('123456')
      assert.equal(lock.locked, false)
      assert.equal(lock.state().retryAt, null)
      assert.equal(lock.readSecret('key'), 'sk-model')
      assert.equal(lock.readSecret('jev-key'), 'sk-jev')

      await assert.rejects(lock.removePin('999999'), { message: PIN_WRONG })
      await lock.removePin('123456')
      assert.equal(lock.hasPin, false)
      assert.equal(cipher.decryptString(Buffer.from(rawPref(store, keyName)!, 'base64')), 'sk-model')
      assert.equal(lock.readSecret('jev-key'), 'sk-jev')

      await lock.setPin(undefined, '654321')
      lock.reset()
      assert.equal(lock.hasPin, false)
      assert.equal(lock.readSecret('key'), '')
      assert.equal(rawPref(store, keyName), undefined)
    })
  )

  test(
    'mergeProfiles moves hidden profiles into the active one',
    withStore((store, path) => {
      const original = store.active
      const second = legacyProfile(store, '둘째')
      const project = store.list<Project>('project')[0]
      store.put<Question>('question', second, {
        id: 'merged-q',
        projectId: project.id,
        title: '고유벡터 질문',
        turns: [{ id: 't', raw: '고유벡터가 뭐야?', sent: '고유벡터가 뭐야?', answer: '답' }],
        conceptIds: [],
        createdAt: new Date().toISOString(),
        memo: '',
        important: false
      } as unknown as Question)
      store.pref(`settings:${second}`, '{}')
      store.pref(`key:${second}`, 'x')
      store.pref(`jev-key:${second}`, 'y')
      store.pref('active', original)
      assert.deepEqual(store.mergeInfo()?.others, [{ name: '둘째', workspaces: 1, questions: 1 }])

      store.mergeProfiles()
      assert.equal(store.list('profile', '*').length, 1)
      assert.equal(store.mergeInfo(), null)
      assert.deepEqual(
        store.list<Workspace>('workspace').map((w) => w.name).sort(),
        ['내 워크스페이스', '내 워크스페이스 (둘째)']
      )
      assert.deepEqual(
        store.search(store.active, '고유벡터', { kinds: ['question'], limit: 5 }).map((h) => h.id),
        ['merged-q']
      )
      for (const key of [`settings:${second}`, `key:${second}`, `jev-key:${second}`])
        assert.equal(rawPref(store, key), undefined)
      assert.ok(existsSync(join(path, 'fask-pre-profile-merge.sqlite')))
    })
  )

  test(
    'usage sums tokens per day and source',
    withStore((store) => {
      store.addUsage('model', 10, 5, 0, false)
      store.addUsage('model', 10, 5, 0, false)
      store.addUsage('jev', 3, 1, 0.01, false)
      const days = store.usage()
      assert.equal(days.length, 1)
      const { day, ...rest } = days[0]
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/)
      assert.deepEqual(rest, { model: 30, jev: 4, jevCost: 0.01, estimated: false })
    })
  )
})

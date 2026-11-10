const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')

const source = readFileSync(join(__dirname, 'check-release.cjs'), 'utf8')

// Run the real guard with repository snapshots, without touching local Git state.
function check(options = {}) {
  const messages = []
  const gradle = (version, code) => `versionName "${version}"\nversionCode ${code}`
  const execute = (args) => {
    if (args[0] === 'merge-base') return { status: options.offBranch ? 1 : 0 }
    if (args[0] === 'show') {
      return options.legacy ? { status: 128 } : { status: 0, stdout: gradle('1.1.0', options.previousCode ?? 1) }
    }
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
  }
  const child = {
    execFileSync(command, args) {
      assert.equal(command, 'git')
      if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'commit' : options.wrongCommit ? 'other' : 'commit'
      if (args[0] === 'tag') return options.tags ?? 'v1.1.0\nv1.1.1'
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    },
    spawnSync(command, args) {
      assert.equal(command, 'git')
      return execute(args)
    }
  }
  const fs = {
    readFileSync(path) {
      if (path === 'CHANGELOG.md') return options.changelog ?? '## [Unreleased]\n\n## [1.1.1] - 2026-10-29\n\n- 질문 이동\n'
      if (path.endsWith('build.gradle')) return gradle(options.androidVersion ?? '1.1.1', options.code ?? 2)
      const version = path === 'mobile/package.json' ? options.mobileVersion ?? '1.1.1' : '1.1.1'
      if (path.endsWith('package-lock.json')) {
        return JSON.stringify({ version: options.lockVersion ?? version, packages: { '': { version } } })
      }
      return JSON.stringify({ version })
    }
  }
  try {
    runInNewContext(source, {
      require: (name) => {
        if (name === 'node:child_process') return child
        if (name === 'node:fs') return fs
        if (name === './changelog.cjs') return require('./changelog.cjs')
        throw new Error(`Unexpected module: ${name}`)
      },
      console: { error: (message) => messages.push(message), log() {} },
      process: {
        env: { RELEASE_TAG: options.tag ?? 'v1.1.1', DEFAULT_BRANCH: options.branch ?? 'main' },
        exit: (code) => { throw new Error(`exit ${code}`) }
      }
    })
    return { ok: true, message: '' }
  } catch (error) {
    if (error.message !== 'exit 1') throw error
    return { ok: false, message: messages.join('\n') }
  }
}

test('matching versions on default branch pass', () => assert.equal(check().ok, true))
test('legacy tags without Android are allowed', () => assert.equal(check({ legacy: true, code: 1 }).ok, true))
test('first version tag is allowed', () => assert.equal(check({ tags: 'v1.1.1', code: 1 }).ok, true))
for (const [name, options, message] of [
  ['malformed tag', { tag: 'v1.1.1-rc.1' }, /vMAJOR/],
  ['missing branch', { branch: '' }, /default branch is missing/],
  ['off-branch commit', { offBranch: true }, /included in the default branch/],
  ['moved tag', { wrongCommit: true }, /checked-out commit/],
  ['package mismatch', { mobileVersion: '1.1.0' }, /mobile package.json/],
  ['lockfile mismatch', { lockVersion: '1.1.0' }, /package-lock.json/],
  ['Android version mismatch', { androidVersion: '1.1.0' }, /versionName/],
  ['invalid Android code', { code: 0 }, /versionCode/],
  ['unchanged Android code', { code: 1 }, /greater than 1/],
  ['decreased Android code', { previousCode: 3 }, /greater than 3/],
  ['version downgrade', { tags: 'v1.2.0\nv1.1.1' }, /newer than reachable tag/],
  ['missing release notes', { changelog: '## [Unreleased]\n\n- 질문 이동\n\n## [1.1.0] - 2026-10-28\n\n- 테마\n' }, /## \[1\.1\.1\]/],
  ['empty release notes', { changelog: '## [1.1.1] - 2026-10-29\n\n## [1.1.0] - 2026-10-28\n\n- 테마\n' }, /## \[1\.1\.1\]/]
]) {
  test(`rejects ${name}`, () => {
    const result = check(options)
    assert.equal(result.ok, false)
    assert.match(result.message, message)
  })
}

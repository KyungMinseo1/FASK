const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('bump synchronizes all versions and passes the real release guard', () => {
  const root = mkdtempSync(join(__dirname, '../../.version-bump-test-'))
  try {
    for (const path of ['desktop', 'mobile', 'mobile/android/app', '.github/scripts']) mkdirSync(join(root, path), { recursive: true })
    for (const directory of ['desktop', 'mobile']) {
      writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name: directory, version: '1.1.1' }, null, 2) + '\n')
      writeFileSync(join(root, directory, 'package-lock.json'), JSON.stringify({ version: '1.1.1', packages: { '': { version: '1.1.1' } } }, null, 2) + '\n')
    }
    const gradlePath = join(root, 'mobile/android/app/build.gradle')
    writeFileSync(gradlePath, 'versionCode 2\nversionName "1.1.1"\n')
    const changelogPath = join(root, 'CHANGELOG.md')
    writeFileSync(changelogPath, '# Changelog\n\n## [Unreleased]\n\n## [1.1.1] - 2026-10-29\n\n- 질문 이동\n')
    for (const name of ['version-bump.cjs', 'check-release.cjs', 'changelog.cjs']) cpSync(join(__dirname, name), join(root, '.github/scripts', name))
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'previous release')
    git(root, 'tag', 'v1.1.1')

    // Match the repository's current drift: npm packages advanced, Android did not.
    for (const directory of ['desktop', 'mobile']) {
      for (const name of ['package.json', 'package-lock.json']) {
        const path = join(root, directory, name)
        writeFileSync(path, readFileSync(path, 'utf8').replaceAll('1.1.1', '1.1.2'))
      }
    }
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'advance npm packages')
    const run = (target) => spawnSync(process.execPath, [join(root, '.github/scripts/version-bump.cjs'), target], { cwd: root, encoding: 'utf8' })
    // Without notes the bump refuses before touching any version file.
    const refused = run('1.1.2')
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /Unreleased/)
    assert.match(readFileSync(gradlePath, 'utf8'), /versionCode 2/)
    writeFileSync(changelogPath, readFileSync(changelogPath, 'utf8').replace('## [Unreleased]\n', '## [Unreleased]\n\n- 복사 기능\n'))
    assert.equal(run('1.1.2').status, 0)
    assert.match(readFileSync(changelogPath, 'utf8'), /^## \[Unreleased\]\n\n## \[1\.1\.2\] - \d{4}-\d{2}-\d{2}\n\n- 복사 기능\n\n## \[1\.1\.1\]/m)
    for (const directory of ['desktop', 'mobile']) {
      const pkg = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))
      const lock = JSON.parse(readFileSync(join(root, directory, 'package-lock.json'), 'utf8'))
      assert.equal(pkg.version, '1.1.2')
      assert.equal(lock.version, '1.1.2')
      assert.equal(lock.packages[''].version, '1.1.2')
    }
    assert.match(readFileSync(gradlePath, 'utf8'), /versionCode 3\nversionName "1\.1\.2"/)
    assert.equal(run('1.1.2').status, 0)
    assert.match(readFileSync(gradlePath, 'utf8'), /versionCode 3/)
    assert.equal(readFileSync(changelogPath, 'utf8').match(/## \[1\.1\.2\]/g).length, 1)
    assert.notEqual(run('1.1.1').status, 0)
    assert.notEqual(run('1.1.2-rc.1').status, 0)
    writeFileSync(gradlePath, readFileSync(gradlePath, 'utf8').replace('versionCode 3', 'versionCode 2'))
    assert.equal(run('1.1.2').status, 0)
    assert.match(readFileSync(gradlePath, 'utf8'), /versionCode 3/)

    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'prepare release')
    git(root, 'tag', 'v1.1.2')
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const guard = spawnSync(process.execPath, [join(root, '.github/scripts/check-release.cjs')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: 'v1.1.2', DEFAULT_BRANCH: 'main' }
    })
    assert.equal(guard.status, 0, guard.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

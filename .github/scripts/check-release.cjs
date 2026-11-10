const { execFileSync, spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { releaseNotes } = require('./changelog.cjs')

function fail(message) {
  console.error(message)
  process.exit(1)
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const tag = process.env.RELEASE_TAG || ''
const branch = process.env.DEFAULT_BRANCH || ''
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
  fail('Release tag must be vMAJOR.MINOR.PATCH, for example v1.1.1')
}
if (!branch) fail('Repository default branch is missing')
const commit = git('rev-parse', 'HEAD')
if (git('rev-parse', `${tag}^{commit}`) !== commit) fail('Tag does not point to the checked-out commit')
if (spawnSync('git', ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`]).status !== 0) {
  fail(`Release commit must be included in the default branch (${branch})`)
}
const version = tag.slice(1)
for (const directory of ['desktop', 'mobile']) {
  const pkg = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'))
  const lock = JSON.parse(readFileSync(`${directory}/package-lock.json`, 'utf8'))
  if (pkg.version !== version || lock.version !== version || lock.packages[''].version !== version) {
    fail(`${directory} package.json and package-lock.json must match ${version}`)
  }
}
function androidVersion(text) {
  return {
    name: text.match(/\bversionName\s+["']([^"']+)["']/)?.[1],
    code: Number(text.match(/\bversionCode\s+(\d+)/)?.[1])
  }
}
const android = androidVersion(readFileSync('mobile/android/app/build.gradle', 'utf8'))
if (android.name !== version || !Number.isSafeInteger(android.code) || android.code < 1 || android.code > 2100000000) {
  fail('Android versionName must match the tag and versionCode must be a valid positive integer')
}
try {
  releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version)
} catch (error) {
  fail(error.message)
}
// Compare with every earlier version tag reachable from this commit. Legacy tags
// without an Android app are allowed; an existing Android version must increase.
const current = version.split('.').map(Number)
for (const previous of git('tag', '--merged', 'HEAD', '--list', 'v*').split('\n').filter(Boolean)) {
  const match = previous.match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!match) continue
  const parts = match.slice(1).map(Number)
  const different = parts.findIndex((part, index) => part !== current[index])
  if (different < 0) continue
  if (parts[different] > current[different]) fail(`Release version must be newer than reachable tag ${previous}`)
  const old = spawnSync('git', ['show', `${previous}:mobile/android/app/build.gradle`], { encoding: 'utf8' })
  if (old.status !== 0) continue
  const oldCode = androidVersion(old.stdout).code
  if (!Number.isSafeInteger(oldCode)) fail(`Cannot read Android versionCode at ${previous}`)
  if (android.code <= oldCode) fail(`Android versionCode must be greater than ${oldCode} from ${previous}`)
}
console.log(`Release validated: ${tag}, Android versionCode ${android.code}, default branch ${branch}`)

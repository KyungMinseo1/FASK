const { execFileSync, spawnSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { promoteUnreleased } = require('./changelog.cjs')

const root = join(__dirname, '../..')
const version = process.argv[2]
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const parts = semver.exec(version || '')?.slice(1).map(Number)
if (process.argv.length !== 3 || !parts || parts.some((part) => !Number.isSafeInteger(part))) {
  throw new Error('Usage: npm run version:bump -- MAJOR.MINOR.PATCH')
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

const files = ['desktop/package.json', 'desktop/package-lock.json', 'mobile/package.json', 'mobile/package-lock.json']
const jsonFiles = files.map((path) => {
  const fullPath = join(root, path)
  const original = readFileSync(fullPath, 'utf8')
  const data = JSON.parse(original)
  const current = data.version
  if (!semver.test(current) || compare(parts, current.split('.').map(Number)) < 0) {
    throw new Error(`${path}: target version must be at least ${current}`)
  }
  if (path.endsWith('package-lock.json') && data.packages?.['']?.version !== current) {
    throw new Error(`${path}: root package version does not match lockfile version`)
  }
  data.version = version
  if (path.endsWith('package-lock.json')) data.packages[''].version = version
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const content = JSON.stringify(data, null, 2).replace(/\n/g, newline) + (original.endsWith('\n') ? newline : '')
  return { fullPath, original, content, current }
})

const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
const nextChangelog = promoteUnreleased(changelog, version, new Date().toLocaleDateString('sv-SE'))

const gradlePath = join(root, 'mobile/android/app/build.gradle')
const gradle = readFileSync(gradlePath, 'utf8')
const nameMatch = gradle.match(/\bversionName\s+["']([^"']+)["']/)
const codeMatch = gradle.match(/\bversionCode\s+(\d+)/)
if (!nameMatch || !codeMatch) throw new Error('Cannot read Android versionName or versionCode')
const currentCode = Number(codeMatch[1])
if (!Number.isSafeInteger(currentCode) || currentCode < 1) throw new Error('Invalid Android versionCode')

let maxCode = currentCode
let maxPreviousCode = 0
const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
for (const tag of tags) {
  const previous = semver.exec(tag.slice(1))?.slice(1).map(Number)
  if (!tag.startsWith('v') || !previous) continue
  if (compare(parts, previous) <= 0) throw new Error(`Version must be newer than reachable tag ${tag}`)
  const old = spawnSync('git', ['show', `${tag}:mobile/android/app/build.gradle`], { cwd: root, encoding: 'utf8' })
  if (old.status !== 0) continue // Tags before the Android app existed.
  const oldCode = Number(old.stdout.match(/\bversionCode\s+(\d+)/)?.[1])
  if (!Number.isSafeInteger(oldCode) || oldCode < 1) throw new Error(`Cannot read Android versionCode at ${tag}`)
  maxPreviousCode = Math.max(maxPreviousCode, oldCode)
  maxCode = Math.max(maxCode, oldCode)
}

const alreadySynced = jsonFiles.every(({ current }) => current === version) &&
  nameMatch[1] === version && currentCode > maxPreviousCode && currentCode <= 2100000000
if (alreadySynced) {
  if (nextChangelog !== changelog) writeFileSync(changelogPath, nextChangelog)
  console.log(`Version ${version} is already synchronized`)
  process.exit(0)
}
const nextCode = maxCode + 1
if (nextCode > 2100000000) throw new Error('Android versionCode exceeds the release limit')
const nextGradle = gradle.replace(nameMatch[0], nameMatch[0].replace(nameMatch[1], version))
  .replace(codeMatch[0], `versionCode ${nextCode}`)
for (const { fullPath, original, content } of jsonFiles) {
  if (content !== original) writeFileSync(fullPath, content)
}
if (nextGradle !== gradle) writeFileSync(gradlePath, nextGradle)
if (nextChangelog !== changelog) writeFileSync(changelogPath, nextChangelog)
console.log(`Version ${version}, Android versionCode ${nextCode}`)

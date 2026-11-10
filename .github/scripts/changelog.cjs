// CHANGELOG.md follows Keep a Changelog: `## [Unreleased]`, then `## [X.Y.Z] - YYYY-MM-DD` sections.
function sections(text) {
  const headings = [...text.matchAll(/^## \[([^\]]+)\].*$/gm)]
  return headings.map((match, index) => ({
    name: match[1],
    start: match.index,
    headingEnd: match.index + match[0].length,
    end: index + 1 < headings.length ? headings[index + 1].index : text.length
  }))
}

function releaseNotes(text, version) {
  const section = sections(text).find(({ name }) => name === version)
  const body = section && text.slice(section.headingEnd, section.end).trim()
  if (!body) throw new Error(`CHANGELOG.md: add release notes under "## [${version}]"`)
  return body
}

// Turn the Unreleased notes into the given version's section; no-op when that section exists.
function promoteUnreleased(text, version, date) {
  const all = sections(text)
  if (all.some(({ name }) => name === version)) return text
  const unreleased = all.find(({ name }) => name === 'Unreleased')
  if (!unreleased || !text.slice(unreleased.headingEnd, unreleased.end).trim()) {
    throw new Error(`CHANGELOG.md: write the ${version} notes under "## [Unreleased]" first`)
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return text.slice(0, unreleased.start) + `## [Unreleased]${newline}${newline}## [${version}] - ${date}` +
    text.slice(unreleased.headingEnd)
}

module.exports = { releaseNotes, promoteUnreleased }

if (require.main === module) {
  const tag = process.argv[2] || ''
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../CHANGELOG.md'), 'utf8')
  process.stdout.write(releaseNotes(text, tag.replace(/^v/, '')) + '\n')
}

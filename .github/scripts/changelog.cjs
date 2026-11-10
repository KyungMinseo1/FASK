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

// Release page body: CHANGELOG notes, then download links and install notes for the uploaded files.
function releaseBody(notes, { repo, tag, windows, android }) {
  const link = (path) => {
    const name = path.split('/').pop()
    return `[${name}](https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)})`
  }
  return `${notes}

## Download

| Platform | File |
|---|---|
| Windows | ${link(windows)} |
| Android | ${link(android)} |

> [!NOTE]
> The Windows installer is not code-signed, so SmartScreen may warn you: choose **More info → Run anyway**.
> On Android, allow installing unknown apps for the browser or file manager that opens the APK.
`
}

module.exports = { releaseNotes, promoteUnreleased, releaseBody }

// Usage: node changelog.cjs vX.Y.Z [WINDOWS_INSTALLER ANDROID_APK]; with files, GITHUB_REPOSITORY is required.
if (require.main === module) {
  const [tag = '', windows, android] = process.argv.slice(2)
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../CHANGELOG.md'), 'utf8')
  const notes = releaseNotes(text, tag.replace(/^v/, ''))
  if (!windows) {
    process.stdout.write(notes + '\n')
  } else {
    const repo = process.env.GITHUB_REPOSITORY
    if (!repo || !android) throw new Error('Release body needs GITHUB_REPOSITORY, a Windows installer and an Android APK')
    process.stdout.write(releaseBody(notes, { repo, tag, windows, android }))
  }
}

const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const dir = mkdtempSync(join(tmpdir(), 'fask-tests-'))
try {
  const output = join(dir, 'tests.cjs')
  buildSync({
    entryPoints: [join(__dirname, 'personal.test.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}

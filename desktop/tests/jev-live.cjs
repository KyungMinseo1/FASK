const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const dir = mkdtempSync(join(tmpdir(), 'fask-jev-live-'))
try {
  const output = join(dir, 'jev-live.cjs')
  buildSync({
    entryPoints: [join(__dirname, 'jev-live.test.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    loader: { '.md': 'text' }
  })
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}

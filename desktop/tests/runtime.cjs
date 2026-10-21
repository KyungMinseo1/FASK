const { spawnSync } = require('node:child_process')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const output = join(__dirname, 'runtime-result.json')
const code = `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({node:process.versions.node,sqlite:typeof require('node:sqlite').DatabaseSync}))`
const result = spawnSync(require('electron'), ['-e', code], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8'
})
console.log(
  JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr
  })
)
if (existsSync(output)) console.log(readFileSync(output, 'utf8'))
else process.exitCode = 1

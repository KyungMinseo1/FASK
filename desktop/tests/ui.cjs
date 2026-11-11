// Question UI layout E2E: bundles the main-process modules, then drives the built app.
require('./bundle.cjs')
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const result = spawnSync(require('electron'), [join(__dirname, 'electron-question-ui.cjs')], {
  env,
  encoding: 'utf8',
  timeout: 120000
})
console.log(
  JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stderr: result.stderr?.slice(-3000)
  })
)
const resultPath = join(__dirname, 'ui-result.json')
if (existsSync(resultPath)) console.log(readFileSync(resultPath, 'utf8'))
if (result.status !== 0) process.exitCode = result.status ?? 1

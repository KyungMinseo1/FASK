// Slow-device E2E: bundles the main-process modules, then drives the built app under CPU throttling.
require('./bundle.cjs')
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [join(__dirname, 'electron-slow.cjs')], {
  env,
  encoding: 'utf8',
  timeout: 240000
})
console.log(
  JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stderr: result.stderr?.slice(-3000)
  })
)
const resultPath = join(__dirname, 'slow-result.json')
if (existsSync(resultPath)) console.log(readFileSync(resultPath, 'utf8'))
if (result.status !== 0) process.exitCode = result.status ?? 1

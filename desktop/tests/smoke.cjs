require('./bundle.cjs')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [join(__dirname, 'electron-smoke.cjs')], {
  env,
  encoding: 'utf8',
  timeout: 60000
})
console.log(
  JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stderr: result.stderr?.slice(-3000)
  })
)
if (result.status === 0) {
  const restart = spawnSync(require('electron'), [join(__dirname, 'electron-restart.cjs')], {
    env,
    encoding: 'utf8',
    timeout: 20000
  })
  console.log(
    JSON.stringify({
      restartStatus: restart.status,
      error: restart.error?.message,
      stderr: restart.stderr?.slice(-1000)
    })
  )
  if (restart.status !== 0) process.exitCode = restart.status ?? 1
}
console.log(readFileSync(join(__dirname, 'smoke-result.json'), 'utf8'))
if (result.status !== 0) process.exitCode = result.status ?? 1

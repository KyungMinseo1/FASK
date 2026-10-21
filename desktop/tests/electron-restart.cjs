const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { registerPersonal } = require('./.smoke/personal.cjs')
const reportPath = join(__dirname, 'smoke-result.json')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
app.setPath('userData', report.restart.userData)
app.whenReady().then(async () => {
  try {
    const main = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    const personal = registerPersonal(report.restart.dataDir, () => main)
    personal.capture.open(report.restart.projectId, true)
    const overlay = personal.capture.overlay
    await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve))
    const js = (source) => overlay.webContents.executeJavaScript(source)
    for (let i = 0; i < 50; i++) {
      if (await js("!!document.querySelector('.composer')")) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(await js("!!document.querySelector('.composer')"), true)
    const snapshot = await js('window.fask.snapshot()')
    assert.equal(snapshot.questions.length, 1)
    assert.deepEqual(snapshot.recentQuestions, {})
    assert.equal(await js("!!document.querySelector('.recent-question,.live-answer')"), false)
    assert.equal(await js(`document.querySelector('[aria-label="화면 캡처 포함"]').checked`), true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const geometry = await js(
      "JSON.stringify([...document.querySelectorAll('.overlay-toolbar,.overlay-panel')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"
    )
    assert.equal(geometry, report.restart.geometry)
    report.checks.push(
      'full app restart clears recent conversation while keeping records, capture choice and both positions'
    )
    report.restart.success = true
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    app.exit(0)
  } catch (error) {
    report.success = false
    report.error = error.stack
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    app.exit(1)
  }
})

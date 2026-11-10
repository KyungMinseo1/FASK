// Isolated OS-fixture integration coverage. This is not physical multi-monitor/DPI evidence.
const { app, BrowserWindow, nativeImage, screen, desktopCapturer, ipcMain, dialog } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { PersonalStore } = require('./.smoke/store.cjs')
const { registerPersonal } = require('./.smoke/personal.cjs')

const resultPath = join(__dirname, 'monitor-recovery-result.json')
const screenshots = join(__dirname, 'screenshots')
const report = { fixture: 'Mock OS displays and harmless generated pixels; production capture, IPC, preload and renderer', checks: [], screenshots: [], consoleErrors: [] }
mkdirSync(screenshots, { recursive: true })
app.setPath('userData', mkdtempSync(join(tmpdir(), 'fask-monitor-recovery-ui-')))
const checkpoint = (phase) => {
  report.phase = phase
  writeFileSync(resultPath, JSON.stringify(report, null, 2))
}
const check = (label) => { report.checks.push(label); checkpoint(label) }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(predicate, label) {
  const end = Date.now() + 3500
  while (Date.now() < end) {
    if (await predicate()) return
    await delay(15)
  }
  throw new Error(`Timeout: ${label}`)
}
const run = (window, source) => window.webContents.executeJavaScript(source)
const frames = (window) => run(window, 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
const literal = JSON.stringify
const button = (text, root = 'document') => `[...${root}.querySelectorAll('button')].find(b=>{const c=b.cloneNode(true);c.querySelectorAll('kbd').forEach(k=>k.remove());return c.textContent.trim()===${literal(text)}})`
const settingsRoot = ':is(.settings-page,.settings-modal)'
const captureSelect = `${settingsRoot} select:has(option[value=""])`
const endpointInput = `${settingsRoot} input[placeholder="http://127.0.0.1:8317/v1"]`
const modelInput = `${settingsRoot} input[list="local-models"]`
const passwordInput = `${settingsRoot} input[type=password]`
const change = (window, selector, value) => run(window, `(()=>{const e=document.querySelector(${literal(selector)});if(!e)throw Error(${literal(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement:e.tagName==='SELECT'?HTMLSelectElement:HTMLInputElement;Object.getOwnPropertyDescriptor(p.prototype,'value').set.call(e,${literal(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
const click = (window, text, root) => run(window, `${button(text, root)}.click()`)
const navRoot = "document.querySelector('.settings-nav')"
const nav = async (window, label) => {
  await wait(() => run(window, `!!${navRoot}&&${button(label, navRoot)}!==undefined`), `settings nav ${label}`)
  await click(window, label, navRoot)
}
const hasInk = (window) => run(window, `(()=>{const c=document.querySelector('canvas');return !!c&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)})()`)
checkpoint('starting')

app.whenReady().then(async () => {
  const restore = []
  const handlers = new Map()
  const replacedHandlers = new Set()
  let personal, server, win
  let exitCode = 0
  try {
    const realDisplay = screen.getPrimaryDisplay()
    const fixture = (id, bounds = realDisplay.bounds) => ({ ...realDisplay, id, label: `Fixture ${id}`, bounds: { ...bounds }, workArea: { ...bounds }, scaleFactor: 1 })
    const d0 = fixture(0), d1 = fixture(810001), d2 = fixture(810002)
    const staleId = 899999
    let displays = [d0]
    let cursor = { x: d0.bounds.x + 10, y: d0.bounds.y + 10 }
    let sourceCalls = 0, primaryCalls = 0, nearestCalls = 0, sourceHook = null, permissionFailure = false
    const override = (target, key, value) => {
      const previous = target[key]
      target[key] = value
      restore.push(() => { target[key] = previous })
    }
    override(screen, 'getAllDisplays', () => displays.map(d => ({ ...d, bounds: { ...d.bounds } })))
    override(screen, 'getPrimaryDisplay', () => { primaryCalls++; return displays[0] ?? d0 })
    override(screen, 'getDisplayNearestPoint', () => { nearestCalls++; return displays[0] ?? d0 })
    override(screen, 'getCursorScreenPoint', () => cursor)
    const images = new Map()
    const background = (width, height) => {
      const key = `${width}x${height}`
      if (!images.has(key)) {
        const bytes = Buffer.alloc(width * height * 4)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          bytes[i] = x % 251; bytes[i + 1] = y % 251; bytes[i + 2] = 73; bytes[i + 3] = 255
        }
        images.set(key, nativeImage.createFromBitmap(bytes, { width, height }))
      }
      return images.get(key)
    }
    override(desktopCapturer, 'getSources', async () => {
      sourceCalls++
      if (permissionFailure) throw new Error('monitor fixture permission denied')
      const sources = displays.map(d => ({ id: `screen:${d.id}:0`, name: d.label, display_id: String(d.id), thumbnail: background(d.bounds.width, d.bounds.height), appIcon: null }))
      if (sourceHook) { const hook = sourceHook; sourceHook = null; await hook() }
      return sources
    })
    const errorBoxes = []
    override(dialog, 'showErrorBox', (title, message) => errorBoxes.push({ title, message }))
    const requests = { ask: [], refine: [], title: [], other: [] }
    let failProvider = false
    server = createServer((req, res) => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-fast' }, { id: 'test-deep' }] })); return }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const input = JSON.parse(body)
          const system = String(input.messages?.[0]?.content ?? '')
          const kind = system.includes('대화 제목 생성') ? 'title' : system.includes('다듬어라') ? 'refine' : system.includes('JSON만 출력') ? 'other' : 'ask'
          requests[kind].push(input)
          if (kind === 'ask' && failProvider) { failProvider = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'monitor fixture provider failure' } })); return }
          const content = kind === 'refine' ? '복구 검증 다듬은 질문' : kind === 'title' ? '"복구 검증"' : kind === 'other' ? '{}' : 'monitor recovery answer'
          res.setHeader('Content-Type', 'text/event-stream')
          res.end(`data: ${JSON.stringify({ model: 'test-deep', choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)
        } catch (error) { res.writeHead(500); res.end(String(error)) }
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const dataDir = mkdtempSync(join(tmpdir(), 'fask-monitor-recovery-db-'))
    const seed = new PersonalStore(dataDir)
    const project = seed.list('project')[0]
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`
    const oldRegion = { displayId: staleId, screenWidth: d0.bounds.width, screenHeight: d0.bounds.height, rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } }
    seed.saveSettings({ ...seed.settings(), endpoint, model: 'test-fast', models: ['test-fast', 'test-deep'], routing: 'manual', organize: false, autoTitle: false, refine: false, memoryScope: 'off', retention: 'preserve', displayId: staleId, regions: [oldRegion] })
    const createdAt = new Date().toISOString()
    seed.put('question', seed.active, { id: 'monitor-seed', projectId: project.id, createdAt, title: 'monitor recovery seed', turns: [{ id: 'monitor-seed-turn', createdAt, raw: 'seed', refined: '', sent: 'seed', answer: 'seed answer', model: 'test-fast', actualModel: 'test-fast', status: 'completed', complexity: 'simple', routingReason: '', attachment: null, documents: [], error: '', revision: 0 }], conceptIds: [], suggestions: [], memo: '', important: false })
    seed.close()
    win = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { preload: join(__dirname, '../out/preload/index.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const watch = window => window.webContents.on('console-message', (_e, level, message) => { if (level === 3) report.consoleErrors.push({ phase: report.phase, message }) })
    watch(win)
    const nativeHandle = ipcMain.handle
    ipcMain.handle = function (channel, handler) { handlers.set(channel, handler); return nativeHandle.call(this, channel, handler) }
    try { personal = registerPersonal(dataDir, () => win) } finally { ipcMain.handle = nativeHandle }
    const capture = personal.capture
    const store = capture.store
    const settings = () => store.settings()
    const setSettings = patch => { store.saveSettings({ ...settings(), ...patch }); capture.changed() }
    const intercept = (channel, handler) => {
      assert.ok(handlers.has(channel), `registered ${channel}`)
      ipcMain.removeHandler(channel)
      nativeHandle.call(ipcMain, channel, handler)
      replacedHandlers.add(channel)
    }
    const restoreHandler = channel => { ipcMain.removeHandler(channel); nativeHandle.call(ipcMain, channel, handlers.get(channel)); replacedHandlers.delete(channel) }
    const screenshot = async (name, window = win) => {
      window.webContents.invalidate()
      const image = await window.webContents.capturePage()
      const filename = `monitor-recovery-${name}.png`
      writeFileSync(join(screenshots, filename), image.toPNG())
      report.screenshots.push(filename)
    }
    const selected = window => run(window, `document.querySelector(${literal(captureSelect)})?.value`)
    const readySettings = async (window, value) => {
      await wait(() => run(window, `!!document.querySelector(${literal(captureSelect)})&&!document.querySelector(${literal(captureSelect)}).disabled`), 'capture settings ready')
      if (value !== undefined) assert.equal(await selected(window), String(value))
    }
    const closeSettings = async (window = win) => { await run(window, "document.querySelector('.settings-back,.settings-modal header button').click()"); await wait(() => run(window, "!document.querySelector('.settings-page,.settings-modal')"), 'settings closes') }
    const openSettings = async () => {
      await run(win, "[...document.querySelectorAll('.fask-sidebar button')].find(b=>b.textContent.includes('설정')).click()")
      await wait(() => run(win, "!!document.querySelector('.settings-nav')"), 'settings page opens')
      await nav(win, '화면 캡처')
      await readySettings(win)
    }
    const refresh = async (window = win) => { await click(window, '모니터 다시 검색'); await readySettings(window) }
    const editorReady = async () => {
      await wait(() => !!capture.editor, 'editor created')
      const editor = capture.editor
      watch(editor)
      await wait(() => run(editor, "!!document.querySelector('.capture-box')"), 'editor renders')
      await frames(editor)
      return editor
    }
    const edit = async id => { assert.equal((await capture.edit(id)).ok, true); return editorReady() }
    const cancel = async editor => {
      await run(editor, 'requestAnimationFrame(()=>window.fask.closeCaptureEditor());true'); await wait(() => !capture.editor, 'editor cancel')
      for (const w of [win, capture.overlay]) if (w && !w.isDestroyed() && await run(w, `!!document.querySelector(${literal(captureSelect)})`)) await readySettings(w)
    }
    const apply = async (editor, duplicate = false) => {
      await run(editor, `requestAnimationFrame(()=>{${button('적용')}.click();${duplicate ? "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));" : ''}});true`)
      await wait(() => !capture.editor, 'editor applies')
    }
    // Exercise the real context bridge across StrictMode-style subscribe/off/subscribe.
    await win.loadURL('data:text/html,<title>Preload recovery subscription fixture</title>')
    const setupPulls = []
    intercept('personal:take-capture-setup', (event) => {
      const issue = handlers.get('personal:take-capture-setup')(event)
      return new Promise(resolve => setupPulls.push({ issue, resolve }))
    })
    personal.quickQuestion()
    await run(win, "window.__oldSetupCalls=0;window.__newSetupCalls=0;const off=window.fask.onCaptureSetupRequired(()=>window.__oldSetupCalls++);off();window.__offSetup=window.fask.onCaptureSetupRequired(()=>window.__newSetupCalls++);true")
    await wait(() => setupPulls.length === 2, 'preload subscription replay pulls queued')
    assert.equal(setupPulls[0].issue.reason, 'display-missing')
    assert.equal(setupPulls[1].issue, null)
    setupPulls[1].resolve(null)
    setupPulls[0].resolve(setupPulls[0].issue)
    await wait(() => run(win, 'window.__newSetupCalls===1'), 'consumed setup reply delivered to current subscriber')
    assert.equal(await run(win, 'window.__oldSetupCalls'), 0)
    await run(win, 'window.__offSetup();true')
    restoreHandler('personal:take-capture-setup')
    check('actual production preload replays a consumed startup response to the current subscriber, never an unsubscribed callback')
    // Request is queued before any renderer listener or initial snapshot exists.
    personal.quickQuestion()
    assert.equal(capture.overlay, null)
    await win.loadFile(join(__dirname, '../out/renderer/index.html'))
    await readySettings(win, 0)
    assert.equal(await run(win, `document.activeElement===document.querySelector(${literal(captureSelect)})`), true)
    assert.equal(await run(win, `document.querySelector(${literal(settingsRoot)}).textContent.includes('모니터 연결이 달라졌습니다.')`), true)
    check('pre-subscription shortcut issue is consumed by production preload initial pull; sole display ID 0 is focused and selected')
    const savedBefore = settings()
    for (let i = 0; i < 2; i++) {
      await click(win, '캡처 영역 설정')
      const editor = await editorReady()
      assert.equal(capture.preview.display.id, 0)
      assert.equal(capture.preview.region, null)
      personal.quickQuestion()
      assert.equal(capture.editor, editor)
      await cancel(editor)
      assert.deepEqual(settings(), savedBefore)
    }
    check('sole stale monitor opens/cancels twice with matching displayed/preview ID and no settings writes')
    displays = [d1, d2]
    await refresh()
    assert.equal(await selected(win), '')
    assert.equal(await run(win, `${button('캡처 영역 설정')}.disabled`), true)
    await screenshot('multiple-monitors')
    const counters = { primaryCalls, nearestCalls, sourceCalls }
    displays = []
    await refresh()
    assert.equal(await selected(win), '')
    assert.equal(await run(win, `document.querySelector(${literal(settingsRoot)}).textContent.includes('연결된 모니터가 없습니다.')`), true)
    assert.equal(await run(win, `${button('캡처 영역 설정')}.disabled`), true)
    assert.deepEqual(capture.open(project.id), { ok: false, reason: 'no-displays' })
    assert.deepEqual(await capture.edit(staleId), { ok: false, reason: 'no-displays' })
    assert.deepEqual({ primaryCalls, nearestCalls, sourceCalls }, counters)
    check('multiple displays require explicit selection; zero displays show rescan and never query primary/nearest/capture')
    displays = [d1, d2]
    await refresh()
    // Keep actual IPC access validation, replace only response scheduling.
    const queued = []
    intercept('personal:displays', (event, ...args) => {
      handlers.get('personal:displays')(event, ...args)
      return new Promise(resolve => queued.push(resolve))
    })
    await run(win, "window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'))")
    await wait(() => queued.length === 2, 'two display requests queued')
    queued[1](capture.displays())
    await readySettings(win)
    await change(win, captureSelect, d2.id)
    queued[0]([{ id: d0.id, label: d0.label, width: d0.bounds.width, height: d0.bounds.height }])
    await frames(win)
    assert.equal(await selected(win), String(d2.id))
    assert.equal(await run(win, `document.querySelector(${literal(captureSelect)}).options.length`), 3)
    restoreHandler('personal:displays')
    intercept('personal:displays', (event, ...args) => { handlers.get('personal:displays')(event, ...args); throw new Error('monitor fixture display lookup failure') })
    await click(win, '모니터 다시 검색')
    await wait(() => run(win, `document.querySelector(${literal(settingsRoot)}).textContent.includes('monitor fixture display lookup failure')`), 'display lookup failure visible')
    assert.equal(await run(win, `${button('캡처 영역 설정')}.disabled`), true)
    restoreHandler('personal:displays')
    await refresh()
    await change(win, captureSelect, d2.id)
    await nav(win, 'AI 연결')
    await change(win, endpointInput, `${endpoint}/unsaved`)
    await change(win, modelInput, 'unsaved-model')
    await change(win, passwordInput, 'unsaved-key')
    await nav(win, '화면 캡처')
    await refresh()
    assert.equal(await selected(win), String(d2.id))
    await nav(win, 'AI 연결')
    assert.equal(await run(win, `document.querySelector(${literal(endpointInput)}).value`), `${endpoint}/unsaved`)
    assert.equal(await run(win, `document.querySelector(${literal(modelInput)}).value`), 'unsaved-model')
    assert.equal(await run(win, `document.querySelector(${literal(passwordInput)}).value`), 'unsaved-key')
    await nav(win, '화면 캡처')
    check('out-of-order display replies keep newer list and selection; manual monitor and endpoint/model/key drafts survive refresh')
    await click(win, '캡처 영역 설정')
    await cancel(await editorReady())
    assert.deepEqual(settings(), savedBefore)
    await click(win, '캡처 영역 설정')
    let editor = await editorReady()
    let savedEvents = 0
    const originalSaveRegion = capture.saveRegion
    capture.saveRegion = function (...args) { savedEvents++; return originalSaveRegion.apply(this, args) }
    restore.push(() => { capture.saveRegion = originalSaveRegion })
    await apply(editor, true)
    assert.equal(savedEvents, 1)
    assert.equal(settings().displayId, d2.id)
    assert.equal(settings().endpoint, endpoint)
    assert.equal(settings().model, 'test-fast')
    assert.equal(settings().hasKey, false)
    assert.deepEqual(settings().regions.find(r => r.displayId === staleId), oldRegion)
    const applied = settings().regions.find(r => r.displayId === d2.id)
    await readySettings(win, d2.id)
    await nav(win, 'AI 연결')
    assert.equal(await run(win, `document.querySelector(${literal(endpointInput)}).value`), `${endpoint}/unsaved`)
    await nav(win, '화면 캡처')
    await readySettings(win)
    await change(win, captureSelect, d1.id)
    // Discard AI drafts deliberately; general save must not persist the un-applied monitor.
    await nav(win, 'AI 연결')
    await change(win, endpointInput, endpoint)
    await change(win, modelInput, 'test-fast')
    await change(win, passwordInput, '')
    await click(win, '설정 저장')
    await wait(() => run(win, "!document.querySelector('.settings-page')"), 'general save closes')
    assert.equal(settings().displayId, d2.id)
    assert.deepEqual(settings().regions.find(r => r.displayId === d2.id), applied)
    check('editor Apply saves monitor and region only, preserves other monitor regions and AI drafts; Apply+Enter saves once; general save ignores unapplied monitor')
    let hides = 0
    const onHide = () => hides++
    win.show()
    win.on('hide', onHide)
    const sourcesBeforeInvalid = sourceCalls
    assert.deepEqual(await capture.edit(staleId), { ok: false, reason: 'display-selection-required' })
    assert.equal(hides, 0)
    assert.equal(capture.editor, null)
    await assert.rejects(capture.screenshot(staleId), error => error.reason === 'display-missing')
    assert.equal(sourceCalls, sourcesBeforeInvalid)
    win.removeListener('hide', onHide)
    check('invalid multi-monitor edit has zero hides/editor/writes; original screenshot rejects stale ID before desktopCapturer')
    // A candidate disappears after Settings refresh but before production edit preflight.
    await openSettings()
    await change(win, captureSelect, d1.id)
    displays = [d2]
    await click(win, '캡처 영역 설정')
    editor = await editorReady()
    assert.equal(capture.preview.display.id, d2.id)
    await cancel(editor)
    displays = [d1, d2]
    await refresh()
    await change(win, captureSelect, d1.id)
    const originalOpenEditor = handlers.get('personal:open-editor')
    intercept('personal:open-editor', (event, ...args) => { displays = [d0, d2]; return originalOpenEditor(event, ...args) })
    await click(win, '캡처 영역 설정')
    await readySettings(win)
    assert.equal(capture.editor, null)
    assert.equal(await selected(win), '')
    restoreHandler('personal:open-editor')
    assert.equal(settings().displayId, d2.id)
    check('disconnect immediately before edit uses sole candidate or requests explicit selection without saving')
    const localIssue = await run(win, `document.querySelector(${literal(`${settingsRoot} [role=alert]`)})?.textContent`)
    assert.ok(localIssue)
    displays = [d2]
    await refresh()
    await click(win, '캡처 영역 설정')
    await cancel(await editorReady())
    assert.equal(await run(win, `document.querySelector(${literal(`${settingsRoot} [role=alert]`)})?.textContent`), localIssue)
    await click(win, '캡처 영역 설정')
    await apply(await editorReady())
    await wait(() => run(win, `!document.querySelector(${literal(`${settingsRoot} [role=alert]`)})`), 'local capture reason clears after Apply')
    check('normally opened Settings retains local recovery issue after retry Cancel and clears it only after retry Apply')
    await closeSettings()
    for (const kind of ['disconnect', 'resize']) {
      displays = [d1]
      sourceHook = () => { displays = kind === 'disconnect' ? [] : [fixture(d1.id, { ...d1.bounds, width: d1.bounds.width - 40 })] }
      const result = await capture.edit(d1.id)
      assert.deepEqual(result, { ok: false, reason: kind === 'disconnect' ? 'no-displays' : 'region-changed' })
      assert.equal(capture.editor, null)
      assert.equal(capture.busy, false)
      assert.equal(win.isVisible(), true)
      assert.equal(settings().displayId, d2.id)
    }
    check('production screenshot detects in-flight disconnect and size change, produces no preview, restores window and releases busy')
    // Stale Apply is exercised through the production renderer, IPC and pending recovery delivery.
    for (const kind of ['disconnect', 'resize']) {
      displays = [d1]
      editor = await edit(d1.id)
      const before = settings()
      displays = kind === 'disconnect' ? [] : [fixture(d1.id, { ...d1.bounds, height: d1.bounds.height - 40 })]
      await click(editor, '적용')
      await wait(() => run(editor, "!!document.querySelector('.capture-error')"), 'stale Apply shows error')
      assert.equal(capture.editor, editor)
      assert.deepEqual(settings(), before)
      assert.equal(await run(editor, `${button('캡처 영역 다시 설정')}!==undefined`), true)
      await click(editor, '캡처 영역 다시 설정')
      await wait(() => !capture.editor, 'stale editor closes for recovery')
      await readySettings(win)
      assert.equal(win.isVisible(), true)
      await closeSettings()
    }
    check('disconnect/resize after preview rejects Apply without persistence and offers working return-to-Settings UI')
    displays = [d1]
    editor = await edit(d1.id)
    displays = []
    personal.quickQuestion()
    await wait(() => !capture.editor, 'shortcut closes invalid editor')
    await readySettings(win)
    await closeSettings()
    displays = [d1]
    editor = await edit(d1.id)
    intercept('personal:save-region', (event) => { assert.equal(event.sender, editor.webContents); throw new Error('monitor fixture storage failure') })
    await click(editor, '적용')
    await wait(() => run(editor, "document.querySelector('.capture-error')?.textContent.includes('monitor fixture storage failure')"), 'ordinary Apply error visible')
    assert.equal(capture.editor, editor)
    assert.equal(await run(editor, `${button('캡처 영역 다시 설정')}!==undefined`), false)
    restoreHandler('personal:save-region')
    await cancel(editor)
    check('shortcut focuses a valid editor or closes a stale editor into recovery; ordinary Apply errors remain visible without claiming setup recovery')
    displays = [d1, d2]
    setSettings({ displayId: staleId, regions: [oldRegion] })
    // Both dashboard entry points leave selected question/project in place and surface recovery.
    await wait(() => run(win, "!!document.querySelector('.project-header')"), 'dashboard ready')
    await click(win, '화면에서 질문')
    await wait(() => run(win, `${button('캡처 영역 다시 설정')}!==undefined`), 'new question recovery action')
    await click(win, '캡처 영역 다시 설정')
    await readySettings(win)
    assert.equal(await selected(win), '')
    await closeSettings()
    await run(win, "document.querySelector('.question-card').click()")
    await wait(() => run(win, "!!document.querySelector('.reply-button')"), 'question detail continuation')
    const route = await run(win, 'location.hash')
    await run(win, "document.querySelector('.reply-button').click()")
    await wait(() => run(win, `${button('캡처 영역 다시 설정')}!==undefined`), 'continue recovery action')
    // The same notice moves to the global location outside project scope.
    await run(win, "document.querySelectorAll('.breadcrumb button')[1].click()")
    await wait(() => run(win, "location.hash.includes('scope=home')"), 'home scope')
    await click(win, '캡처 영역 다시 설정')
    await readySettings(win)
    await closeSettings()
    await run(win, `location.hash=${literal(route)}`)
    await wait(() => run(win, "!!document.querySelector('.project-header')"), 'project restored')
    personal.quickQuestion()
    await readySettings(win)
    await closeSettings()
    assert.equal(capture.overlay, null)
    check('dashboard screen question, selected-question continuation, project/global notice actions and shortcut reach capture Settings without opening invalid overlay')
    // Valid binding, followed by stale binding, must retain the same renderer and Composer DOM.
    displays = [d1]
    setSettings({ displayId: d1.id, regions: [{ ...applied, displayId: d1.id }] })
    assert.equal((await run(win, `window.fask.openOverlay(${literal(project.id)},'monitor-seed')`)).ok, true)
    const overlay = capture.overlay
    watch(overlay)
    const ov = source => run(overlay, source)
    await wait(() => ov("!!document.querySelector('.composer textarea')"), 'overlay composer ready')
    await frames(overlay)
    for (const kind of ['disconnect', 'resize']) {
      displays = [d1]
      sourceHook = () => { displays = kind === 'disconnect' ? [] : [fixture(d1.id, { ...d1.bounds, height: d1.bounds.height - 40 })] }
      assert.deepEqual(await capture.question(), { ok: false, reason: kind === 'disconnect' ? 'no-displays' : 'region-changed' })
      assert.equal(capture.busy, false)
      assert.equal(overlay.isVisible(), true)
      assert.equal(requests.ask.length, 0)
    }
    displays = [d1]
    const validRegions = settings().regions
    setSettings({ regions: validRegions.map(r => ({ ...r, screenWidth: r.screenWidth - 1 })) })
    const beforeInvalidQuestion = sourceCalls
    assert.deepEqual(await capture.question(), { ok: false, reason: 'region-changed' })
    assert.equal(sourceCalls, beforeInvalidQuestion)
    setSettings({ regions: validRegions })
    check('question capture independently catches in-flight disconnect/resize, restores overlay and never returns invalid-region fullscreen pixels')
    let composerIdentity
    const assertComposer = async () => {
      assert.equal(capture.overlay, overlay)
      assert.equal(await ov("window.__monitorComposer===document.querySelector('.composer')&&window.__monitorInput===document.querySelector('.composer textarea')"), true)
      assert.equal(await ov('location.hash'), composerIdentity)
    }
    const draw = async () => {
      if (await ov("!document.querySelector('.overlay-region')")) await run(overlay, "[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('펜')).click()")
      overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 })
      overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 260, y: 230, movementX: 60, movementY: 30 })
      overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 260, y: 230, button: 'left', clickCount: 1 })
      await wait(() => hasInk(overlay), 'ink painted')
      overlay.webContents.send('personal:escape')
      await frames(overlay)
    }
    await draw()
    if (await ov("!document.querySelector('.overlay-panel')")) { overlay.webContents.send('personal:toggle-panel'); await wait(() => ov("!!document.querySelector('.overlay-panel')"), 'panel opens after drawing') }
    composerIdentity = await ov("window.__monitorComposer=document.querySelector('.composer');window.__monitorInput=document.querySelector('.composer textarea');location.hash")
    await change(overlay, '.composer > textarea', '복구 검증 원문')
    await change(overlay, '.composer-actions select', 'test-deep')
    await ov("(()=>{const dt=new DataTransfer();dt.items.add(new File(['monitor recovery document'],'recovery.txt',{type:'text/plain'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));})()")
    await wait(() => ov("document.querySelector('.document-chips')?.textContent.includes('recovery.txt')&&!document.querySelector('.composer > textarea').disabled"), 'document attached')
    await click(overlay, '질문 다듬기')
    await wait(() => ov("!!document.querySelector('.refine-review')"), 'refinement ready')
    if (!(await ov("document.querySelector('[aria-label=\"화면 캡처 포함\"]').checked"))) await ov("document.querySelector('[aria-label=\"화면 캡처 포함\"]').click()")
    displays = [d2]
    let overlayHides = 0
    const onOverlayHide = () => overlayHides++
    overlay.on('hide', onOverlayHide)
    const beforeFailedCapture = sourceCalls
    await ov("document.querySelector('.composer-actions .primary').click()")
    await wait(() => ov("!!document.querySelector('.composer .notice.error')&&!document.querySelector('.composer > textarea').disabled"), 'capture failure unlocks composer')
    assert.equal(requests.ask.length, 0)
    assert.equal(sourceCalls, beforeFailedCapture)
    assert.equal(overlayHides, 0)
    assert.equal(await hasInk(overlay), true)
    assert.equal(await ov("document.querySelector('.overlay-capture-note').textContent.includes('캡처 영역 확인 필요')"), true)
    await assertComposer()
    check('stale overlay capture blocks before hide/getSources/provider; Composer unlocks with raw/refined/model/document/ink intact')
    // An attached image and screen capture are intentionally exclusive. Exercise image retention via shortcut recovery.
    await ov(`(()=>{const b=Uint8Array.from(atob(${literal(background(12, 8).toPNG().toString('base64'))}),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([b],'recovery.png',{type:'image/png'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));})()`)
    await wait(() => ov("!!document.querySelector('.capture-thumb img')&&!document.querySelector('.composer > textarea').disabled"), 'image attached')
    await click(overlay, '질문 다듬기')
    await wait(() => ov("!!document.querySelector('.refine-review')"), 'image draft refined')
    const draft = () => ov("JSON.stringify({raw:document.querySelector('.composer > textarea').value,refined:document.querySelector('.refine-review textarea')?.value,model:document.querySelector('.composer-actions select').value,document:document.querySelector('.document-chips').textContent,image:document.querySelector('.capture-thumb img')?.src})")
    let draftBefore = await draft()
    const liveBefore = capture.displayId
    const storedBeforeRecovery = settings()
    const outside = new BrowserWindow({ width: 300, height: 200, show: false })
    await outside.loadURL('data:text/html,<h1>Harmless background focus target</h1>')
    personal.quickQuestion()
    await readySettings(overlay, d2.id)
    await assertComposer()
    assert.equal(capture.displayId, liveBefore)
    assert.deepEqual(settings(), storedBeforeRecovery)
    assert.deepEqual(capture.captureSetupRequired(), { ok: false, reason: 'display-missing' })
    assert.equal(capture.panelOpen, true)
    // Native hit testing must include the whole modal backdrop, not just its interior.
    cursor = { x: overlay.getBounds().x + 3, y: overlay.getBounds().y + 3 }
    capture.hitTest()
    assert.equal(capture.accepting, true)
    assert.equal(capture.regions.some(r => r.x <= 3 && r.y <= 3 && r.x + r.width >= overlay.getBounds().width - 3 && r.y + r.height >= overlay.getBounds().height - 3), true)
    overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 3, y: 3, button: 'left', clickCount: 1 })
    overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 3, y: 3, button: 'left', clickCount: 1 })
    overlay.webContents.send('personal:outside-click')
    overlay.webContents.send('personal:toggle-panel')
    outside.show(); outside.focus()
    await wait(() => outside.isFocused(), 'outside focus during modal')
    await frames(overlay)
    assert.equal(await ov("!!document.querySelector('.overlay-panel')&&!!document.querySelector('.settings-modal')"), true)
    overlay.focus()
    await ov("(()=>{const b=document.querySelector('.settings-body');b.style.flex='none';b.style.height='160px'})()")
    const scrollBefore = await ov("document.querySelector('.settings-body').scrollTop")
    await ov("document.querySelector('.settings-body').scrollTop=0")
    const scrollPoint = await ov("(()=>{const r=document.querySelector('.settings-body').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")
    overlay.webContents.sendInputEvent({ type: 'mouseWheel', ...scrollPoint, deltaY: 160, deltaX: 0, canScroll: true })
    await frames(overlay)
    if (!(await ov("document.querySelector('.settings-body').scrollTop>0")))
      overlay.webContents.sendInputEvent({ type: 'mouseWheel', ...scrollPoint, deltaY: -160, deltaX: 0, canScroll: true })
    await wait(() => ov("document.querySelector('.settings-body').scrollTop>0"), 'native wheel scrolls modal')
    assert.ok(scrollBefore >= 0)
    // A native click and keyboard selection must reach the real select, not the background.
    displays = [d1, d2]
    await refresh(overlay)
    // Retry while the modal layout settles; each attempt clicks the select's current hit-tested centre.
    await wait(async () => {
      const p = await ov(`(()=>{const e=document.querySelector(${literal(captureSelect)}),b=document.querySelector('.settings-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-b.clientHeight/2;const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return document.elementFromPoint(x,y)===e?{x,y}:null})()`)
      if (!p) return false
      overlay.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 })
      overlay.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 })
      await frames(overlay)
      return ov(`document.activeElement===document.querySelector(${literal(captureSelect)})`)
    }, 'native click focuses modal select')
    overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await change(overlay, captureSelect, d1.id)
    await wait(async () => (await selected(overlay)) === String(d1.id), 'select changes monitor candidate')
    await ov("document.querySelector('.settings-body').removeAttribute('style')")
    await screenshot('overlay-recovery-modal', overlay)
    await closeSettings(overlay)
    outside.destroy()
    assert.equal(await draft(), draftBefore)
    assert.equal(await hasInk(overlay), true)
    await assertComposer()
    check('same overlay/webContents/Composer/conversation and raw/refined/model/document/image/ink survive display-only recovery and cancel; native backdrop hit/click/scroll/select and outside blur/toggle protect Composer')
    // Same geometry retains ink, while ID and size cutovers clear only old ink.
    displays = [d1]
    await wait(() => ov("!!document.querySelector('.overlay-panel')"), 'same binding available')
    assert.equal(capture.captureSetupRequired(), null)
    editor = await edit(d1.id)
    await apply(editor)
    await frames(overlay)
    assert.equal(await hasInk(overlay), true)
    assert.equal(await draft(), draftBefore)
    assert.equal(requests.ask.length, 0)
    displays = [d2]
    personal.quickQuestion()
    await readySettings(overlay, d2.id)
    await click(overlay, '캡처 영역 설정')
    editor = await editorReady()
    await apply(editor)
    await readySettings(overlay, d2.id)
    await wait(async () => !(await hasInk(overlay)), 'changed monitor clears ink')
    assert.equal(capture.overlay, overlay)
    assert.equal(capture.displayId, d2.id)
    assert.equal(await draft(), draftBefore)
    assert.equal(await ov("document.body.textContent.includes('모니터 또는 화면 크기가 바뀌어 펜 표시를 지웠습니다.')"), true)
    await assertComposer()
    await closeSettings(overlay)
    assert.equal(requests.ask.length, 0)
    await draw()
    // Entering pen mode intentionally closes the panel; establish a fresh draft before this recovery cycle.
    overlay.webContents.send('personal:toggle-panel')
    await wait(() => ov("!!document.querySelector('.composer')"), 'size-test composer opens')
    composerIdentity = await ov("window.__monitorComposer=document.querySelector('.composer');window.__monitorInput=document.querySelector('.composer textarea');location.hash")
    await change(overlay, '.composer > textarea', '복구 검증 원문')
    await change(overlay, '.composer-actions select', 'test-deep')
    await ov(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['monitor recovery document'],'recovery.txt',{type:'text/plain'}));const b=Uint8Array.from(atob(${literal(background(12, 8).toPNG().toString('base64'))}),c=>c.charCodeAt(0));dt.items.add(new File([b],'recovery.png',{type:'image/png'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));})()`)
    await wait(() => ov("!!document.querySelector('.capture-thumb img')&&!!document.querySelector('.document-chips')&&!document.querySelector('.composer > textarea').disabled"), 'size-test attachments ready')
    await click(overlay, '질문 다듬기')
    await wait(() => ov("!!document.querySelector('.refine-review')"), 'size-test refinement ready')
    draftBefore = await draft()
    const resized = fixture(d2.id, { ...d2.bounds, width: d2.bounds.width - 40 })
    displays = [resized]
    personal.quickQuestion()
    await readySettings(overlay, d2.id)
    await click(overlay, '캡처 영역 설정')
    editor = await editorReady()
    assert.equal(capture.preview.region, null)
    await apply(editor)
    await wait(async () => !(await hasInk(overlay)), 'changed size clears ink')
    assert.equal(await draft(), draftBefore)
    await assertComposer()
    await closeSettings(overlay)
    check('same monitor/size Apply preserves ink; monitor-ID and size Apply keep the same Composer and all attachments but clear ink with visible notice, never auto-asking')
    // Return fixture geometry to the physical window bounds and establish exact crop pixels.
    displays = [d2]
    personal.quickQuestion()
    await readySettings(overlay, d2.id)
    await click(overlay, '캡처 영역 설정')
    editor = await editorReady()
    await apply(editor)
    await closeSettings(overlay)
    await wait(() => capture.captureSetupRequired() === null, 'recovered overlay geometry valid')
    assert.equal(requests.ask.length, 0)
    await click(overlay, '이미지 제거')
    if (!(await ov("document.querySelector('[aria-label=\"화면 캡처 포함\"]').checked"))) await ov("document.querySelector('[aria-label=\"화면 캡처 포함\"]').click()")
    // Removal clears refinement; regenerate it before the single explicit retry.
    await click(overlay, '질문 다듬기')
    await wait(() => ov("!!document.querySelector('.refine-review')"), 'retry refinement ready')
    const region = settings().regions.find(r => r.displayId === d2.id)
    await ov("document.querySelector('.composer-actions .primary').click()")
    await wait(() => requests.ask.length === 1, 'single recovered provider ask')
    await wait(() => ov("!document.querySelector('.composer > textarea').disabled&&document.querySelector('.live-answer')?.textContent.includes('monitor recovery answer')"), 'recovered answer completes')
    const parts = requests.ask[0].messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    const imagePart = parts.find(p => p.type === 'image_url')
    assert.ok(imagePart)
    const sentImage = nativeImage.createFromDataURL(imagePart.image_url.url)
    const crop = { x: Math.floor(region.rect.x * d2.bounds.width), y: Math.floor(region.rect.y * d2.bounds.height), width: Math.floor(region.rect.width * d2.bounds.width), height: Math.floor(region.rect.height * d2.bounds.height) }
    assert.deepEqual(sentImage.getSize(), { width: crop.width, height: crop.height })
    assert.deepEqual(sentImage.toBitmap(), background(d2.bounds.width, d2.bounds.height).crop(crop).toBitmap())
    assert.ok(JSON.stringify(requests.ask[0]).includes('monitor recovery document'))
    assert.equal(requests.ask[0].model, 'test-deep')
    assert.equal(requests.ask.length, 1)
    check('only explicit recovered retry sends one ask, with selected model/document and exact selected-region pixel boundaries, never outside pixels')
    // Ordinary provider and capture-permission errors are not setup successes or setup issues.
    await change(overlay, '.composer > textarea', 'provider distinction')
    failProvider = true
    await ov("document.querySelector('.composer-actions .primary').click()")
    await wait(() => ov("document.querySelector('.overlay-panel')?.textContent.includes('로컬 API 오류 (503)')"), 'provider error visible')
    assert.equal(await ov("!!document.querySelector('.settings-modal')"), false)
    assert.equal(capture.captureSetupRequired(), null)
    permissionFailure = true
    await assert.rejects(capture.question(), /monitor fixture permission denied/)
    assert.equal(capture.busy, false)
    await assert.rejects(capture.edit(d2.id), /monitor fixture permission denied/)
    assert.equal(capture.editor, null)
    personal.quickQuestion()
    // Shortcut permission errors in its editor/open flow remain ordinary error boxes.
    capture.close()
    const nativeOpen = capture.open
    capture.open = () => { throw new Error('monitor fixture permission denied') }
    try { personal.quickQuestion() } finally { capture.open = nativeOpen }
    assert.equal(errorBoxes.at(-1).message, 'monitor fixture permission denied')
    permissionFailure = false
    check('provider and permission failures stay ordinary visible errors, release capture busy and never become successful monitor recovery')
    // Invalid saved regions never silently become full-screen; brand-new state still may.
    setSettings({ displayId: d2.id, regions: [{ ...region, screenWidth: d2.bounds.width - 1 }] })
    const beforeInvalidRegion = sourceCalls
    assert.deepEqual(capture.open(project.id), { ok: false, reason: 'region-changed' })
    assert.equal(sourceCalls, beforeInvalidRegion)
    setSettings({ displayId: undefined, regions: [region] })
    assert.deepEqual(capture.open(project.id), { ok: false, reason: 'display-selection-required' })
    setSettings({ displayId: d1.id, regions: [region] })
    displays = [d1, d2]
    assert.deepEqual(capture.open(project.id), { ok: false, reason: 'region-changed' })
    setSettings({ displayId: undefined, regions: [] })
    assert.equal(capture.open(project.id).ok, true)
    await wait(() => capture.overlay?.webContents && !capture.overlay.webContents.isLoading(), 'fresh overlay loads')
    await wait(() => capture.captureSetupRequired() === null, 'fresh full screen bounds ready')
    const full = await capture.question()
    assert.equal(full.ok, true)
    assert.deepEqual(nativeImage.createFromDataURL(full.value).getSize(), { width: d1.bounds.width, height: d1.bounds.height })
    capture.close()
    check('invalid/missing/wrong-target saved regions cannot fall back to fullscreen; genuinely new state retains nearest-monitor fullscreen capture')
    // Test all recovery translations in visible production UI, not resource/source inspection.
    displays = [d1, d2]
    setSettings({ displayId: staleId, regions: [oldRegion] })
    personal.quickQuestion()
    await readySettings(win)
    await nav(win, '화면 표시')
    await run(win, `(()=>{const s=[...document.querySelectorAll(${literal(`${settingsRoot} select`)})].find(s=>[...s.options].some(o=>o.value==='en'));s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await nav(win, 'Screen capture')
    await wait(() => run(win, `document.querySelector(${literal(settingsRoot)}).textContent.includes('Please select a monitor.')&&document.querySelector(${literal(settingsRoot)}).textContent.includes('Monitor connections have changed.')`), 'English selection and recovery')
    await screenshot('english-selection')
    displays = []
    await click(win, 'Rescan monitors')
    await readySettings(win)
    assert.equal(await run(win, `document.querySelector(${literal(settingsRoot)}).textContent.includes('No monitors are connected. Connect a monitor, then scan again.')`), true)
    displays = [d1]
    await click(win, 'Rescan monitors')
    await readySettings(win, d1.id)
    permissionFailure = true
    // Empty source is the real permission-specific production error, translated by errorText.
    const nativeSources = desktopCapturer.getSources
    desktopCapturer.getSources = async () => []
    try {
      await click(win, 'Set capture area')
      await wait(() => run(win, `document.querySelector(${literal(settingsRoot)}).textContent.includes("Can't capture the monitor. Check screen recording permission.")`), 'English permission message')
    } finally { desktopCapturer.getSources = nativeSources; permissionFailure = false }
    await screenshot('english-error')
    await closeSettings()
    setSettings({ displayId: d1.id, regions: [{ ...region, displayId: d1.id }] })
    assert.equal(capture.open(project.id, true).ok, true)
    const englishOverlay = capture.overlay
    await wait(() => run(englishOverlay, "!!document.querySelector('.composer')"), 'English overlay')
    await run(englishOverlay, "[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.trim()==='Pen').click()")
    englishOverlay.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 })
    englishOverlay.webContents.sendInputEvent({ type: 'mouseMove', x: 260, y: 230, movementX: 60, movementY: 30 })
    englishOverlay.webContents.sendInputEvent({ type: 'mouseUp', x: 260, y: 230, button: 'left', clickCount: 1 })
    await wait(() => hasInk(englishOverlay), 'capture-only ink painted')
    englishOverlay.webContents.send('personal:toggle-panel')
    await wait(() => run(englishOverlay, "!!document.querySelector('.composer')"), 'capture-only Composer opens')
    await change(englishOverlay, '.composer > textarea', '')
    assert.equal(await run(englishOverlay, "document.querySelector('[aria-label=\"Include screen capture\"]').checked"), true)
    displays = [d2]
    personal.quickQuestion()
    await readySettings(englishOverlay, d2.id)
    await wait(() => run(englishOverlay, "document.body.textContent.includes('Monitor connections have changed.')"), 'English overlay recovery')
    await click(englishOverlay, 'Set capture area')
    editor = await editorReady()
    await run(editor, `requestAnimationFrame(()=>${button('Apply')}.click());true`)
    await wait(() => !capture.editor, 'English editor Apply')
    await wait(() => run(englishOverlay, "document.body.textContent.includes('Pen marks were cleared because the monitor or screen size changed. Press Ask again.')"), 'English pen reset notice')
    await screenshot('english-pen-reset', englishOverlay)
    assert.equal(requests.ask.length, 2)
    await closeSettings(englishOverlay)
    assert.equal(await hasInk(englishOverlay), false)
    assert.equal(await run(englishOverlay, "document.querySelector('[aria-label=\"Include screen capture\"]').checked"), true)
    assert.equal(await run(englishOverlay, "document.querySelector('.composer > textarea').value"), '')
    await run(englishOverlay, "document.querySelector('.composer-actions .primary').click()")
    await wait(() => requests.ask.length === 3, 'explicit recovered capture-only ask')
    await wait(() => run(englishOverlay, "!document.querySelector('.composer > textarea').disabled"), 'capture-only answer completes')
    assert.equal(requests.ask.length, 3)
    check('clearing old ink preserves the checked capture choice; recovered empty-text capture-only submission sends once only after explicit Ask')
    check('English production screens show monitor selection, recovery reasons, no-monitor and permission errors, editor action and pen-reset guidance')
    report.requestCounts = Object.fromEntries(Object.entries(requests).map(([key, values]) => [key, values.length]))
    report.sourceCalls = sourceCalls
    report.physicalMultiMonitorAndDpi = 'not exercised: fixtures only'
    report.ok = true
    checkpoint('complete')
  } catch (error) {
    exitCode = 1
    report.ok = false
    report.error = error.stack ?? String(error)
    checkpoint(`failed: ${report.phase}`)
    console.error(error)
  } finally {
    for (const channel of replacedHandlers) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handlers.get(channel))
    }
    for (const undo of restore.reverse()) {
      try { undo() } catch (error) { report.cleanupError = String(error); exitCode = 1 }
    }
    try { personal?.capture.editor?.destroy(); personal?.capture.close(); personal?.close() } catch (error) { report.cleanupError = String(error); exitCode = 1 }
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    writeFileSync(resultPath, JSON.stringify(report, null, 2))
    app.exit(exitCode)
  }
})

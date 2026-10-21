const { app, BrowserWindow, nativeImage, screen, dialog, globalShortcut } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { PersonalStore } = require('./.smoke/store.cjs')
const { registerPersonal } = require('./.smoke/personal.cjs')
const dir = join(__dirname, 'screenshots')
mkdirSync(dir, { recursive: true })
const report = { checks: [], consoleErrors: [], screenshots: [] }
const checkpoint = (phase) => {
  report.phase = phase
  writeFileSync(join(__dirname, 'smoke-result.json'), JSON.stringify(report, null, 2))
}
checkpoint('starting')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'fask-smoke-ui-')))
let server
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(fn, label) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) {
      report.checks.push(label)
      checkpoint(label)
      return
    }
    await pause(100)
  }
  throw new Error(`Timeout: ${label}`)
}
app.whenReady().then(async () => {
  try {
    checkpoint('electron ready')
    const dataDir = mkdtempSync(join(tmpdir(), 'fask-smoke-db-'))
    server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'test-fast' }, { id: 'test-deep' }] }))
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const input = JSON.parse(body),
          last = input.messages.at(-1)
        const reply = input.messages[0]?.content.includes('JSON만 출력')
          ? '{}'
          : `테스트 답변: ${typeof last.content === 'string' ? last.content : '이미지 질문'}`
        res.setHeader('Content-Type', 'text/event-stream')
        res.write(
          `data: ${JSON.stringify({ model: 'test-fast', choices: [{ delta: { content: reply } }] })}\n\n`
        )
        res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const seed = new PersonalStore(dataDir),
      project = seed.list('project')[0]
    seed.saveSettings({
      ...seed.settings(),
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'test-fast',
      models: ['test-fast', 'test-deep'],
      organize: false
    })
    const concept = seed.create('concept', 'Electron', project.id)
    const base = {
      projectId: project.id,
      conversationId: 'seed-conversation',
      createdAt: new Date().toISOString(),
      refined: '',
      status: 'completed',
      complexity: 'complex',
      routingReason: '테스트 데이터',
      actualModel: 'test-fast',
      model: 'test-fast',
      conceptIds: [concept],
      suggestions: [],
      memo: '확인한 결정: 로컬 저장을 사용한다.',
      important: true,
      attachment: null,
      error: ''
    }
    seed.put('question', seed.active, {
      ...base,
      id: 'seed-question',
      raw: '투명 오버레이에서 다른 앱을 클릭하려면?',
      sent: '투명 오버레이에서 다른 앱을 클릭하려면?',
      answer:
        '질문 도구를 사용하지 않을 때에는 클릭이 배경 앱으로 통과하도록 설정합니다. 펜과 지우개를 사용할 때만 입력을 받습니다.'
    })
    const profileId = seed.active
    seed.close()
    checkpoint('database seeded')
    const win = new BrowserWindow({
      width: 1380,
      height: 940,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../out/preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level === 3) report.consoleErrors.push(message)
    })
    win.webContents.on('preload-error', (_e, _p, error) => report.consoleErrors.push(error.message))
    const personal = registerPersonal(dataDir, () => win)
    personal.initializeShortcut()
    const js = (source) => win.webContents.executeJavaScript(source)
    checkpoint('loading renderer')
    await win.loadFile(join(__dirname, '../out/renderer/index.html'))
    checkpoint('renderer loaded')
    await wait(
      () => js("!!document.querySelector('.project-header')"),
      'dashboard loads without server/login'
    )
    const shot = async (name, window = win) => {
      window.showInactive()
      window.webContents.invalidate()
      await pause(500)
      const image = await window.webContents.capturePage()
      writeFileSync(join(dir, `${name}.png`), image.toPNG())
      report.screenshots.push(name)
      return image
    }
    await shot('dashboard')
    await js("document.querySelectorAll('.breadcrumb button')[2].click()")
    await wait(
      () => js("!!document.querySelector('.space-card')"),
      'workspace breadcrumb opens project overview'
    )
    await js("document.querySelectorAll('.breadcrumb button')[1].click()")
    await wait(
      () => js("location.hash.includes('scope=home')"),
      'home breadcrumb opens workspace overview'
    )
    await js('document.querySelector(\'[aria-label="이전 화면"]\').click()')
    await wait(
      () => js("location.hash.includes('scope=workspace')"),
      'back navigation restores previous overview'
    )
    await js("document.querySelector('.space-card').click()")
    await wait(
      () => js("!!document.querySelector('.question-card')"),
      'project card returns to questions'
    )
    const renameUi = async (selector, name) => {
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
      await wait(() => js("!!document.querySelector('.create-modal input')"), 'rename dialog opens')
      await js(
        `(()=>{const input=document.querySelector('.create-modal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
      )
      await js("document.querySelector('.create-modal').requestSubmit()")
      await wait(() => js("!document.querySelector('.create-modal')"), 'rename saved')
    }
    await renameUi('.sidebar-rename', '연구 워크스페이스')
    await renameUi('.title-rename', '개인 연구')
    const renamed = await js('window.fask.snapshot()')
    assert.equal(renamed.projects.find((p) => p.id === project.id).name, '개인 연구')
    assert.equal(renamed.workspaces[0].name, '연구 워크스페이스')
    report.checks.push('workspace/project rename retains IDs and question references')
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('투명 오버레이에서')).click()"
    )
    await wait(() => js("!!document.querySelector('.question-detail')"), 'question detail opens')
    await shot('question-detail')
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='개념 그래프').click()"
    )
    await pause(400)
    await shot('graph')
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('설정 · AI')).click()"
    )
    await wait(() => js("!!document.querySelector('.settings-modal')"), 'settings opens')
    await shot('settings')
    const shortcut = await js('window.fask.shortcutInfo()')
    assert.ok(shortcut.accelerator && globalShortcut.isRegistered(shortcut.accelerator))
    report.checks.push('global shortcut registration confirmed by OS')
    const models = await js(`window.fask.models('http://127.0.0.1:${server.address().port}/v1')`)
    assert.deepEqual(models, ['test-deep', 'test-fast'])
    report.checks.push('model catalog via preload/main/local HTTP')
    await js(
      `window.fask.ask(${JSON.stringify({ requestId: 'smoke-request', profileId, projectId: project.id, raw: '간단한 질문', model: 'test-fast' })})`
    )
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.raw==='간단한 질문'&&q.status==='completed'))"
        ),
      'streamed answer persisted'
    )
    await js(
      "document.querySelector('.settings-modal header button').click();[...document.querySelectorAll('.view-bar button')].find(b=>b.textContent.includes('새 질문')).click()"
    )
    await wait(
      () => js("!!document.querySelector('.composer textarea')"),
      'dashboard question supports attachments'
    )
    await js(
      `(()=>{const b=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([b],'paste.png',{type:'image/png'}));document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));})()`
    )
    await wait(
      () => js("!!document.querySelector('.capture-thumb img')"),
      'pasted image is previewed'
    )
    await js(
      "(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['첨부한 문서 내용'],'notes.md',{type:'text/markdown'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));})()"
    )
    await wait(
      () => js("!!document.querySelector('.document-chips')"),
      'dropped Markdown file is attached'
    )
    await shot('attachments')
    await js("document.querySelector('.composer-actions .primary').click()")
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.documents?.[0]?.name==='notes.md'&&q.attachment&&q.status==='completed'))"
        ),
      'image and file question persisted with model answer'
    )
    const display = screen.getPrimaryDisplay()
    const background = await win.webContents.capturePage()
    // Deterministic fixture replaces desktop capture; no unrelated desktop content is saved.
    personal.capture.screenshot = async () =>
      background.resize({ width: display.bounds.width, height: display.bounds.height })
    await personal.capture.edit(display.id)
    const editor = personal.capture.editor
    await wait(
      () => editor.webContents.executeJavaScript("!!document.querySelector('.capture-box')"),
      'capture editor sharp/blur preview loads'
    )
    assert.equal(
      await editor.webContents.executeJavaScript(
        "document.querySelectorAll('.capture-handle').length"
      ),
      8
    )
    const handle = await editor.webContents.executeJavaScript(
      "(()=>{const r=document.querySelector('.capture-handle.se').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
    )
    editor.webContents.sendInputEvent({
      type: 'mouseDown',
      x: handle.x,
      y: handle.y,
      button: 'left',
      clickCount: 1
    })
    editor.webContents.sendInputEvent({
      type: 'mouseMove',
      x: handle.x - 50,
      y: handle.y - 30,
      button: 'left'
    })
    editor.webContents.sendInputEvent({
      type: 'mouseUp',
      x: handle.x - 50,
      y: handle.y - 30,
      button: 'left',
      clickCount: 1
    })
    await pause(200)
    await shot('capture-editor', editor)
    await editor.webContents.executeJavaScript(
      "setTimeout(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('적용')).click(),50);true"
    )
    await wait(() => !personal.capture.editor, 'capture region applies and editor closes')
    const snapshot = await js('window.fask.snapshot()')
    const savedRegion = snapshot.settings.regions[0]
    assert.ok(savedRegion.rect.width < 0.8 && savedRegion.rect.width > 0.7)
    report.checks.push('resize handle changes persisted capture rectangle')
    await personal.capture.edit(display.id)
    const cancelEditor = personal.capture.editor
    await wait(
      () => cancelEditor.webContents.executeJavaScript("!!document.querySelector('.capture-box')"),
      'saved capture region reopens'
    )
    await cancelEditor.webContents.executeJavaScript(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='전체 화면').click();setTimeout(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('취소')).click(),50);true"
    )
    await wait(() => !personal.capture.editor, 'cancel capture edit closes')
    assert.deepEqual(
      (await js('window.fask.snapshot()')).settings.regions[0].rect,
      savedRegion.rect
    )
    report.checks.push('cancel preserves previous capture region')
    await personal.capture.open(project.id)
    const overlay = personal.capture.overlay
    await wait(
      () => overlay.webContents.executeJavaScript("!!document.querySelector('.overlay-toolbar')"),
      'transparent question overlay opens'
    )
    const image = await personal.capture.question()
    const cropped = nativeImage.createFromDataURL(image).getSize()
    assert.equal(cropped.width, Math.floor(display.bounds.width * savedRegion.rect.width))
    report.checks.push('capture crops selected rectangle in main process')
    let cursor = { x: display.bounds.x + 5, y: display.bounds.y + 5 }
    const originalCursor = screen.getCursorScreenPoint
    screen.getCursorScreenPoint = () => cursor
    const ignoreStates = []
    const nativeIgnore = overlay.setIgnoreMouseEvents.bind(overlay)
    overlay.setIgnoreMouseEvents = (value, options) => {
      ignoreStates.push(value)
      nativeIgnore(value, options)
    }
    const toggle = await overlay.webContents.executeJavaScript(
      "(()=>{const r=[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('질문')).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
    )
    const bounds = overlay.getBounds()
    cursor = { x: bounds.x + toggle.x, y: bounds.y + toggle.y }
    await pause(80)
    assert.equal(ignoreStates.at(-1), false)
    overlay.webContents.sendInputEvent({ type: 'mouseMove', x: toggle.x, y: toggle.y })
    overlay.webContents.sendInputEvent({
      type: 'mouseDown',
      x: toggle.x,
      y: toggle.y,
      button: 'left',
      clickCount: 1
    })
    overlay.webContents.sendInputEvent({
      type: 'mouseUp',
      x: toggle.x,
      y: toggle.y,
      button: 'left',
      clickCount: 1
    })
    await wait(
      () => overlay.webContents.executeJavaScript("!!document.querySelector('.overlay-panel')"),
      'collapsed toolbar opens panel with native mouse events'
    )
    cursor = { x: bounds.x + 5, y: bounds.y + 5 }
    await pause(80)
    assert.equal(ignoreStates.at(-1), true)
    report.checks.push('background remains click-through outside controls')
    personal.quickQuestion()
    await wait(
      () => overlay.webContents.executeJavaScript("!document.querySelector('.overlay-panel')"),
      'shortcut action closes panel'
    )
    personal.quickQuestion()
    await wait(
      () => overlay.webContents.executeJavaScript("!!document.querySelector('.overlay-panel')"),
      'shortcut action opens question panel'
    )
    screen.getCursorScreenPoint = originalCursor
    await pause(250)
    await shot('overlay', overlay)
    personal.capture.close()
    await pause(150)
    await js(
      `window.fask.ask(${JSON.stringify({ requestId: 'saved-image', profileId, projectId: project.id, raw: '캡처 기록', image, model: 'test-fast', saveOnly: true })})`
    )
    const backupPath = join(dataDir, 'backup.json')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: backupPath })
    assert.equal(await js('window.fask.backup()'), true)
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
    assert.equal(backup.snapshot.questions.length, 4)
    assert.ok(Object.keys(backup.images).length === 2)
    assert.equal(backup.snapshot.settings.hasKey, false)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backupPath] })
    assert.equal(await js('window.fask.restore()'), true)
    const restored = await js('window.fask.snapshot()')
    assert.notEqual(restored.activeProfileId, profileId)
    assert.equal(restored.questions.length, 4)
    assert.equal(restored.profiles.length, 2)
    assert.ok(restored.storageBytes > 0)
    report.checks.push('backup restores questions and capture into a separate profile')
    assert.deepEqual(report.consoleErrors, [])
    report.success = true
    writeFileSync(join(__dirname, 'smoke-result.json'), JSON.stringify(report, null, 2))
    server.close()
    app.exit(0)
  } catch (error) {
    report.success = false
    report.error = error.stack
    writeFileSync(join(__dirname, 'smoke-result.json'), JSON.stringify(report, null, 2))
    server?.close()
    app.exit(1)
  }
})

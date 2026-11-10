const { app, BrowserWindow, nativeImage, screen, dialog, globalShortcut } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { PersonalStore } = require('./.smoke/store.cjs')
const { registerPersonal } = require('./.smoke/personal.cjs')
const { createHubCertificate } = require('./.smoke/hub.cjs')
const { X509Certificate } = require('node:crypto')
const { createServer: createHttpsServer } = require('node:https')
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
let failNextQuestion = false
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
// seed (+failed follow-up), 간단한 질문, image+file question (+two overlay follow-ups: the overlay
// opens on the most recent question), 중복 방지 질문 (+느린 답변), 캡처 기록.
const QUESTION_COUNT = 5
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
    let lastSystem = ''
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
        // Title requests run in parallel with answers, so they never consume failNextQuestion.
        if (input.messages[0]?.content.includes('대화 제목 생성')) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"테스트 제목"' } }] })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        if (failNextQuestion) {
          failNextQuestion = false
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'smoke proxy failure' } }))
          return
        }
        if (typeof last.content === 'string' && last.content.includes('느린 답변')) {
          res.setHeader('Content-Type', 'text/event-stream')
          let sent = 0
          const timer = setInterval(() => {
            if (res.destroyed) return clearInterval(timer)
            res.write(`data: ${JSON.stringify({ model: 'test-fast', choices: [{ delta: { content: `조각${sent} ` } }] })}\n\n`)
            if (++sent === 10) {
              clearInterval(timer)
              res.end('data: [DONE]\n\n')
            }
          }, 200)
          res.on('close', () => clearInterval(timer))
          return
        }
        const reply = input.messages[0]?.content.includes('JSON만 출력')
          ? '{}'
          : input.messages[0]?.content.includes('다듬어라')
            ? '다듬어진 테스트 질문'
            : ((lastSystem = input.messages[0]?.content ?? ''),
              // List previews render only the first ~600 chars, so preview checks need italic/math up front.
              `## 설명\n\n**핵심 내용**과 *기울임*, $x^2 + 1$ 목록입니다.\n\n- 첫 번째\n- 두 번째\n\n\`\`\`js\nconst answer = 42\n\`\`\`\n\n| 항목 | 설명 |\n| --- | --- |\n| 캡처 | 전송 시 촬영 |\n\n[위험 링크](javascript:alert(1))\n\n<img src="https://example.invalid/track">\n\n${'긴 답변의 스크롤과 영역 크기를 확인하는 문단입니다.\n\n'.repeat(24)}테스트 답변: ${typeof last.content === 'string' ? last.content : '이미지 질문'}`)
        res.setHeader('Content-Type', 'text/event-stream')
        res.write(
          `data: ${JSON.stringify({ model: 'test-fast', choices: [{ delta: { content: `${reply}\n\n*기울임*과 $x^2 + 1$` } }] })}\n\n`
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
    const createdAt = new Date().toISOString()
    seed.put('question', seed.active, {
      id: 'seed-question',
      projectId: project.id,
      createdAt,
      turns: [
        {
          id: 'seed-turn',
          createdAt,
          raw: '투명 오버레이에서 다른 앱을 클릭하려면?',
          refined: '',
          sent: '투명 오버레이에서 다른 앱을 클릭하려면?',
          answer:
            '질문 도구를 사용하지 않을 때에는 클릭이 배경 앱으로 통과하도록 설정합니다. 펜과 지우개를 사용할 때만 입력을 받습니다.',
          model: 'test-fast',
          actualModel: 'test-fast',
          status: 'completed',
          complexity: 'complex',
          routingReason: '테스트 데이터',
          attachment: null,
          documents: [],
          error: '',
          revision: 0
        }
      ],
      conceptIds: [concept],
      suggestions: [],
      memo: '확인한 결정: 로컬 저장을 사용한다.',
      important: true
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
      if (level === 3) {
        report.consoleErrors.push(message)
        report.errorPhases ??= []
        report.errorPhases.push({ phase: report.phase, message })
      }
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
    const context = async (selector, items = 2) => {
      await js(
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:350,clientY:220}))`
      )
      await wait(
        () => js("!!document.querySelector('.item-context-menu')"),
        'right click opens edit/delete menu'
      )
      assert.equal(
        await js("document.querySelectorAll('.item-context-menu [role=menuitem]').length"),
        items
      )
    }
    await context('[aria-label="프로필"]', 2)
    await renameUi('.item-context-menu button', '연구 프로필')
    await context('.question-card', 3)
    await renameUi('.item-context-menu button', '투명 오버레이에서 입력 처리 연구')
    const namedQuestion = (await js('window.fask.snapshot()')).questions.find(
      (q) => q.id === 'seed-question'
    )
    assert.equal(namedQuestion.title, '투명 오버레이에서 입력 처리 연구')
    assert.equal(namedQuestion.turns[0].sent, '투명 오버레이에서 다른 앱을 클릭하려면?')
    report.checks.push(
      'profile and timeline question context menus rename without altering prompts'
    )

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
    await context(`.react-flow__node[data-id="c:${concept}"]`)
    await renameUi('.item-context-menu button', 'Electron 입력')
    assert.equal(
      (await js('window.fask.snapshot()')).concepts.find((c) => c.id === concept).name,
      'Electron 입력'
    )
    report.checks.push('graph node right click renames concept')

    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('설정과 AI 연결')).click()"
    )
    await wait(() => js("!!document.querySelector('.settings-modal')"), 'settings opens')
    await shot('settings')
    const shortcut = await js('window.fask.shortcutInfo()')
    assert.ok(shortcut.accelerator && globalShortcut.isRegistered(shortcut.accelerator))
    report.checks.push('global shortcut registration confirmed by OS')
    const models = await js(`window.fask.models('http://127.0.0.1:${server.address().port}/v1')`)
    assert.deepEqual(models, ['test-deep', 'test-fast'])
    report.checks.push('model catalog via preload/main/local HTTP')
    {
      // Electron ships BoringSSL, which is stricter than Node's OpenSSL about certificate DER.
      const tls = await createHubCertificate()
      new X509Certificate(tls.cert)
      createHttpsServer({ cert: tls.cert, key: tls.key }).close()
      report.checks.push('hub certificate accepted by Electron TLS')
    }
    await js(
      `window.fask.ask(${JSON.stringify({ requestId: 'smoke-request', profileId, projectId: project.id, raw: '간단한 질문', model: 'test-fast' })})`
    )
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.turns.some(t=>t.raw==='간단한 질문'&&t.status==='completed')))"
        ),
      'streamed answer persisted'
    )
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.turns[0].raw==='간단한 질문'&&q.title==='테스트 제목'))"
        ),
      'AI title generated in parallel'
    )
    const penImage =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    for (const annotated of [true, false]) {
      const raw = `펜 표시 질문 ${annotated}`
      await js(
        `window.fask.ask(${JSON.stringify({ requestId: `smoke-pen-${annotated}`, profileId, projectId: project.id, raw, model: 'test-fast', image: penImage, ...(annotated ? { annotated: true } : {}) })})`
      )
      await wait(
        () =>
          js(
            `window.fask.snapshot().then(s=>s.questions.some(q=>q.turns.some(t=>t.raw===${JSON.stringify(raw)}&&t.status==='completed')))`
          ),
        `pen ask ${annotated} completed`
      )
      if (lastSystem.includes('펜으로 직접 그린 표시') !== annotated)
        throw new Error(`annotation instruction mismatch (annotated=${annotated})`)
    }
    report.checks.push('pen annotation prompt only for annotated captures')
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
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.turns.some(t=>t.documents[0]?.name==='notes.md'&&t.attachment&&t.status==='completed')))"
        ),
      'image and file question persisted with model answer'
    )
    await wait(
      () =>
        js(
          "!!document.querySelector('.live-answer h2')&&!!document.querySelector('.live-answer pre code')&&!!document.querySelector('.live-answer table')"
        ),
      'streamed answer renders Markdown heading/code/table'
    )
    await js(`[...document.querySelectorAll('.segmented button')].find(b=>b.textContent==='날짜순').click()`)
    await wait(
      () => js(`!!document.querySelector('.question-card .markdown-answer strong') && !!document.querySelector('.question-card .markdown-answer em') && !!document.querySelector('.question-card .katex')`),
      'dashboard previews render bold italic and math'
    )
    assert.ok(Number(await js(`getComputedStyle(document.querySelector('.question-card .markdown-answer strong')).fontWeight`)) >= 600)
    assert.equal(await js(`getComputedStyle(document.querySelector('.question-card .markdown-answer em')).fontStyle`), 'italic')
    await js(`document.querySelector('.question-card .markdown-answer strong').closest('.question-card').scrollIntoView({block:'center'})`)
    await shot('markdown-preview')
    await js(`document.querySelector('.view-bar').scrollIntoView({block:'start'})`)
    assert.equal(
      await js(
        'document.querySelectorAll(\'.markdown-answer script,.markdown-answer img,.markdown-answer a[href^="javascript:"]\').length'
      ),
      0
    )
    report.checks.push('model HTML and unsafe URLs are not executed')
    const display = screen.getPrimaryDisplay()
    const background = await win.webContents.capturePage()
    // Deterministic fixture replaces desktop capture; no unrelated desktop content is saved.
    let captureCount = 0
    personal.capture.screenshot = async () => {
      captureCount++
      return background.resize({ width: display.bounds.width, height: display.bounds.height })
    }
    assert.equal((await personal.capture.edit(display.id)).ok, true)
    const editor = personal.capture.editor
    await wait(
      () => editor.webContents.executeJavaScript("!!document.querySelector('.capture-box')"),
      'capture editor sharp/blur preview loads'
    )
    await wait(
      async () => {
        const viewport = await editor.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
        return viewport.width === display.bounds.width && viewport.height === display.bounds.height
      },
      'capture editor viewport covers full monitor including taskbar area'
    )
    assert.deepEqual(editor.getContentBounds(), display.bounds)
    assert.equal(
      await editor.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.capture-background').getBoundingClientRect();return r.width===innerWidth&&r.height===innerHeight})()`),
      true
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
    assert.equal((await personal.capture.edit(display.id)).ok, true)
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
    assert.equal(personal.capture.open(project.id).ok, true)
    const overlay = personal.capture.overlay
    await wait(
      () => overlay.webContents.executeJavaScript("!!document.querySelector('.overlay-toolbar')"),
      'transparent question overlay opens'
    )
    await wait(
      async () => {
        const viewport = await overlay.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
        return viewport.width === display.bounds.width && viewport.height === display.bounds.height
      },
      'pen overlay viewport covers full monitor including taskbar area'
    )
    assert.deepEqual(overlay.getContentBounds(), display.bounds)
    await overlay.webContents.executeJavaScript(`[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('펜')).click()`)
    await wait(
      () => overlay.webContents.executeJavaScript("!!document.querySelector('.overlay-region')"),
      'pen mode displays saved capture boundary'
    )
    const boundary = await overlay.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.overlay-region').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    for (const [key, scale] of [['x', display.bounds.width], ['y', display.bounds.height], ['width', display.bounds.width], ['height', display.bounds.height]]) {
      assert.ok(Math.abs(boundary[key] - savedRegion.rect[key] * scale) < 1, key)
    }
    report.checks.push('pen capture boundary matches full-monitor capture coordinates')
    overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'right', clickCount: 1 })
    overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'right', clickCount: 1 })
    await wait(
      () => overlay.webContents.executeJavaScript("!document.querySelector('.overlay-region')"),
      'right-click leaves pen mode'
    )
    report.checks.push('right-click in pen mode returns to background-app mode')
    const target = await js(`window.fask.create('project','전환 대상',${JSON.stringify(project.workspaceId)})`)
    const pickProject = async (id, name) => {
      await overlay.webContents.executeJavaScript("document.querySelector('.toolbar-project').click()")
      await wait(
        () =>
          overlay.webContents.executeJavaScript(
            `[...document.querySelectorAll('.overlay-project-picker button')].some(b=>b.textContent.includes(${JSON.stringify(name)}))`
          ),
        `overlay project picker lists ${name}`
      )
      await overlay.webContents.executeJavaScript(
        `[...document.querySelectorAll('.overlay-project-picker button')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`
      )
      await wait(
        () => overlay.webContents.executeJavaScript(`location.hash.includes(${JSON.stringify(`project=${id}`)})`),
        `overlay route switches to ${name}`
      )
      assert.equal(personal.capture.overlay, overlay)
      await wait(
        async () =>
          (await overlay.webContents.executeJavaScript(
            "document.querySelector('.overlay-panel header b')?.textContent"
          )) === name,
        `overlay panel shows ${name}`
      )
    }
    await pickProject(target, '전환 대상')
    const original = (await js('window.fask.snapshot()')).projects.find((p) => p.id === project.id)
    await pickProject(project.id, original.name)
    await overlay.webContents.executeJavaScript("document.querySelector('.overlay-panel header button').click()")
    await wait(
      () => overlay.webContents.executeJavaScript("!document.querySelector('.overlay-panel')"),
      'overlay panel closes after project switch'
    )
    report.checks.push('overlay switches project in place')
    overlay.webContents.send('personal:escape')
    const image = await personal.capture.question()
    assert.equal(image.ok, true)
    const cropped = nativeImage.createFromDataURL(image.value).getSize()
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
    {
      const ov = (source) => overlay.webContents.executeJavaScript(source)
      const center = (selector) =>
        ov(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
      const point = async (p) => {
        cursor = { x: bounds.x + p.x, y: bounds.y + p.y }
        overlay.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
        await pause(80)
      }
      const handle = await center('.toolbar-drag-handle')
      await point(handle)
      await ov("document.querySelector('.overlay-panel header button').click()")
      await wait(() => ov("!document.querySelector('.overlay-panel')"), 'panel closes before popover checks')
      if (!(await ov("document.querySelector('.overlay-toolbar').classList.contains('collapsed')"))) {
        overlay.webContents.sendInputEvent({ type: 'mouseDown', ...handle, button: 'left', clickCount: 1 })
        overlay.webContents.sendInputEvent({ type: 'mouseUp', ...handle, button: 'left', clickCount: 1 })
        await wait(() => ov("document.querySelector('.overlay-toolbar').classList.contains('collapsed')"), 'toolbar collapses')
      }
      await point({ x: 5, y: 5 })
      await point(handle)
      await wait(() => ov("!!document.querySelector('.overlay-toolbar.peek')"), 'collapsed toolbar peeks on hover')
      // A real OS click on the toolbar activates the overlay; synthetic input does not.
      overlay.focus()
      await wait(() => overlay.isFocused(), 'toolbar click focuses overlay')
      await ov("document.querySelector('.toolbar-project').click()")
      await wait(() => ov("!!document.querySelector('.overlay-project-picker')"), 'project popover opens from peek')
      await point(await center('.overlay-project-picker'))
      await pause(300)
      assert.equal(await ov("!!document.querySelector('.overlay-toolbar.peek')"), true)
      report.checks.push('peek stays open while pointer is on the project popover')
      await point({ x: 5, y: 5 })
      assert.equal(await ov("!!document.querySelector('.overlay-project-picker')"), true)
      // Leaving the tools must not silently release focus while the popover is open.
      assert.equal(overlay.isFocused(), true)
      const outside = new BrowserWindow({ width: 400, height: 300 })
      await outside.loadURL('data:text/html,<h1>Background click target</h1>')
      outside.show()
      outside.focus()
      await wait(() => ov("!document.querySelector('.overlay-project-picker')"), 'background click closes project popover')
      await wait(() => ov("!document.querySelector('.overlay-toolbar.peek')"), 'toolbar collapses with the popover')
      outside.destroy()
      await ov("document.querySelector('.question-trigger').click()")
      await wait(() => ov("!!document.querySelector('.overlay-panel')"), 'panel reopens after popover checks')
      cursor = { x: bounds.x + 5, y: bounds.y + 5 }
      await pause(80)
    }
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
    const overlayJs = (source) => overlay.webContents.executeJavaScript(source)
    const beforeSendCaptureCount = captureCount
    await overlayJs('document.querySelector(\'[aria-label="화면 캡처 포함"]\').click()')
    await pause(100)
    assert.equal(captureCount, beforeSendCaptureCount)
    report.checks.push('capture inclusion toggle does not take a screenshot')
    await overlayJs(
      "(()=>{const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'전송 시점 캡처 질문');el.dispatchEvent(new Event('input',{bubbles:true}));})()"
    )
    await overlayJs(
      "[...document.querySelectorAll('.composer-actions button')].find(b=>b.textContent==='질문 다듬기').click()"
    )
    await wait(
      () => overlayJs("!!document.querySelector('.refine-review')"),
      'refinement completes without screen capture'
    )
    assert.equal(captureCount, beforeSendCaptureCount)
    await overlayJs("document.querySelector('.composer-actions .primary').click()")
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.turns.some(t=>t.raw==='전송 시점 캡처 질문'&&t.attachment&&t.status==='completed')))"
        ),
      'send button captures fresh screen and transmits it'
    )
    assert.equal(captureCount, beforeSendCaptureCount + 1)
    await wait(
      () => overlayJs("!!document.querySelector('.live-answer .markdown-answer table')"),
      'overlay renders Markdown tables'
    )
    assert.equal(
      await overlayJs(
        "(()=>{const body=document.querySelector('.overlay-panel-content');return body.scrollHeight>body.clientHeight})()"
      ),
      true
    )
    const initialPanel = await overlayJs(
      "(()=>{const r=document.querySelector('.overlay-panel').getBoundingClientRect();const h=document.querySelector('.panel-resize-handle').getBoundingClientRect();return {width:r.width,height:r.height,west:document.querySelector('.panel-resize-handle').classList.contains('sw')||document.querySelector('.panel-resize-handle').classList.contains('nw'),north:document.querySelector('.panel-resize-handle').classList.contains('nw')||document.querySelector('.panel-resize-handle').classList.contains('ne'),x:Math.round(h.x+h.width/2),y:Math.round(h.y+h.height/2)}})()"
    )
    cursor = { x: bounds.x + initialPanel.x, y: bounds.y + initialPanel.y }
    await pause(80)
    overlay.webContents.sendInputEvent({
      type: 'mouseDown',
      x: initialPanel.x,
      y: initialPanel.y,
      button: 'left',
      clickCount: 1
    })
    overlay.webContents.sendInputEvent({
      type: 'mouseMove',
      x: initialPanel.x + (initialPanel.west ? -40 : 40),
      y: initialPanel.y + (initialPanel.north ? -70 : 70),
      button: 'left'
    })
    overlay.webContents.sendInputEvent({
      type: 'mouseUp',
      x: initialPanel.x + (initialPanel.west ? -40 : 40),
      y: initialPanel.y + (initialPanel.north ? -70 : 70),
      button: 'left',
      clickCount: 1
    })
    await wait(
      () =>
        overlayJs(
          `document.querySelector('.overlay-panel').getBoundingClientRect().height>${initialPanel.height + 30}`
        ),
      'question panel resizes with a visible drag handle'
    )
    const resized = await overlayJs(
      "(()=>{const r=document.querySelector('.overlay-panel').getBoundingClientRect();return {width:r.width,height:r.height}})()"
    )
    assert.ok(resized.width > initialPanel.width)
    report.checks.push('long answers scroll inside the resized question panel')
    await overlayJs(
      "document.querySelector('.overlay-panel-content').scrollTop=0;document.querySelector('[aria-label=\"화면 캡처 포함\"]').click()"
    )
    await overlayJs(
      "(()=>{const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'캡처 없이 보내는 질문');el.dispatchEvent(new Event('input',{bubbles:true}));})()"
    )
    await overlayJs("document.querySelector('.composer-actions .primary').click()")
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.some(q=>q.turns.some(t=>t.raw==='캡처 없이 보내는 질문'&&!t.attachment&&t.status==='completed')))"
        ),
      'unchecked capture sends text without screenshot'
    )
    assert.equal(captureCount, beforeSendCaptureCount + 1)
    {
      const threads = (await js('window.fask.snapshot()')).questions.filter((q) =>
        q.turns.some((t) => t.raw === '전송 시점 캡처 질문')
      )
      assert.equal(threads.length, 1)
      const raws = threads[0].turns.map((t) => t.raw)
      assert.deepEqual(raws.slice(-2), ['전송 시점 캡처 질문', '캡처 없이 보내는 질문'])
      report.checks.push('overlay follow-up stays in one question')
    }
    personal.quickQuestion()
    await wait(
      () => overlayJs("!document.querySelector('.overlay-panel')"),
      'question panel closes after answer'
    )
    personal.quickQuestion()
    await wait(
      () =>
        overlayJs(
          "document.querySelector('.recent-question')?.textContent.includes('캡처 없이 보내는 질문') && !!document.querySelector('.live-answer table')"
        ),
      'reopening question restores most recent question and Markdown answer'
    )
    assert.equal(
      await overlayJs(`document.querySelector('[aria-label="화면 캡처 포함"]').checked`),
      false
    )
    const nativeDrag = async (selector, dx, dy) => {
      const point = await overlayJs(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+Math.min(80,r.width/2)),y:Math.round(r.top+r.height/2)}})()`
      )
      cursor = { x: bounds.x + point.x, y: bounds.y + point.y }
      await pause(80)
      overlay.webContents.sendInputEvent({
        type: 'mouseDown',
        ...point,
        button: 'left',
        clickCount: 1
      })
      overlay.webContents.sendInputEvent({
        type: 'mouseMove',
        x: point.x + dx,
        y: point.y + dy,
        button: 'left'
      })
      overlay.webContents.sendInputEvent({
        type: 'mouseUp',
        x: point.x + dx,
        y: point.y + dy,
        button: 'left',
        clickCount: 1
      })
      await pause(100)
    }
    for (const [right, bottom, expected] of [
      [false, false, 'se'],
      [true, false, 'sw'],
      [true, true, 'nw'],
      [false, true, 'ne']
    ]) {
      const r = await overlayJs(
        "(()=>{const r=document.querySelector('.overlay-toolbar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()"
      )
      await nativeDrag(
        '.toolbar-drag-handle',
        Math.round((right ? display.bounds.width - r.width - 8 : 8) - r.x),
        Math.round((bottom ? display.bounds.height - r.height - 8 : 8) - r.y)
      )
      assert.equal(
        await overlayJs(
          `document.querySelector('.panel-resize-handle').classList.contains('${expected}')`
        ),
        true
      )
      const before = await overlayJs(
        "(()=>{const r=document.querySelector('.overlay-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()"
      )
      await nativeDrag(
        '.panel-resize-handle',
        expected.includes('w') ? 10 : -10,
        expected.includes('n') ? 10 : -10
      )
      const after = await overlayJs(
        "(()=>{const r=document.querySelector('.overlay-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()"
      )
      assert.ok(Math.abs(after.width - (before.width - 10)) < 2)
      assert.ok(Math.abs(after.height - (before.height - 10)) < 2)
      assert.ok(
        Math.abs(
          (expected.includes('w') ? after.x + after.width : after.x) -
            (expected.includes('w') ? before.x + before.width : before.x)
        ) < 2
      )
      assert.ok(
        Math.abs(
          (expected.includes('n') ? after.y + after.height : after.y) -
            (expected.includes('n') ? before.y + before.height : before.y)
        ) < 2
      )
    }
    report.checks.push(
      'native toolbar drag supports all four quadrants; resize holds opposite corner fixed'
    )
    await nativeDrag('.overlay-panel > header', -80, 20)
    await overlayJs(`document.querySelector('[aria-label="화면 캡처 포함"]').click()`)
    const rememberedGeometry = await overlayJs(
      "JSON.stringify([...document.querySelectorAll('.overlay-toolbar,.overlay-panel')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"
    )
    screen.getCursorScreenPoint = originalCursor
    await pause(250)
    await shot('overlay', overlay)
    personal.capture.close()
    await pause(150)
    assert.equal((await js(`window.fask.openOverlay(${JSON.stringify(project.id)}, 'seed-question')`)).ok, true)
    const resumed = personal.capture.overlay
    const resumedJs = (source) => resumed.webContents.executeJavaScript(source)
    await wait(
      () => resumedJs("!!document.querySelector('.recent-question')"),
      'dashboard continuation opens overlay question panel'
    )
    assert.equal(
      await resumedJs(
        "document.querySelector('.recent-question').textContent.includes('투명 오버레이에서 다른 앱을 클릭하려면?')"
      ),
      true
    )
    assert.equal(
      await resumedJs(`document.querySelector('[aria-label="화면 캡처 포함"]').checked`),
      true
    )
    assert.equal(
      await resumedJs(
        "JSON.stringify([...document.querySelectorAll('.overlay-toolbar,.overlay-panel')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"
      ),
      rememberedGeometry
    )
    report.checks.push(
      'dashboard round trip restores panel position, size, toolbar position and capture selection'
    )
    await resumedJs(
      "[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('캡처 영역')).click()"
    )
    await wait(() => !!personal.capture.editor, 'toolbar opens capture area editor')
    const overlayEditor = personal.capture.editor
    await wait(
      () => overlayEditor.webContents.executeJavaScript("!!document.querySelector('.capture-box')"),
      'capture editor loads from overlay'
    )
    await overlayEditor.webContents.executeJavaScript(
      "setTimeout(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('취소')).click(),50);true"
    )
    await wait(
      () => !personal.capture.editor && resumed.isVisible() && !win.isVisible(),
      'closing capture editor restores overlay instead of dashboard'
    )
    assert.equal(
      await resumedJs(
        "[...document.querySelectorAll('.overlay-toolbar button')].some(b=>b.textContent.includes('나가기'))"
      ),
      false
    )
    await resumedJs(`[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('펜')).click()`)
    resumed.webContents.sendInputEvent({ type: 'mouseDown', x: 180, y: 180, button: 'left', clickCount: 1 })
    resumed.webContents.sendInputEvent({ type: 'mouseMove', x: 240, y: 220, movementX: 60, movementY: 40 })
    resumed.webContents.sendInputEvent({ type: 'mouseUp', x: 240, y: 220, button: 'left', clickCount: 1 })
    await pause(100)
    const inkBefore = await resumedJs(`document.querySelector('canvas').toDataURL()`)
    assert.equal(await resumedJs(`(()=>{const c=document.querySelector('canvas');return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)})()`), true)
    await resumedJs(`[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('질문')).click()`)
    await wait(() => resumedJs(`!!document.querySelector('.overlay-panel')`), 'question panel reopens with existing ink')
    assert.equal(await resumedJs(`document.querySelector('[aria-label="화면 캡처 포함"]').checked`), true)
    await resumedJs(`(()=>{const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'실패한 질문은 펜을 유지');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    failNextQuestion = true
    await resumedJs(`document.querySelector('.composer-actions .primary').click()`)
    await wait(() => resumedJs(`!!document.querySelector('.composer [role="alert"]')`), 'failed API request displays error')
    assert.equal(await resumedJs(`document.querySelector('canvas').toDataURL()`), inkBefore)
    assert.equal(await resumedJs(`document.querySelector('.composer textarea').value`), '실패한 질문은 펜을 유지')
    report.checks.push('failed API request preserves ink and question draft')
    resumed.focus()
    await pause(100)
    const backgroundWindow = new BrowserWindow({ width: 400, height: 300 })
    await backgroundWindow.loadURL('data:text/html,<h1>Background focus target</h1>')
    backgroundWindow.show()
    backgroundWindow.focus()
    await wait(() => resumedJs(`!document.querySelector('.overlay-panel')`), 'outside application focus closes question panel')
    assert.equal(backgroundWindow.isFocused(), true)
    backgroundWindow.destroy()
    personal.capture.close()
    {
      const seedQuestion = (await js('window.fask.snapshot()')).questions.find(
        (q) => q.id === 'seed-question'
      )
      assert.equal(seedQuestion.turns.at(-1).status, 'failed')
      assert.equal(seedQuestion.title, '투명 오버레이에서 입력 처리 연구')
      report.checks.push('failed follow-up stays in the seed question; user title preserved')
    }
    const dupInput = JSON.stringify({
      requestId: 'dup-request',
      profileId,
      projectId: project.id,
      raw: '중복 방지 질문',
      model: 'test-fast'
    })
    const [dup1, dup2] = await js(
      `Promise.all([window.fask.ask(${dupInput}), window.fask.ask(${dupInput})])`
    )
    assert.deepEqual(dup1, dup2)
    const dupTurns = (s) =>
      s.questions.flatMap((q) => q.turns).filter((t) => t.raw === '중복 방지 질문')
    await wait(
      async () => {
        const turns = dupTurns(await js('window.fask.snapshot()'))
        return turns.length === 1 && turns[0].status === 'completed'
      },
      'duplicate concurrent ask completes once'
    )
    assert.deepEqual(await js(`window.fask.ask(${dupInput})`), dup1)
    assert.equal(dupTurns(await js('window.fask.snapshot()')).length, 1)
    report.checks.push('ask is idempotent by requestId')
    assert.match(
      await js(
        `window.fask.ask(${JSON.stringify({ requestId: 'dup-request', profileId, projectId: project.id, raw: '다른 내용', model: 'test-fast' })}).then(()=>'ok',e=>e.message)`
      ),
      /같은 요청 ID로 다른 내용을 보낼 수 없습니다/
    )
    report.checks.push('request hash conflict rejected')
    const slow = await js(
      `window.fask.ask(${JSON.stringify({ requestId: 'slow-request', profileId, projectId: project.id, questionId: dup1.questionId, raw: '느린 답변', model: 'test-fast' })})`
    )
    assert.match(
      await js(
        `window.fask.ask(${JSON.stringify({ requestId: 'slow-blocked', profileId, projectId: project.id, questionId: dup1.questionId, raw: '막힌 질문', model: 'test-fast' })}).then(()=>'ok',e=>e.message)`
      ),
      /이 질문의 이전 답변이 끝난 뒤 이어서 질문해 주세요/
    )
    const liveRead = `window.fask.snapshot().then(s=>window.fask.turnState(${JSON.stringify(slow.questionId)},${JSON.stringify(slow.turnId)}).then(state=>({state,turn:s.questions.find(q=>q.id===${JSON.stringify(slow.questionId)}).turns.find(t=>t.id===${JSON.stringify(slow.turnId)})})))`
    await wait(async () => (await js(liveRead)).state.revision >= 3, 'slow answer streams deltas')
    {
      const { state, turn } = await js(liveRead)
      assert.equal(state.status, 'running')
      assert.ok(state.revision >= turn.revision)
      assert.ok(state.answer.startsWith(turn.answer))
    }
    await js(`window.fask.cancel(${JSON.stringify(slow.turnId)})`)
    await wait(
      async () => {
        const q = (await js('window.fask.snapshot()')).questions.find(
          (q) => q.id === slow.questionId
        )
        return (
          q.turns.length === 2 &&
          q.turns[1].status === 'cancelled' &&
          q.turns[0].status === 'completed'
        )
      },
      'single running turn, cancel by turnId, live revision'
    )
    await js(
      `window.fask.ask(${JSON.stringify({ requestId: 'saved-image', profileId, projectId: project.id, raw: '캡처 기록', image, model: 'test-fast', saveOnly: true })})`
    )
    const backupPath = join(dataDir, 'backup.json')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: backupPath })
    assert.equal(await js('window.fask.backup()'), true)
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
    assert.equal(backup.version, 2)
    assert.equal(backup.snapshot.questions.length, QUESTION_COUNT)
    assert.deepEqual(
      Object.keys(backup.images).sort(),
      [
        ...new Set(
          backup.snapshot.questions.flatMap((q) => q.turns.map((t) => t.attachment)).filter(Boolean)
        )
      ].sort()
    )
    assert.equal(backup.snapshot.settings.hasKey, false)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backupPath] })
    assert.equal(await js('window.fask.restore()'), true)
    const restored = await js('window.fask.snapshot()')
    assert.notEqual(restored.activeProfileId, profileId)
    assert.equal(restored.questions.length, QUESTION_COUNT)
    assert.equal(restored.profiles.length, 2)
    assert.ok(restored.storageBytes > 0)
    report.checks.push('backup restores questions and capture into a separate profile')
    {
      const original = new Set(backup.snapshot.questions.flatMap((q) => q.turns.map((t) => t.id)))
      assert.ok(restored.questions.every((q) => q.turns.every((t) => !original.has(t.id))))
      report.checks.push('restore remaps turn ids')
    }
    await context('[aria-label="프로필"]')
    await js("document.querySelector('.item-context-menu .danger').click()")
    await wait(
      () =>
        js(
          `window.fask.snapshot().then(s=>s.activeProfileId===${JSON.stringify(profileId)}&&s.profiles.length===1)`
        ),
      'profile context delete removes restored copy and returns to original'
    )
    await js(
      `location.hash='/personal?scope=project&workspace=${project.workspaceId}&project=${project.id}'`
    )
    await wait(
      () => js("!!document.querySelector('.view-bar')"),
      'original project reopens after profile deletion'
    )
    await js(
      "[...document.querySelectorAll('.segmented button')].find(b=>b.textContent==='목록').click()"
    )
    await wait(
      () => js("!!document.querySelector('.question-list.compact .question-card')"),
      'list view opens'
    )
    const deletingId = (await js('window.fask.snapshot()')).questions[0].id
    await context('.question-card', 3)
    await js("document.querySelector('.item-context-menu .danger').click()")
    await wait(
      () =>
        js(
          `window.fask.snapshot().then(s=>!s.questions.some(q=>q.id===${JSON.stringify(deletingId)}))`
        ),
      'list context menu deletes question itself'
    )
    await js(
      "[...document.querySelectorAll('.segmented button')].find(b=>b.textContent==='개념 그래프').click()"
    )
    await wait(
      () => js(`!!document.querySelector('.react-flow__node[data-id="c:${concept}"]')`),
      'graph opens for concept deletion'
    )
    await context(`.react-flow__node[data-id="c:${concept}"]`)
    await js("document.querySelector('.item-context-menu .danger').click()")
    await wait(
      () =>
        js(
          `window.fask.snapshot().then(s=>!s.concepts.some(c=>c.id===${JSON.stringify(concept)})&&s.questions.every(q=>!q.conceptIds.includes(${JSON.stringify(concept)})))`
        ),
      'graph concept deletion detaches questions without deleting them'
    )
    await context('.fask-sidebar nav button')
    await js("document.querySelector('.item-context-menu .danger').click()")
    await wait(
      () =>
        js(
          `window.fask.snapshot().then(s=>!s.projects.some(p=>p.id===${JSON.stringify(project.id)})&&s.questions.length===0)`
        ),
      'project context deletion cascades through its questions'
    )
    await context('[aria-label="워크스페이스"]')
    await js("document.querySelector('.item-context-menu .danger').click()")
    await wait(
      () => js('window.fask.snapshot().then(s=>s.workspaces.length===0)'),
      'workspace context menu deletes workspace'
    )

    const restartWorkspace = await js("window.fask.create('workspace','재시작 검증')")
    const restartProject = await js(
      `window.fask.create('project','재시작 검증',${JSON.stringify(restartWorkspace)})`
    )
    await js(
      `window.fask.ask(${JSON.stringify({ requestId: 'restart-question', profileId, projectId: restartProject, raw: '앱 종료 전에 저장한 질문', model: '', saveOnly: true })})`
    )
    report.restart = {
      dataDir,
      userData: app.getPath('userData'),
      projectId: restartProject,
      geometry: rememberedGeometry
    }
    win.webContents.session.flushStorageData()
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

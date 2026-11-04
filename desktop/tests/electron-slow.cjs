// Slow-device E2E: a large project under 6x CPU throttling (the DevTools "slow phone" profile).
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { existsSync, mkdtempSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { PersonalStore } = require('./.smoke/store.cjs')
const { registerPersonal } = require('./.smoke/personal.cjs')

const CPU_RATE = 6
const QUESTIONS = 200
const IMAGES = 40
const report = { cpuRate: CPU_RATE, checks: [], timings: {}, consoleErrors: [] }
const resultPath = join(__dirname, 'slow-result.json')
const save = (phase) => {
  report.phase = phase
  writeFileSync(resultPath, JSON.stringify(report, null, 2))
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(fn, label, timeout = 8000) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(50)) if (await fn()) return
  throw new Error(`Timeout: ${label}`)
}
const check = (label) => {
  report.checks.push(label)
  save(label)
}

app.setPath('userData', mkdtempSync(join(tmpdir(), 'fask-slow-ui-')))

function answerText(i) {
  const para =
    '느린 기기에서 목록 미리보기가 긴 답변을 잘라 그리는지 확인하는 문단입니다. 인라인 수식 $a^2 + b^2 = c^2$ 도 들어 있습니다.\n\n'
  let s = `## 답변 ${i}\n\n**핵심**: *렌더링* 비용 확인.\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$\n\n`
  s += '```ts\nconst total = items.reduce((a, b) => a + b, 0)\nconsole.log(total)\n```\n\n'
  while (s.length < 2400) s += para
  s += '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n```js\nfor (const x of xs) console.log(x)\n```\n\n'
  while (s.length < 3000) s += para
  return s
}

// Seeded 2x2-block noise: compresses like a photo (badly), so encoding cost is realistic.
function noiseJpeg(seed) {
  const w = 1600,
    h = 1000,
    buf = Buffer.alloc(w * h * 4)
  let x = (seed * 2654435761) >>> 0 || 1
  for (let y = 0; y < h; y += 2)
    for (let col = 0; col < w; col += 2) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const o = ((y + dy) * w + col + dx) * 4
          buf[o] = x & 255
          buf[o + 1] = (x >>> 8) & 255
          buf[o + 2] = (x >>> 16) & 255
          buf[o + 3] = 255
        }
    }
  const jpeg = nativeImage.createFromBitmap(buf, { width: w, height: h }).toJPEG(80)
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

const turn = (id, createdAt, raw, answer, attachment) => ({
  id,
  createdAt,
  raw,
  refined: '',
  sent: raw,
  answer,
  model: 'test-fast',
  actualModel: 'test-fast',
  status: 'completed',
  complexity: 'complex',
  routingReason: '테스트 데이터',
  attachment,
  documents: [],
  error: '',
  revision: 0
})

app.whenReady().then(async () => {
  let server
  try {
    save('electron ready')
    const dataDir = mkdtempSync(join(tmpdir(), 'fask-slow-db-'))
    const asks = []
    server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'test-fast' }] }))
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const input = JSON.parse(body)
        const system = input.messages[0]?.content ?? ''
        const content = system.includes('대화 제목 생성') ? '"느린 테스트"' : '느린 기기 답변'
        if (!system.includes('대화 제목 생성')) asks.push(input.messages.at(-1)?.content)
        res.setHeader('Content-Type', 'text/event-stream')
        res.write(`data: ${JSON.stringify({ model: 'test-fast', choices: [{ delta: { content } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))

    const seed = new PersonalStore(dataDir),
      project = seed.list('project')[0]
    seed.saveSettings({
      ...seed.settings(),
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'test-fast',
      models: ['test-fast'],
      organize: false
    })
    const now = Date.now()
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
    for (let i = 0; i < QUESTIONS; i++) {
      const createdAt = at(i + 10)
      seed.put('question', seed.active, {
        id: `slow-${i}`,
        projectId: project.id,
        createdAt,
        turns: [
          turn(
            `slow-${i}-t`,
            createdAt,
            `느린 기기 질문 ${String(i).padStart(3, '0')}`,
            answerText(i),
            i % 5 === 0 ? seed.saveImage(noiseJpeg(i + 1)) : null
          )
        ],
        conceptIds: [],
        suggestions: [],
        memo: '',
        important: false
      })
    }
    // Newest, so it is the first card on page 1.
    const threeImages = [0, 1, 2].map((k) => seed.saveImage(noiseJpeg(1000 + k)))
    seed.put('question', seed.active, {
      id: 'slow-three',
      projectId: project.id,
      createdAt: at(3),
      turns: threeImages.map((image, k) =>
        turn(`slow-three-${k}`, at(3 - k), `세 장 질문 ${k + 1}`, answerText(1000 + k), image)
      ),
      conceptIds: [],
      suggestions: [],
      memo: '',
      important: false
    })
    const firstDisplay = seed.displayPath(threeImages[0])
    seed.close()
    report.seed = { questions: QUESTIONS + 1, images: IMAGES + 3 }
    save('database seeded')

    // Counts renderer image loads; each `attachment` call serves exactly one displayImage().
    let displayCalls = 0
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, fn) =>
      handle(
        channel,
        channel === 'personal:attachment'
          ? (...args) => {
              displayCalls++
              return fn(...args)
            }
          : fn
      )

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
    registerPersonal(dataDir, () => win)
    const js = (source) => win.webContents.executeJavaScript(source)
    win.showInactive()
    await win.loadFile(join(__dirname, '../out/renderer/index.html'))
    await wait(() => js("!!document.querySelector('.question-card')"), 'unthrottled first card')

    const busy =
      '(()=>{const t=performance.now();let x=0;for(let i=0;i<2e7;i++)x=(x+i*7)%1000003;return performance.now()-t})()'
    const busyMin = async () => Math.min(await js(busy), await js(busy), await js(busy))
    const baseline = await busyMin()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: CPU_RATE })

    // a. Cold start of the renderer under throttling.
    const reloaded = new Promise((r) => win.webContents.once('did-finish-load', r))
    win.webContents.reload()
    await reloaded
    let firstCard = 0
    await wait(
      async () => (firstCard = await js("document.querySelector('.question-card .markdown-answer')?performance.now():0")),
      'first question card under throttling',
      20000
    )
    report.timings.firstCardMs = Math.round(firstCard)
    report.timings.cpuSlowdown = Math.round(((await busyMin()) / baseline) * 10) / 10
    save('first card')
    assert.ok(report.timings.cpuSlowdown >= 2, `CPU throttling not applied (${report.timings.cpuSlowdown}x)`)
    assert.ok(firstCard < 4000, `first card took ${Math.round(firstCard)} ms`)
    report.timings.page2Ms = Math.round(
      await js(`new Promise((done)=>{
        const first=document.querySelector('.question-card h3').textContent
        const t=performance.now()
        document.querySelector('[aria-label="다음 페이지"]').click()
        const poll=()=>{
          const h=document.querySelector('.question-card h3')
          if(h&&h.textContent!==first&&h.parentElement.querySelector('.markdown-answer')) requestAnimationFrame(()=>setTimeout(()=>done(performance.now()-t)))
          else requestAnimationFrame(poll)
        }
        poll()
      })`)
    )
    save('page 2')
    assert.ok(report.timings.page2Ms < 1500, `page 2 took ${report.timings.page2Ms} ms`)
    assert.equal(await js("document.querySelector('.question-card h3').textContent"), '느린 기기 질문 019')
    check('a. first card and page 2 render in time under throttling')

    // b. The page itself never scrolls; the records box does.
    const scroll = await js(`(()=>{const m=document.querySelector('.fask-main'),r=document.querySelector('.records-scroll');
      return {main:[m.scrollHeight,m.clientHeight],records:[r.scrollHeight,r.clientHeight]}})()`)
    report.layout = scroll
    assert.equal(scroll.main[0], scroll.main[1], 'fask-main must not scroll')
    assert.ok(scroll.records[0] > scroll.records[1], 'records-scroll must overflow')
    check('b. fixed page height with a scrolling records box')

    // c. Selecting a card puts the detail to the right of the list.
    await js("document.querySelector('[aria-label=\"이전 페이지\"]').click()")
    await wait(
      () => js("document.querySelector('.question-card h3')?.textContent==='세 장 질문 1'"),
      'page 1 again'
    )
    await js("document.querySelector('.question-card').click()")
    await wait(() => js("!!document.querySelector('.question-detail')"), 'question detail opens')
    const split = await js(`(()=>({detail:document.querySelector('.question-detail').getBoundingClientRect().left,
      list:document.querySelector('.records-panel').getBoundingClientRect().right}))()`)
    report.layout.split = split
    assert.ok(split.detail > split.list, 'detail must sit right of the list')
    check('c. detail opens to the right of the list')

    // d. Images load only on expand, once, as WebP.
    await pause(300)
    assert.equal(displayCalls, 0, 'no image may load before expanding')
    assert.equal(await js("document.querySelectorAll('.detail-capture img').length"), 0)
    assert.equal(await js("document.querySelectorAll('.turn-question-toggle').length"), 3)
    const encodeStart = Date.now()
    await wait(() => existsSync(firstDisplay), 'webp display copy is generated', 120000)
    report.timings.webpReadyAfterOpenMs = Date.now() - encodeStart
    assert.equal(displayCalls, 0)
    await js("document.querySelector('.turn-question-toggle').click()")
    await wait(() => js("!!document.querySelector('.detail-capture img')"), 'expanded image renders', 15000)
    assert.equal(displayCalls, 1)
    assert.ok(
      await js("document.querySelector('.detail-capture img').src.startsWith('data:image/webp')"),
      'display copy must be WebP'
    )
    await js("document.querySelector('.turn-question-toggle').click()")
    await wait(() => js("!document.querySelector('.detail-capture img')"), 'collapse hides image')
    await js("document.querySelector('.turn-question-toggle').click()")
    await wait(() => js("!!document.querySelector('.detail-capture img')"), 're-expand shows image')
    assert.equal(displayCalls, 1, 'cached image must not be refetched')
    check('d. capture loads on expand only, as WebP, once')

    // e. Collapsing the library header gives the list more room.
    const before = await js("document.querySelector('.records-scroll').clientHeight")
    await js("[...document.querySelectorAll('.button-row button')].find(b=>b.textContent.includes('정보 접기')).click()")
    await wait(() => js("!document.querySelector('.project-stats')"), 'stats hidden')
    const after = await js("document.querySelector('.records-scroll').clientHeight")
    report.layout.recordsHeight = [before, after]
    assert.ok(after > before, `records box must grow (${before} → ${after})`)
    check('e. header collapse hides stats and grows the list')

    // f. Shift+Enter breaks the line; Enter sends.
    await js("[...document.querySelectorAll('.view-bar button')].find(b=>b.textContent.includes('새 질문')).click()")
    await wait(() => js("!!document.querySelector('.composer textarea')"), 'composer opens')
    await js("document.querySelector('.composer textarea').focus()")
    win.webContents.insertText('느린 기기 엔터 질문')
    await wait(
      () => js("document.querySelector('.composer textarea').value==='느린 기기 엔터 질문'"),
      'text typed'
    )
    const key = (modifiers) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers })
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers })
    }
    key(['shift'])
    await wait(() => js("document.querySelector('.composer textarea').value.includes('\\n')"), 'shift+enter newline')
    await pause(500)
    assert.equal(asks.length, 0, 'shift+enter must not send')
    key([])
    await wait(() => asks.some((c) => typeof c === 'string' && c.includes('느린 기기 엔터 질문')), 'enter sends', 15000)
    check('f. Enter sends, Shift+Enter inserts a newline')

    assert.deepEqual(report.consoleErrors, [])
    report.success = true
    save('done')
    server.close()
    app.exit(0)
  } catch (error) {
    report.success = false
    report.error = error.stack
    save(report.phase)
    server?.close()
    app.exit(1)
  }
})

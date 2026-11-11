// Electron E2E for the question note and overlay layout: the sticky note action bar (dashboard,
// expanded note, single-pane narrow/snapped/portrait windows, reference panel), the resizable and
// expandable note, and overlay reference panels next to a normal or expanded question panel.
// Run through tests/ui.cjs.
const { app, BrowserWindow, screen } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { PersonalStore } = require('./.smoke/store.cjs')
const { registerPersonal } = require('./.smoke/personal.cjs')

const shots = join(__dirname, 'screenshots')
mkdirSync(shots, { recursive: true })
const report = { checks: [], consoleErrors: [] }
const checkpoint = (phase) => {
  report.phase = phase
  writeFileSync(join(__dirname, 'ui-result.json'), JSON.stringify(report, null, 2))
}
const pass = (label) => {
  report.checks.push(label)
  checkpoint(label)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(fn, label) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return pass(label)
    await pause(100)
  }
  throw new Error(`Timeout: ${label}`)
}
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance
const intersects = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const center = (r) => ({
  x: Math.round((r.left + r.right) / 2),
  y: Math.round((r.top + r.bottom) / 2)
})
// Page helpers: rect(selector) and setValue(selector, value) for React-controlled inputs.
const HELPERS = `(()=>{if(window.__ui)return;window.__ui=1;
window.R=(e)=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
window.rect=(s)=>R(document.querySelector(s));
window.setValue=(s,v)=>{const el=document.querySelector(s);el.focus();const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
window.topAt=(x,y,s)=>!!document.elementFromPoint(x,y)?.closest(s);
})()`
/** Scrolls `scroller` to its end and measures its note action bar against it and the floating ↑☆✕. */
const STICKY = (
  scroller
) => `new Promise((done)=>{const s=document.querySelector(${JSON.stringify(scroller)});s.scrollTop=s.scrollHeight;setTimeout(()=>{
const bar=s.querySelector('.detail-action-row');const sr=R(s);const cs=getComputedStyle(s);
done({scrolled:s.scrollTop,viewTop:sr.top+parseFloat(cs.borderTopWidth),scroller:sr,bar:R(bar),buttons:[...bar.querySelectorAll('button')].map(R),
nav:[...document.querySelectorAll('.turn-nav-top.shown button')].map(R).filter((r)=>r.left>=sr.left-1&&r.right<=sr.right+1&&r.top>=sr.top-12&&r.bottom<=sr.bottom)})},300)})`
function assertSticky(m, label) {
  assert.ok(m.scrolled > 0, `${label}: the note did not scroll`)
  assert.ok(
    near(m.bar.top, m.viewTop),
    `${label}: bar top ${m.bar.top} is not at the scroller top ${m.viewTop}`
  )
  assert.ok(m.bar.bottom <= m.scroller.bottom, `${label}: bar runs past the scroller`)
  assert.ok(m.nav.length > 0, `${label}: the floating ↑☆ controls did not show`)
  for (const n of m.nav) assert.ok(n.top >= m.bar.bottom - 0.5, `${label}: the floating ↑☆ controls overlap the bar`)
  for (const b of m.buttons) {
    assert.ok(
      b.left >= m.scroller.left - 0.5 && b.right <= m.scroller.right + 0.5,
      `${label}: a bar button is clipped`
    )
    assert.ok(b.top >= m.viewTop - 0.5, `${label}: a bar button is cut off at the top`)
    for (const n of m.nav)
      assert.ok(!intersects(b, n), `${label}: a bar button sits under the floating ↑☆ controls`)
  }
  pass(`${label}: action bar pinned and unobstructed`)
}

let server
app.setPath('userData', mkdtempSync(join(tmpdir(), 'fask-ui-')))
app.whenReady().then(async () => {
  try {
    server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'test-fast' }, { id: 'test-deep' }] }))
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const input = JSON.parse(body)
        const system = input.messages[0]?.content ?? ''
        const last = input.messages.at(-1)
        const text = typeof last.content === 'string' ? last.content : ''
        const chunk = (content) =>
          `data: ${JSON.stringify({ model: 'test-fast', choices: [{ delta: { content } }] })}\n\n`
        res.setHeader('Content-Type', 'text/event-stream')
        if (system.includes('대화 제목 생성')) return res.end(`${chunk('"제목"')}data: [DONE]\n\n`)
        if (system.includes('JSON만 출력')) return res.end(`${chunk('{}')}data: [DONE]\n\n`)
        if (!text.includes('느린')) return res.end(`${chunk(`답변: ${text}`)}data: [DONE]\n\n`)
        let sent = 0
        const timer = setInterval(() => {
          if (res.destroyed) return clearInterval(timer)
          res.write(chunk(`조각${sent} `))
          if (++sent === 12) {
            clearInterval(timer)
            res.end('data: [DONE]\n\n')
          }
        }, 150)
        res.on('close', () => clearInterval(timer))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))

    const dataDir = mkdtempSync(join(tmpdir(), 'fask-ui-db-'))
    const seed = new PersonalStore(dataDir)
    const project = seed.list('project')[0]
    const other = seed.create('project', '다른 프로젝트', project.workspaceId)
    seed.saveSettings({
      ...seed.settings(),
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'test-fast',
      models: ['test-fast', 'test-deep'],
      organize: false,
      autoTitle: false,
      memoryScope: 'off'
    })
    const base = Date.now()
    const at = (minutes) => new Date(base - minutes * 60000).toISOString()
    const long = (label) => `${label} 답변 문단입니다.\n\n`.repeat(40)
    const turn = (id, sent, extra = {}) => ({
      id,
      createdAt: at(0),
      raw: sent,
      refined: '',
      sent,
      answer: long(sent),
      model: 'test-fast',
      actualModel: 'test-fast',
      status: 'completed',
      complexity: 'simple',
      routingReason: '테스트',
      attachment: null,
      documents: [],
      error: '',
      revision: 1,
      ...extra
    })
    const put = (id, projectId, minutes, title, turns, extra = {}) =>
      seed.put('question', seed.active, {
        id,
        projectId,
        createdAt: at(minutes),
        title,
        turns,
        conceptIds: [],
        suggestions: [],
        memo: '',
        important: false,
        ...extra
      })
    put('qa', project.id, 5, '참고 대상 A', [turn('ta', '질문 A')], { suggestions: ['추천개념'] })
    put('qc', project.id, 6, '참고 대상 C', [turn('tc', '질문 C')])
    put('qd', project.id, 7, '참고 대상 D', [turn('td', '질문 D')])
    put('qe', project.id, 8, '참고 대상 E', [turn('te', '질문 E')])
    put('qx', other, 9, '다른 프로젝트 질문 X', [turn('tx', '질문 X')])
    for (let i = 0; i < 30; i++)
      put(`f${i}`, project.id, 20 + i, `채우기 질문 ${i}`, [turn(`tf${i}`, `채우기 ${i}`)])
    const refs = [
      ['qa', '참고 대상 A'],
      ['qc', '참고 대상 C'],
      ['qd', '참고 대상 D'],
      ['qe', '참고 대상 E'],
      ['qx', '다른 프로젝트 질문 X']
    ].map(([id, name]) => ({ kind: 'question', id, name }))
    put('qb', project.id, 0, '현재 대화 질문 B', [
      turn('tb1', '질문 B1', { actualModel: 'test-deep' }),
      turn('tb2', '질문 B2', { references: refs })
    ])
    seed.close()

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
    win.webContents.on(
      'console-message',
      (_e, level, message) => level === 3 && report.consoleErrors.push(message)
    )
    const personal = registerPersonal(dataDir, () => win)
    const js = async (source) => {
      await win.webContents.executeJavaScript(HELPERS)
      return win.webContents.executeJavaScript(source)
    }
    const shot = async (name, w = win) => {
      w.webContents.invalidate()
      await pause(300)
      writeFileSync(join(shots, `ui-${name}.png`), (await w.webContents.capturePage()).toPNG())
    }
    await win.loadFile(join(__dirname, '../out/renderer/index.html'))
    win.showInactive()
    await wait(() => js("!!document.querySelector('.project-header')"), 'dashboard loads')

    // ---------- dashboard: search with the header collapsed ----------
    if (
      await js("document.querySelector('.header-collapse').getAttribute('aria-expanded')==='true'")
    )
      await js("document.querySelector('.header-collapse').click()")
    await wait(
      () =>
        js(
          "!!document.querySelector('.project-header.collapsed') && !!document.querySelector('.filter-row.compact .search-field input')"
        ),
      'collapsed header keeps search and filter'
    )
    await js("setValue('.search-field input','참고 대상 A')")
    await wait(
      () =>
        js(
          "(()=>{const c=[...document.querySelectorAll('.question-card')];return c.length>0&&c.every(x=>x.textContent.includes('참고 대상 A'))})()"
        ),
      'search filters while the header is collapsed'
    )
    await js("setValue('.search-field input','')")
    await wait(
      () =>
        js(
          "document.querySelectorAll('.question-card').length>1 && document.activeElement===document.querySelector('.search-field input')"
        ),
      'clearing the query keeps the search field and its focus'
    )

    // ---------- dashboard: sticky action bar ----------
    const openNote = async (title) => {
      await js(
        `[...document.querySelectorAll('.question-card')].find(c=>c.textContent.includes(${JSON.stringify(title)})).click()`
      )
      await wait(
        () =>
          js(
            `document.querySelector('.question-detail h2')?.textContent===${JSON.stringify(title)}`
          ),
        `note opens: ${title}`
      )
    }
    await openNote('현재 대화 질문 B')
    assert.equal(await js("!!document.querySelector('.question-detail .memo-label')"), false)
    assert.equal(
      await js("document.querySelector('.question-detail .turn-model').textContent"),
      'test-deep'
    )
    assert.equal(
      await js("document.querySelector('.question-detail .turn-model').title"),
      '요청한 모델: test-fast'
    )
    pass('answer head shows the model that answered, with the requested model on hover')
    assertSticky(await js(STICKY('.question-detail')), 'dashboard')
    const toggle = (label, scope = '.question-detail') =>
      js(
        `[...document.querySelectorAll('${scope} .detail-action-row button')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`
      )
    // Opening a section from the bottom of a long note brings it into view below the pinned bar.
    await toggle('메모')
    // Smooth scrolling: measure once the position stops changing.
    const measureMemo = () =>
      js(
        "({bar:R(document.querySelector('.question-detail .detail-action-row')),section:rect('.question-detail .detail-section'),scroller:rect('.question-detail'),margin:document.querySelector('.question-detail .detail-section').style.scrollMarginTop,scrollTop:document.querySelector('.question-detail').scrollTop})"
      )
    let memo = await measureMemo()
    for (let i = 0; i < 30; i++) {
      await pause(150)
      const next = await measureMemo()
      if (next.scrollTop === memo.scrollTop) break
      memo = next
    }
    report.memoMeasure = memo
    assert.ok(
      memo.section.top >= memo.bar.bottom - 1,
      `memo section ${memo.section.top} is hidden under the bar ${memo.bar.bottom}`
    )
    assert.ok(memo.section.top < memo.scroller.bottom - 40, 'memo section stays out of view')
    pass('memo opened from the bottom shows right below the pinned bar')
    await js("setValue('.question-detail .detail-section textarea','저장 안 한 메모')")
    await toggle('메모')
    await wait(
      () =>
        js(
          "!document.querySelector('.question-detail .detail-section') && !!document.querySelector('.question-detail .detail-dot')"
        ),
      'closing the memo keeps a dirty dot'
    )
    await toggle('메모')
    await wait(
      () =>
        js(
          "document.querySelector('.question-detail .detail-section textarea')?.value==='저장 안 한 메모'"
        ),
      'unsaved memo survives toggling'
    )
    await toggle('메모')
    await toggle('개념')
    await wait(
      () => js("!!document.querySelector('.question-detail .detail-section .concept-link-add')"),
      'concept section opens with linking'
    )
    await toggle('개념')
    await shot('dashboard-note')

    // ---------- dashboard: resizable and expandable note ----------
    const width = (s) => js(`rect(${JSON.stringify(s)}).width`)
    const drag = async (from, toX) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y })
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: from.x,
        y: from.y,
        button: 'left',
        clickCount: 1
      })
      for (const x of [from.x + (toX - from.x) / 2, toX])
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(x),
          y: from.y,
          button: 'left'
        })
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: toX,
        y: from.y,
        button: 'left',
        clickCount: 1
      })
      await pause(200)
    }
    const handle = async () => center(await js("rect('.detail-resizer')"))
    const defaultWidth = await width('.question-detail')
    let h = await handle()
    await drag(h, h.x - 200)
    const widened = await width('.question-detail')
    assert.ok(
      near(widened, defaultWidth + 200, 4),
      `dragging 200px left: ${defaultWidth} → ${widened}`
    )
    assert.equal(Number(await js("localStorage.getItem('fask:detail-width')")), Math.round(widened))
    pass('dragging the handle widens the note and remembers the width')
    h = await handle()
    await drag(h, 5)
    assert.ok((await width('.records-panel')) >= 299, 'the list was squeezed below 300px')
    const noOverflow = (s) =>
      js(
        `(()=>{const e=document.querySelector(${JSON.stringify(s)});return e.scrollWidth<=e.clientWidth+1})()`
      )
    assert.equal(
      await noOverflow('.records-scroll'),
      true,
      'the list overflows sideways at its minimum width'
    )
    await shot('dashboard-list-min')
    h = await handle()
    await drag(h, 1375)
    assert.ok((await width('.question-detail')) >= 339, 'the note was squeezed below 340px')
    assert.equal(
      await noOverflow('.question-detail'),
      true,
      'the note overflows sideways at its minimum width'
    )
    assertSticky(await js(STICKY('.question-detail')), 'note at its minimum width')
    await shot('dashboard-note-min')
    const windowSize = win.getSize()
    pass('dragging to either edge keeps the list ≥300px and the note ≥340px without overflow')
    // A wide stored width on a window shrunk just above the stacking breakpoint still fits.
    win.setContentSize(1120, 800)
    await pause(400)
    const fit = await js(
      "({list:rect('.records-panel').width,note:rect('.question-detail').width,area:(()=>{const a=document.querySelector('.knowledge-area');return a.scrollWidth<=a.clientWidth+1})()})"
    )
    report.shrunk = fit
    assert.ok(
      fit.list >= 299 && fit.note >= 339 && fit.area,
      `shrunk window breaks the split: ${JSON.stringify(fit)}`
    )
    pass('a remembered wide note still fits a shrunk window')
    win.setSize(...windowSize)
    await pause(300)
    const beforeKey = await width('.question-detail')
    await js(
      "(()=>{const r=document.querySelector('.detail-resizer');r.focus();r.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))})()"
    )
    await pause(100)
    assert.ok(
      near(await width('.question-detail'), beforeKey + 32, 2),
      'ArrowLeft did not widen the note by 32px'
    )
    pass('ArrowLeft on the focused handle widens the note')
    await js(
      "document.querySelector('.detail-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    )
    await wait(
      async () =>
        near(await width('.question-detail'), defaultWidth, 2) &&
        (await js("localStorage.getItem('fask:detail-width')")) === null,
      'double-click resets the default split'
    )
    h = await handle()
    await drag(h, h.x - 120)
    const kept = await width('.question-detail')
    await win.webContents.reload()
    await wait(() => js("!!document.querySelector('.project-header')"), 'dashboard reloads')
    await openNote('현재 대화 질문 B')
    assert.ok(
      near(await width('.question-detail'), kept, 2),
      'the dragged width was not restored after reload'
    )
    pass('dragged width survives a reload')

    await js("(()=>{const s=document.querySelector('.records-scroll');s.scrollTop=300})()")
    const listScroll = await js("document.querySelector('.records-scroll').scrollTop")
    assert.ok(listScroll > 0, 'the question list does not scroll')
    await js("document.querySelector('.detail-expand').click()")
    await wait(
      async () =>
        (await js(
          "getComputedStyle(document.querySelector('.records-panel')).display==='none' && !document.querySelector('.detail-resizer')"
        )) && near(await width('.question-detail'), await width('.knowledge-area'), 1),
      'expand hides the list and fills the area with the note'
    )
    assertSticky(await js(STICKY('.question-detail')), 'expanded note')
    await shot('dashboard-expanded')
    await js("document.querySelector('.detail-expand').click()")
    await wait(
      async () => near(await width('.question-detail'), kept, 2),
      'restore returns the dragged width'
    )
    assert.ok(
      near(await js("document.querySelector('.records-scroll').scrollTop"), listScroll, 1),
      'the list lost its scroll position'
    )
    pass('expand and restore keep the list scroll position')
    await js("document.querySelector('.detail-expand').click()")
    await js(
      "[...document.querySelectorAll('.question-detail header button')].find(b=>b.textContent.includes('닫기')).click()"
    )
    await wait(
      () =>
        js(
          "!document.querySelector('.question-detail') && getComputedStyle(document.querySelector('.records-panel')).display!=='none'"
        ),
      'closing an expanded note shows the list again'
    )
    await openNote('참고 대상 A')
    await wait(
      () => js("!!document.querySelector('.knowledge-area.detail-expanded')"),
      'the next note opens expanded (remembered)'
    )
    await js("document.querySelector('.detail-expand').click()")
    await js(
      "[...document.querySelectorAll('.question-detail header button')].find(b=>b.textContent.includes('닫기')).click()"
    )
    await wait(
      () => js("!document.querySelector('.question-detail')"),
      'note closes before the window checks'
    )

    // Narrow, snapped-to-half and portrait windows show the list or the note, never both.
    const fullBounds = win.getBounds()
    const singlePane = async (label) => {
      const size = await js('({w:innerWidth,h:innerHeight})')
      assert.equal(
        await js(
          "getComputedStyle(document.querySelector('.records-panel')).display!=='none' && !document.querySelector('.question-detail')"
        ),
        true,
        `${label}: the list is not shown on its own`
      )
      await js("document.querySelector('.records-scroll').scrollTop=240")
      const listScroll = await js("document.querySelector('.records-scroll').scrollTop")
      await openNote('현재 대화 질문 B')
      const m = await js(
        "({list:getComputedStyle(document.querySelector('.records-panel')).display,resizer:(()=>{const r=document.querySelector('.detail-resizer');return !r||getComputedStyle(r).display==='none'})(),expand:getComputedStyle(document.querySelector('.detail-expand')).display,note:rect('.question-detail').width,area:rect('.knowledge-area').width})"
      )
      assert.equal(m.list, 'none', `${label}: the list still shows beside the note`)
      assert.equal(m.resizer, true, `${label}: the resize handle still shows`)
      assert.equal(m.expand, 'none', `${label}: the expand button still shows`)
      assert.ok(
        near(m.note, m.area, 1),
        `${label}: the note does not fill the area (${m.note} of ${m.area})`
      )
      assertSticky(await js(STICKY('.question-detail')), `${label} ${size.w}×${size.h}`)
      await shot(`dashboard-${label.replace(/\s+/g, '-')}`)
      await js(
        "[...document.querySelectorAll('.question-detail header button')].find(b=>b.textContent.includes('닫기')).click()"
      )
      await wait(
        () =>
          js(
            `!document.querySelector('.question-detail') && getComputedStyle(document.querySelector('.records-panel')).display!=='none' && Math.abs(document.querySelector('.records-scroll').scrollTop-${listScroll})<=1`
          ),
        `${label}: closing the note returns to the list at the same scroll position`
      )
      pass(`${label} (${size.w}×${size.h}): one pane at a time`)
    }
    win.setContentSize(1000, 760)
    await pause(400)
    await singlePane('narrow window')
    // Win+← snaps the window to the left half of the work area.
    const work = screen.getDisplayMatching(fullBounds).workArea
    win.setBounds({ x: work.x, y: work.y, width: Math.floor(work.width / 2), height: work.height })
    await pause(400)
    await singlePane('snapped to half')
    // A portrait window wider than 1100px (half of a large monitor). The OS may cap the window to
    // the screen, so the viewport is emulated when the real window cannot be taller than wide.
    win.setBounds({ ...fullBounds, width: 1200, height: 1400 })
    await pause(400)
    const real = await js('innerHeight>innerWidth && innerWidth>1100')
    if (!real)
      win.webContents.enableDeviceEmulation({
        screenPosition: 'desktop',
        screenSize: { width: 1200, height: 1400 },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        viewSize: { width: 1200, height: 1400 },
        scale: 1
      })
    await pause(400)
    report.portrait = real ? 'real window' : 'emulated viewport'
    assert.equal(
      await js('innerHeight>innerWidth && innerWidth>1100'),
      true,
      'portrait viewport not reached'
    )
    await singlePane('portrait')
    win.webContents.disableDeviceEmulation()
    // Wide landscape again: list and note side by side with the handle.
    win.setBounds(fullBounds)
    await pause(400)
    await openNote('현재 대화 질문 B')
    await wait(
      () =>
        js(
          "getComputedStyle(document.querySelector('.records-panel')).display!=='none' && !!document.querySelector('.detail-resizer') && getComputedStyle(document.querySelector('.detail-resizer')).display!=='none'"
        ),
      'a wide landscape window splits list | handle | note again'
    )

    // ---------- overlay: reference panels next to a normal and an expanded panel ----------
    assert.equal(
      (await js(`window.fask.openOverlay(${JSON.stringify(project.id)}, 'qb')`)).ok,
      true
    )
    let overlay = personal.capture.overlay
    const ov = async (source) => {
      await overlay.webContents.executeJavaScript(HELPERS)
      return overlay.webContents.executeJavaScript(source)
    }
    await wait(
      () => ov("!!document.querySelector('.overlay-panel .live-answer .reference-chip')"),
      'overlay opens on the conversation with its reference chips'
    )
    // Ink drawn outside the panel must survive references and the conversation switch.
    await ov(
      "[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('펜')).click()"
    )
    overlay.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 120,
      y: 700,
      button: 'left',
      clickCount: 1
    })
    overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 220, y: 760, button: 'left' })
    overlay.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 220,
      y: 760,
      button: 'left',
      clickCount: 1
    })
    await pause(100)
    overlay.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 40,
      y: 900,
      button: 'right',
      clickCount: 1
    })
    overlay.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 40,
      y: 900,
      button: 'right',
      clickCount: 1
    })
    await wait(
      () => ov("!document.querySelector('.overlay-region')"),
      'pen mode exits with ink drawn'
    )
    if (!(await ov("!!document.querySelector('.overlay-panel')")))
      await ov(
        "[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('질문')).click()"
      )
    await wait(
      () => ov("!!document.querySelector('.overlay-panel .live-answer .reference-chip')"),
      'question panel is open with the ink kept'
    )
    const ink = () => ov("document.querySelector('canvas').toDataURL()")
    const inkBefore = await ink()
    assert.equal(
      await ov(
        "(()=>{const c=document.querySelector('canvas');return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)})()"
      ),
      true
    )
    const chip = (name) =>
      ov(
        `[...document.querySelectorAll('.overlay-panel:not(.overlay-ref-panel) .reference-chip')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`
      )
    const refTitles = () =>
      ov(
        "JSON.stringify([...document.querySelectorAll('.overlay-ref-panel .overlay-panel-thread')].map(b=>b.textContent))"
      )
    const main = '.overlay-panel:not(.overlay-ref-panel)'
    const mainRect = await ov(`rect('${main}')`)

    await chip('참고 대상 A')
    await wait(
      async () => (await refTitles()) === '["참고 대상 A"]',
      'reference opens in its own panel'
    )
    assert.equal(personal.capture.overlay, overlay)
    const refRect = await ov("rect('.overlay-ref-panel')")
    assert.ok(!intersects(refRect, mainRect), 'the reference panel covers the question panel')
    assert.ok(
      refRect.left >= 8 && refRect.top >= 8 && refRect.bottom <= (await ov('innerHeight')) - 8,
      'reference panel leaves the screen'
    )
    pass('the first reference opens beside the question panel, inside the screen')
    assertSticky(await ov(STICKY('.overlay-ref-panel .overlay-panel-content')), 'reference panel')
    await shot('overlay-reference', overlay)

    // The reference resizes from its corner, within the screen and above a minimum size.
    const resizeRef = async (dx, dy) => {
      const handle = center(
        await ov("rect('.overlay-ref-panel:last-of-type .panel-resize-handle')")
      )
      overlay.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x, y: handle.y })
      overlay.webContents.sendInputEvent({
        type: 'mouseDown',
        x: handle.x,
        y: handle.y,
        button: 'left',
        clickCount: 1
      })
      for (const f of [0.5, 1])
        overlay.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(handle.x + dx * f),
          y: Math.round(handle.y + dy * f),
          button: 'left'
        })
      overlay.webContents.sendInputEvent({
        type: 'mouseUp',
        x: handle.x + dx,
        y: handle.y + dy,
        button: 'left',
        clickCount: 1
      })
      await pause(250)
      return ov("rect('.overlay-ref-panel:last-of-type')")
    }
    const startRef = await ov("rect('.overlay-ref-panel')")
    const grown = await resizeRef(150, 100)
    assert.ok(
      near(grown.width, startRef.width + 150, 2) && near(grown.height, startRef.height + 100, 2),
      `corner drag resized ${startRef.width}×${startRef.height} to ${grown.width}×${grown.height}`
    )
    assert.ok(
      near(grown.left, startRef.left) && near(grown.top, startRef.top),
      'resizing moved the panel'
    )
    const screenSize = await ov('({w:innerWidth,h:innerHeight})')
    const capped = await resizeRef(5000, 5000)
    assert.ok(
      capped.right <= screenSize.w - 7 && capped.bottom <= screenSize.h - 7,
      'the reference grew off the screen'
    )
    const tiny = await resizeRef(-5000, -5000)
    assert.ok(
      near(tiny.width, 320, 1) && near(tiny.height, 260, 1),
      `minimum size is ${tiny.width}×${tiny.height}`
    )
    assertSticky(
      await ov(STICKY('.overlay-ref-panel .overlay-panel-content')),
      'reference panel at its minimum size'
    )
    pass('a reference resizes from its corner, capped by the screen and a 320×260 minimum')
    const sized = await resizeRef(140, 260)
    await wait(
      () =>
        personal.capture.regions.some(
          (r) => near(r.width, sized.width, 1) && near(r.height, sized.height, 1)
        ),
      'the resized reference is a hit region of its new size'
    )
    await ov("document.querySelector('.overlay-ref-panel header button').click()")
    await chip('참고 대상 A')
    await wait(async () => {
      const r = await ov("rect('.overlay-ref-panel')")
      return !!r && near(r.width, sized.width, 1) && near(r.height, sized.height, 1)
    }, 'the next reference opens at the last resized size')

    for (const name of ['참고 대상 C', '참고 대상 D', '참고 대상 E']) await chip(name)
    await wait(
      async () => (await refTitles()) === '["참고 대상 C","참고 대상 D","참고 대상 E"]',
      'a fourth reference closes the oldest'
    )
    await chip('참고 대상 C')
    await wait(
      async () => (await refTitles()) === '["참고 대상 D","참고 대상 E","참고 대상 C"]',
      'reopening an open reference brings it to the front'
    )
    await ov("document.querySelector('.toolbar-project').click()")
    await wait(
      () => ov("!!document.querySelector('.overlay-project-picker')"),
      'project picker opens beside three references'
    )
    await pause(300)
    const hitCount = await ov(
      "document.querySelectorAll('.overlay-toolbar,.toolbar-tools,.overlay-panel,.overlay-project-picker,.modal-backdrop').length"
    )
    assert.ok(hitCount <= 8, `${hitCount} hit regions exceed the main-process limit`)
    assert.equal(
      personal.capture.regions.length,
      hitCount,
      'main process rejected or missed the hit regions'
    )
    pass(`all ${hitCount} hit regions reach the main process`)
    await ov("document.querySelector('.toolbar-project').click()")
    await wait(
      () => ov("!document.querySelector('.overlay-project-picker')"),
      'project picker closes'
    )

    // Expanded panel: existing references stay on top and readable.
    await ov("document.querySelector('.panel-maximize').click()")
    await wait(
      () => ov("!!document.querySelector('.overlay-panel.maximized')"),
      'question panel expands with references open'
    )
    const stacked = await ov(
      `[...document.querySelectorAll('.overlay-ref-panel')].map((p)=>{const h=p.querySelector('header button');const r=R(h);return topAt((r.left+r.right)/2,(r.top+r.bottom)/2,'.overlay-ref-panel')})`
    )
    assert.deepEqual(
      stacked,
      [true, true, true],
      'a reference close button is hidden behind the expanded panel'
    )
    const front = await ov("rect('.overlay-ref-panel:last-of-type')")
    assert.equal(
      await ov(`topAt(${center(front).x},${center(front).y},'.overlay-ref-panel')`),
      true
    )
    pass('references stay above the expanded panel and remain clickable')
    for (let i = 0; i < 3; i++)
      await ov("document.querySelector('.overlay-ref-panel header button').click()")
    await wait(async () => (await refTitles()) === '[]', 'references close one by one')
    await chip('참고 대상 A')
    await wait(
      async () => (await refTitles()) === '["참고 대상 A"]',
      'a reference opens over the expanded panel'
    )
    const over = await ov(
      `({ref:rect('.overlay-ref-panel'),header:rect('${main} > header'),thread:rect('${main} .overlay-panel-thread'),buttons:[...document.querySelectorAll('${main} > header button')].map(R),h:innerHeight})`
    )
    assert.ok(over.ref.top >= over.header.bottom, 'the reference covers the expanded panel header')
    assert.ok(over.ref.bottom <= over.h - 8, 'the reference runs off the screen')
    for (const r of [over.thread, ...over.buttons])
      assert.ok(!intersects(r, over.ref), 'the expanded header is covered')
    pass('a reference over the expanded panel leaves its header title and buttons visible')
    // The expanded panel's floating ↑☆ (portaled above every panel) must not cover the reference.
    await ov(
      `(()=>{const s=document.querySelector('${main} .overlay-panel-content');s.scrollTop=s.scrollHeight})()`
    )
    await pause(200)
    const refClose = center(
      await ov("R(document.querySelector('.overlay-ref-panel header button'))")
    )
    assert.equal(await ov(`topAt(${refClose.x},${refClose.y},'.overlay-ref-panel')`), true)
    pass("the expanded panel's floating controls do not cover the reference")
    await shot('overlay-expanded-reference', overlay)
    await ov("document.querySelector('.panel-maximize').click()")
    await wait(
      async () => JSON.stringify(await ov(`rect('${main}')`)) === JSON.stringify(mainRect),
      'restore returns the panel to its old geometry'
    )

    // Closing the question panel keeps references open and focusable.
    await ov("document.querySelector('.panel-close').click()")
    await wait(
      () =>
        ov(`!document.querySelector('${main}') && !!document.querySelector('.overlay-ref-panel')`),
      'references stay when the question panel folds'
    )
    await wait(
      () => personal.capture.panelOpen === true,
      'an open reference keeps panel focus for typing'
    )
    await ov(
      "[...document.querySelectorAll('.overlay-toolbar button')].find(b=>b.textContent.includes('질문')).click()"
    )
    await wait(
      () => ov(`!!document.querySelector('${main}')`),
      'question panel reopens next to the reference'
    )

    // Continue from a reference while the main conversation is still streaming.
    await ov(
      `(()=>{const c=document.querySelector('${main} [aria-label="화면 캡처 포함"]');if(c&&c.checked)c.click()})()`
    )
    await ov(`setValue('${main} .composer > textarea','느린 질문')`)
    await ov(`document.querySelector('${main} .composer-actions .primary').click()`)
    await wait(
      () =>
        ov(
          `document.querySelector('${main} .live-answer-label')?.textContent.startsWith('답변 작성 중')`
        ),
      'main conversation is streaming'
    )
    await ov("document.querySelector('.overlay-ref-panel .reply-button').click()")
    await wait(
      () =>
        ov(
          `!document.querySelector('.overlay-ref-panel') && document.querySelector('${main} .overlay-panel-thread')?.textContent.includes('참고 대상 A')`
        ),
      'continue switches the panel to the reference in place'
    )
    assert.equal(personal.capture.overlay, overlay)
    assert.equal(await ink(), inkBefore)
    pass('the overlay window and its ink survive the switch')
    await wait(
      () =>
        js(
          "window.fask.snapshot().then(s=>s.questions.find(q=>q.id==='qb').turns.some(t=>t.raw==='느린 질문'&&t.status==='completed'))"
        ),
      'the answer that was streaming still completes'
    )

    // A reference from another project continues there (a reopened overlay, ink no longer needed).
    assert.equal(
      (await js(`window.fask.openOverlay(${JSON.stringify(project.id)}, 'qb')`)).ok,
      true
    )
    overlay = personal.capture.overlay
    await wait(
      () =>
        ov(
          `document.querySelector('${main} .overlay-panel-thread')?.textContent.includes('현재 대화 질문 B') && !!document.querySelector('${main} .reference-chip')`
        ),
      'overlay reopens on the conversation with references'
    )
    await chip('다른 프로젝트 질문 X')
    await wait(
      async () => (await refTitles()) === '["다른 프로젝트 질문 X"]',
      'a reference from another project opens'
    )
    await ov("document.querySelector('.overlay-ref-panel .reply-button').click()")
    await wait(
      () =>
        ov(
          `location.hash.includes(${JSON.stringify(`project=${other}`)}) && document.querySelector('${main} header small')?.textContent.includes('다른 프로젝트') && document.querySelector('${main} .overlay-panel-thread')?.textContent.includes('다른 프로젝트 질문 X')`
        ),
      'continuing a reference from another project switches the project in place'
    )
    assert.equal(personal.capture.overlay, overlay)

    report.success = true
    checkpoint('done')
    app.exit(0)
  } catch (error) {
    report.success = false
    report.error = String(error?.stack ?? error)
    checkpoint('failed')
    app.exit(1)
  } finally {
    server?.close()
  }
})

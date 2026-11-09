import { BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { is } from '@electron-toolkit/utils'
import type {
  CapturePreview,
  CaptureRegion,
  CaptureRegionSaved,
  CaptureRect,
  CaptureResult,
  CaptureSetupRequired,
  CaptureSetupReason
} from '../preload/personal'
import type { PersonalStore } from './personal-store'
import { t } from '../shared/i18n'
import { captureSetupMessage, selectCaptureDisplay } from '../shared/capture'

class CaptureSetupError extends Error {
  constructor(readonly reason: CaptureSetupReason) {
    super(captureSetupMessage(reason))
  }
}

export class PersonalCapture {
  overlay: BrowserWindow | null = null
  editor: BrowserWindow | null = null
  displayId: number | null = null
  preview: CapturePreview | null = null
  private overlayScreenSize: { width: number; height: number } | null = null
  private overlayHadRegion = false
  private busy = false
  private hitTimer: ReturnType<typeof setInterval> | null = null
  private regions: CaptureRect[] = []
  private drawing = false
  private panelOpen = false
  private accepting = false
  private releasingFocus = false
  constructor(
    private store: PersonalStore,
    private main: () => BrowserWindow | null,
    private changed: () => void
  ) {}
  private load(win: BrowserWindow, hash: string): void {
    if (is.dev && process.env.ELECTRON_RENDERER_URL)
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  private captureDisplay(id: number, width?: number, height?: number): Electron.Display {
    const displays = screen.getAllDisplays()
    if (displays.length === 0) throw new CaptureSetupError('no-displays')
    const display = displays.find((d) => d.id === id)
    if (!display) throw new CaptureSetupError('display-missing')
    if (
      (width !== undefined && display.bounds.width !== width) ||
      (height !== undefined && display.bounds.height !== height)
    )
      throw new CaptureSetupError('region-changed')
    return display
  }
  private window(displayId: number, width?: number, height?: number): BrowserWindow {
    const display = this.captureDisplay(displayId, width, height)
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    try {
      // Windows excludes these windows from desktop composition captures, including
      // a previous editor's full-screen preview. Hiding alone can leave a stale frame.
      if (process.platform === 'win32') win.setContentProtection(true)
      // Both the editor and pen overlay use normalized full-monitor coordinates.
      // A normal window is constrained to the work area on Windows.
      win.setFullScreen(true)
      return win
    } catch (error) {
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
  }
  displays(): { id: number; label: string; width: number; height: number }[] {
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || t('모니터 {{n}}', { n: i + 1 }),
      width: d.bounds.width,
      height: d.bounds.height
    }))
  }
  open(projectId: string, showPanel = false): CaptureResult<void> {
    if (this.editor) throw new Error('캡처 영역 설정을 먼저 마쳐 주세요.')
    let win: BrowserWindow | undefined
    let display: Electron.Display
    let hasRegion: boolean
    try {
      const displays = screen.getAllDisplays()
      if (displays.length === 0) return { ok: false, reason: 'no-displays' }
      const settings = this.store.settings()
      if (settings.displayId === undefined && settings.regions.length > 0)
        return { ok: false, reason: 'display-selection-required' }
      const id =
        settings.displayId ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
      display = this.captureDisplay(id)
      const region = settings.regions.find((r) => r.displayId === id)
      if (
        (!region && settings.regions.length > 0) ||
        (region &&
          (region.screenWidth !== display.bounds.width ||
            region.screenHeight !== display.bounds.height))
      )
        return { ok: false, reason: 'region-changed' }
      hasRegion = region !== undefined
      win = this.window(id, display.bounds.width, display.bounds.height)
      win.setIgnoreMouseEvents(true, { forward: true })
      win.setAlwaysOnTop(true, 'screen-saver')
      const current = this.captureDisplay(id, display.bounds.width, display.bounds.height)
      if (current.bounds.x !== display.bounds.x || current.bounds.y !== display.bounds.y)
        throw new CaptureSetupError('region-changed')
    } catch (error) {
      if (win && !win.isDestroyed()) win.destroy()
      if (error instanceof CaptureSetupError) return { ok: false, reason: error.reason }
      throw error
    }
    const candidate = win
    candidate.on('blur', () => {
      if (this.overlay !== candidate) return
      if (this.releasingFocus) {
        this.releasingFocus = false
        return
      }
      // Capturing deliberately hides our windows; that is not an outside click.
      if (this.busy || !candidate.isVisible()) return
      this.drawing = false
      candidate.webContents.send('personal:outside-click')
      this.hitTest()
    })
    candidate.once('ready-to-show', () => {
      if (this.overlay !== candidate) return
      if (this.panelOpen) candidate.show()
      else candidate.showInactive()
    })
    candidate.on('closed', () => {
      if (this.overlay === candidate) {
        this.stopHitTest()
        this.overlay = null
        this.displayId = null
        this.overlayScreenSize = null
        this.overlayHadRegion = false
      }
    })
    this.load(
      candidate,
      `/personal-overlay?project=${encodeURIComponent(projectId)}&profile=${this.store.active}${showPanel ? '&panel=1' : ''}`
    )
    const previous = this.overlay
    this.stopHitTest()
    this.overlay = candidate
    this.displayId = display.id
    this.overlayScreenSize = { width: display.bounds.width, height: display.bounds.height }
    this.overlayHadRegion = hasRegion
    this.drawing = false
    this.panelOpen = false
    this.releasingFocus = false
    const bounds = candidate.getBounds()
    this.regions = [
      { x: bounds.width - 106, y: Math.max(0, bounds.height / 2 - 280), width: 101, height: 560 }
    ]
    this.accepting = false
    previous?.destroy()
    this.hitTimer = setInterval(() => this.hitTest(), 30)
    this.hitTimer.unref()
    this.main()?.hide()
    return { ok: true, value: undefined }
  }
  captureSetupRequired(): CaptureSetupRequired | null {
    try {
      const displays = screen.getAllDisplays()
      if (displays.length === 0) return { ok: false, reason: 'no-displays' }
      const win = this.overlay
      const id = this.displayId
      if (!win || win.isDestroyed() || id === null)
        return { ok: false, reason: 'region-changed' }
      const display = this.captureDisplay(id)
      const settings = this.store.settings()
      const region = settings.regions.find((r) => r.displayId === id)
      const bounds = win.getBounds()
      if (
        (!region && (this.overlayHadRegion || settings.regions.length > 0)) ||
        (region &&
          (region.screenWidth !== display.bounds.width ||
            region.screenHeight !== display.bounds.height)) ||
        !this.overlayScreenSize ||
        this.overlayScreenSize.width !== display.bounds.width ||
        this.overlayScreenSize.height !== display.bounds.height ||
        bounds.x !== display.bounds.x ||
        bounds.y !== display.bounds.y ||
        bounds.width !== display.bounds.width ||
        bounds.height !== display.bounds.height
      )
        return { ok: false, reason: 'region-changed' }
      return null
    } catch (error) {
      if (error instanceof CaptureSetupError) return { ok: false, reason: error.reason }
      throw error
    }
  }
  editorSetupRequired(): CaptureSetupRequired | null {
    if (!this.editor || this.editor.isDestroyed() || !this.preview)
      throw new Error('캡처 편집 화면을 다시 열어 주세요.')
    try {
      const { id, width, height } = this.preview.display
      this.captureDisplay(id, width, height)
      return null
    } catch (error) {
      if (error instanceof CaptureSetupError) return { ok: false, reason: error.reason }
      throw error
    }
  }
  presentRecovery(): void {
    const win = this.overlay
    if (!win || win.isDestroyed()) return
    const displays = screen.getAllDisplays()
    if (displays.length === 0) return
    let display = displays.find((d) => d.id === this.displayId)
    if (!display) {
      const primaryId = screen.getPrimaryDisplay().id
      display = displays.find((d) => d.id === primaryId) ?? displays[0]
    }
    const bounds = win.getBounds()
    if (
      bounds.x !== display.bounds.x ||
      bounds.y !== display.bounds.y ||
      bounds.width !== display.bounds.width ||
      bounds.height !== display.bounds.height
    ) {
      // This only makes recovery visible; Apply must still rebind the live capture.
      win.setFullScreen(false)
      win.setBounds(display.bounds)
      win.setFullScreen(true)
    }
    if (!this.editor || this.editor.isDestroyed()) {
      win.show()
      win.focus()
    }
  }
  close(): void {
    this.stopHitTest()
    this.overlay?.destroy()
    this.overlay = null
    this.main()?.show()
    this.changed()
  }
  setRegions(drawing: boolean, regions: CaptureRect[], panelOpen: boolean): void {
    if (
      typeof panelOpen !== 'boolean' ||
      !Array.isArray(regions) ||
      regions.length > 8 ||
      regions.some(
        (r) => ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0
      )
    )
      throw new Error('잘못된 도구 영역입니다.')
    const focusPanel = panelOpen && !this.panelOpen
    this.drawing = drawing
    this.regions = regions
    this.panelOpen = panelOpen
    // Focus only after the renderer has installed the opened panel's hit regions.
    // A shortcut toggle can otherwise race a queued report for the closed panel.
    const win = this.overlay
    if (focusPanel && !this.busy && win && !win.isDestroyed() && win.isVisible()) win.focus()
    this.hitTest()
  }
  private stopHitTest(): void {
    if (this.hitTimer) clearInterval(this.hitTimer)
    this.hitTimer = null
  }
  private hitTest(): void {
    const win = this.overlay
    if (!win || win.isDestroyed() || !win.isVisible() || this.busy) return
    const cursor = screen.getCursorScreenPoint(),
      bounds = win.getBounds()
    const x = cursor.x - bounds.x,
      y = cursor.y - bounds.y
    const next =
      this.drawing ||
      this.regions.some(
        (r) => x >= r.x - 3 && x <= r.x + r.width + 3 && y >= r.y - 3 && y <= r.y + r.height + 3
      )
    if (next !== this.accepting) {
      win.setIgnoreMouseEvents(!next, { forward: true })
      this.accepting = next
    }
    // Relinquish our own keyboard focus after leaving an idle toolbar, but keep
    // an open question's input focused until a real click/blur (not mouseleave).
    if (!next && !this.panelOpen && win.isFocused()) {
      // This blur follows a closed panel/toolbar leave, not an outside click.
      // Do not queue a renderer close that could race the next shortcut open.
      this.releasingFocus = true
      win.blur()
      // A no-op blur (window still focused) must not swallow the next real outside click.
      if (win.isFocused()) this.releasingFocus = false
    }
  }
  toggleQuestionPanel(): void {
    if (this.busy || !this.overlay || this.overlay.isDestroyed()) return
    this.drawing = false
    this.overlay.showInactive()
    this.overlay.webContents.send('personal:toggle-panel')
    this.hitTest()
  }
  showDashboard(): void {
    this.close()
  }
  private hideCaptureWindows(): () => void {
    const focused = BrowserWindow.getFocusedWindow()
    const visible = BrowserWindow.getAllWindows().filter((win) => win.isVisible())
    // Capture the desktop, never another FASK window displaying an earlier capture.
    for (const win of visible) win.hide()
    return () => {
      for (const win of visible) if (!win.isDestroyed()) win.showInactive()
      // Restore only the FASK window active before this explicit capture action.
      // Hover hit-testing must never activate either FASK or an arbitrary other app.
      if (focused && !focused.isDestroyed() && focused.isVisible()) focused.focus()
      this.hitTest()
    }
  }
  private async screenshot(
    id: number,
    expectedWidth?: number,
    expectedHeight?: number
  ): Promise<Electron.NativeImage> {
    const display = this.captureDisplay(id, expectedWidth, expectedHeight)
    const { width, height } = display.bounds
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * display.scaleFactor),
        height: Math.round(height * display.scaleFactor)
      }
    })
    this.captureDisplay(id, width, height)
    const source = sources.find((s) => s.display_id === String(id))
    if (!source || source.thumbnail.isEmpty())
      throw new Error('모니터를 캡처할 수 없습니다. 화면 기록 권한을 확인해 주세요.')
    return source.thumbnail
  }
  async edit(id: number): Promise<CaptureResult<void>> {
    if (this.busy || this.editor) throw new Error('다른 캡처 창을 먼저 닫아 주세요.')
    const displays = this.displays()
    const displayId = selectCaptureDisplay(displays, id)
    if (displayId === undefined)
      return {
        ok: false,
        reason: displays.length === 0 ? 'no-displays' : 'display-selection-required'
      }
    const display = displays.find((d) => d.id === displayId)!
    this.busy = true
    let resume: (() => void) | undefined
    try {
      resume = this.hideCaptureWindows()
      await sleep(180)
      const image = await this.screenshot(displayId, display.width, display.height)
      const saved =
        this.store.settings().regions.find(
          (r) =>
            r.displayId === displayId &&
            r.screenWidth === display.width &&
            r.screenHeight === display.height
        ) ?? null
      const preview = { image: image.toDataURL(), display, region: saved }
      const win = this.window(displayId, display.width, display.height)
      this.preview = preview
      this.editor = win
      win.once('ready-to-show', () => win.show())
      win.setAlwaysOnTop(true, 'screen-saver')
      win.on('closed', () => {
        this.editor = null
        this.preview = null
        resume?.()
        this.changed()
      })
      this.load(win, '/capture-editor')
      return { ok: true, value: undefined }
    } catch (e) {
      resume?.()
      if (e instanceof CaptureSetupError) return { ok: false, reason: e.reason }
      throw e
    } finally {
      this.busy = false
    }
  }
  saveRegion(region: CaptureRegion): CaptureResult<CaptureRegionSaved> {
    const preview = this.preview
    if (
      !this.editor ||
      this.editor.isDestroyed() ||
      !preview ||
      preview.display.id !== region.displayId
    )
      throw new Error('캡처 편집 화면을 다시 열어 주세요.')
    const { x, y, width, height } = region.rect
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1.000001 ||
      y + height > 1.000001
    )
      throw new Error('영역은 모니터 안에 있어야 합니다.')
    const win = this.overlay && !this.overlay.isDestroyed() ? this.overlay : null
    const previousBounds = win?.getBounds()
    const previousFullscreen = win?.isFullScreen() ?? false
    const previousAccepting = this.accepting
    let moved = false
    let mouseIgnored = false
    try {
      const display = this.captureDisplay(
        region.displayId,
        preview.display.width,
        preview.display.height
      )
      const saved: CaptureRegion = {
        ...region,
        screenWidth: display.bounds.width,
        screenHeight: display.bounds.height
      }
      const overlayChanged =
        win !== null &&
        (this.displayId !== display.id ||
          this.overlayScreenSize?.width !== display.bounds.width ||
          this.overlayScreenSize?.height !== display.bounds.height ||
          previousBounds!.width !== display.bounds.width ||
          previousBounds!.height !== display.bounds.height)
      if (win) {
        // Keep the existing renderer and its unsent question while rebinding its monitor.
        moved = true
        if (process.platform === 'win32') win.setFullScreen(false)
        win.setBounds(display.bounds)
        win.setFullScreen(true)
      }
      const current = this.captureDisplay(
        display.id,
        preview.display.width,
        preview.display.height
      )
      if (current.bounds.x !== display.bounds.x || current.bounds.y !== display.bounds.y)
        throw new CaptureSetupError('region-changed')
      if (win && overlayChanged) {
        mouseIgnored = true
        win.setIgnoreMouseEvents(true, { forward: true })
      }
      const settings = this.store.settings()
      this.store.saveSettings({
        ...settings,
        displayId: saved.displayId,
        regions: [...settings.regions.filter((r) => r.displayId !== saved.displayId), saved]
      })
      if (win) {
        this.displayId = saved.displayId
        this.overlayScreenSize = { width: saved.screenWidth, height: saved.screenHeight }
        this.overlayHadRegion = true
        if (overlayChanged) {
          this.drawing = false
          this.regions = []
          this.accepting = false
        }
      }
      return { ok: true, value: { region: saved, overlayChanged } }
    } catch (error) {
      try {
        if (moved && win && previousBounds && !win.isDestroyed()) {
          win.setFullScreen(false)
          win.setBounds(previousBounds)
          win.setFullScreen(previousFullscreen)
        }
      } finally {
        if (mouseIgnored && win && !win.isDestroyed())
          win.setIgnoreMouseEvents(!previousAccepting, { forward: true })
      }
      if (error instanceof CaptureSetupError) return { ok: false, reason: error.reason }
      throw error
    }
  }
  async question(strokes?: string): Promise<CaptureResult<string>> {
    if (this.busy) throw new Error('캡처가 진행 중입니다.')
    const win = this.overlay,
      id = this.displayId
    if (!win || win.isDestroyed() || id === null)
      throw new Error('질문 오버레이를 먼저 열어 주세요.')
    const issue = this.captureSetupRequired()
    if (issue) return issue
    this.busy = true
    let resume: (() => void) | undefined
    try {
      resume = this.hideCaptureWindows()
      await sleep(180)
      const beforeCapture = this.captureSetupRequired()
      if (beforeCapture) return beforeCapture
      const display = this.captureDisplay(
        id,
        this.overlayScreenSize!.width,
        this.overlayScreenSize!.height
      )
      const image = await this.screenshot(id, display.bounds.width, display.bounds.height)
      if (this.overlay !== win || this.displayId !== id)
        return { ok: false, reason: 'region-changed' }
      const afterCapture = this.captureSetupRequired()
      if (afterCapture) return afterCapture
      const region = this.store.settings().regions.find((r) => r.displayId === id)
      const size = image.getSize()
      const rect = region?.rect ?? { x: 0, y: 0, width: 1, height: 1 }
      const crop = {
        x: Math.floor(rect.x * size.width),
        y: Math.floor(rect.y * size.height),
        width: Math.max(1, Math.floor(rect.width * size.width)),
        height: Math.max(1, Math.floor(rect.height * size.height))
      }
      crop.width = Math.min(crop.width, size.width - crop.x)
      crop.height = Math.min(crop.height, size.height - crop.y)
      // Composite using native bitmap data; no unselected screen pixels leave main.
      if (strokes) {
        if (!strokes.startsWith('data:image/png;base64,') || strokes.length > 36_000_000)
          throw new Error('펜 이미지가 너무 큽니다.')
        // Place ink by the overlay's real content bounds; Windows may offset/shrink the
        // window (taskbar, DPI rounding), so stretching ink to the full screen misaligns it.
        const db = display.bounds
        const cb = win.getContentBounds()
        const sx = size.width / db.width,
          sy = size.height / db.height
        const ox = Math.round((cb.x - db.x) * sx),
          oy = Math.round((cb.y - db.y) * sy)
        const inkSize = { width: Math.round(cb.width * sx), height: Math.round(cb.height * sy) }
        const ink = nativeImage.createFromDataURL(strokes).resize(inkSize)
        const background = image.toBitmap(),
          foreground = ink.toBitmap()
        for (let iy = 0; iy < inkSize.height; iy++) {
          const by = iy + oy
          if (by < 0 || by >= size.height) continue
          for (let ix = 0; ix < inkSize.width; ix++) {
            const bx = ix + ox
            if (bx < 0 || bx >= size.width) continue
            const f = (iy * inkSize.width + ix) * 4,
              b = (by * size.width + bx) * 4
            const alpha = foreground[f + 3] / 255
            if (!alpha) continue
            for (let channel = 0; channel < 3; channel++)
              background[b + channel] = Math.round(
                foreground[f + channel] * alpha + background[b + channel] * (1 - alpha)
              )
          }
        }
        const selected = nativeImage.createFromBitmap(background, size).crop(crop)
        return {
          ok: true,
          value:
            this.store.settings().retention === 'balanced'
              ? `data:image/jpeg;base64,${selected.toJPEG(90).toString('base64')}`
              : selected.toDataURL()
        }
      }
      const selected = image.crop(crop)
      return {
        ok: true,
        value:
          this.store.settings().retention === 'balanced'
            ? `data:image/jpeg;base64,${selected.toJPEG(90).toString('base64')}`
            : selected.toDataURL()
      }
    } catch (error) {
      if (error instanceof CaptureSetupError) return { ok: false, reason: error.reason }
      throw error
    } finally {
      this.busy = false
      resume?.()
    }
  }
}

import { BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { is } from '@electron-toolkit/utils'
import type { CapturePreview, CaptureRegion, CaptureRect } from '../preload/personal'
import type { PersonalStore } from './personal-store'

export class PersonalCapture {
  overlay: BrowserWindow | null = null
  editor: BrowserWindow | null = null
  displayId: number | null = null
  preview: CapturePreview | null = null
  private busy = false
  private hitTimer: ReturnType<typeof setInterval> | null = null
  private regions: CaptureRect[] = []
  private drawing = false
  private accepting = false
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
  private window(displayId: number): BrowserWindow {
    const display = screen.getAllDisplays().find((d) => d.id === displayId)
    if (!display) throw new Error('설정한 모니터가 없습니다. 캡처 영역을 다시 설정해 주세요.')
    return new BrowserWindow({
      ...display.bounds,
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
  }
  displays(): { id: number; label: string; width: number; height: number }[] {
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `모니터 ${i + 1}`,
      width: d.bounds.width,
      height: d.bounds.height
    }))
  }
  open(projectId: string, showPanel = false): void {
    this.store.record('project', projectId)
    if (this.editor) throw new Error('캡처 영역 설정을 먼저 마쳐 주세요.')
    this.stopHitTest()
    this.overlay?.destroy()
    const settings = this.store.settings()
    const id = settings.displayId ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    const win = this.window(id)
    this.overlay = win
    this.displayId = id
    this.drawing = false
    const bounds = win.getBounds()
    this.regions = [
      { x: bounds.width - 90, y: Math.max(0, bounds.height / 2 - 280), width: 85, height: 560 }
    ]
    this.accepting = false
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.on('closed', () => {
      if (this.overlay === win) {
        this.stopHitTest()
        this.overlay = null
        this.displayId = null
      }
    })
    this.load(
      win,
      `/personal-overlay?project=${encodeURIComponent(projectId)}&profile=${this.store.active}${showPanel ? '&panel=1' : ''}`
    )
    this.hitTimer = setInterval(() => this.hitTest(), 30)
    this.hitTimer.unref()
    this.main()?.hide()
  }
  close(): void {
    this.stopHitTest()
    this.overlay?.destroy()
    this.overlay = null
    this.main()?.show()
    this.changed()
  }
  setRegions(drawing: boolean, regions: CaptureRect[]): void {
    if (
      !Array.isArray(regions) ||
      regions.length > 8 ||
      regions.some(
        (r) => ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0
      )
    )
      throw new Error('잘못된 도구 영역입니다.')
    this.drawing = drawing
    this.regions = regions
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
  }
  toggleQuestionPanel(): void {
    if (!this.overlay || this.overlay.isDestroyed()) return
    this.drawing = false
    this.overlay.show()
    this.overlay.focus()
    this.overlay.webContents.send('personal:toggle-panel')
    this.hitTest()
  }
  showDashboard(): void {
    this.close()
  }
  private async screenshot(id: number): Promise<Electron.NativeImage> {
    const display = screen.getAllDisplays().find((d) => d.id === id)
    if (!display) throw new Error('모니터 연결이 바뀌었습니다. 캡처 영역을 다시 설정해 주세요.')
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor)
      }
    })
    const source = sources.find((s) => s.display_id === String(id))
    if (!source || source.thumbnail.isEmpty())
      throw new Error('모니터를 캡처할 수 없습니다. 화면 기록 권한을 확인해 주세요.')
    return source.thumbnail
  }
  async edit(id: number): Promise<void> {
    if (this.busy || this.editor) throw new Error('다른 캡처 창을 먼저 닫아 주세요.')
    this.busy = true
    const main = this.main()
    const overlay = this.overlay
    const resume = (): void => {
      if (overlay && !overlay.isDestroyed()) {
        overlay.show()
        this.hitTest()
      } else main?.show()
    }
    overlay?.hide()
    main?.hide()
    try {
      await sleep(180)
      const image = await this.screenshot(id)
      const display = this.displays().find((d) => d.id === id)!
      const saved = this.store.settings().regions.find((r) => r.displayId === id) ?? null
      this.preview = { image: image.toDataURL(), display, region: saved }
      const win = this.window(id)
      this.editor = win
      win.setAlwaysOnTop(true, 'screen-saver')
      win.on('closed', () => {
        this.editor = null
        this.preview = null
        resume()
        this.changed()
      })
      this.load(win, '/capture-editor')
    } catch (e) {
      resume()
      throw e
    } finally {
      this.busy = false
    }
  }
  saveRegion(region: CaptureRegion): void {
    const display = this.displays().find((d) => d.id === region.displayId)
    if (!this.editor || !display || !this.preview || this.preview.display.id !== region.displayId)
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
    const settings = this.store.settings()
    settings.regions = [
      ...settings.regions.filter((r) => r.displayId !== region.displayId),
      { ...region, screenWidth: display.width, screenHeight: display.height }
    ]
    settings.displayId = region.displayId
    this.store.saveSettings(settings)
    this.editor.close()
  }
  async question(strokes?: string): Promise<string> {
    if (this.busy) throw new Error('캡처가 진행 중입니다.')
    const win = this.overlay,
      id = this.displayId
    if (!win || id === null) throw new Error('질문 오버레이를 먼저 열어 주세요.')
    this.busy = true
    win.hide()
    try {
      await sleep(180)
      const display = this.displays().find((d) => d.id === id)
      if (!display) throw new Error('모니터가 변경되었습니다.')
      const region = this.store.settings().regions.find((r) => r.displayId === id)
      if (
        region &&
        (region.screenWidth !== display.width || region.screenHeight !== display.height)
      )
        throw new Error('화면 크기가 바뀌었습니다. 설정에서 캡처 영역을 다시 확인해 주세요.')
      const image = await this.screenshot(id)
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
        const db = screen.getAllDisplays().find((d) => d.id === id)!.bounds
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
        return this.store.settings().retention === 'balanced'
          ? `data:image/jpeg;base64,${selected.toJPEG(90).toString('base64')}`
          : selected.toDataURL()
      }
      const selected = image.crop(crop)
      return this.store.settings().retention === 'balanced'
        ? `data:image/jpeg;base64,${selected.toJPEG(90).toString('base64')}`
        : selected.toDataURL()
    } finally {
      this.busy = false
      if (!win.isDestroyed()) {
        win.showInactive()
        win.setAlwaysOnTop(true, 'screen-saver')
      }
    }
  }
}

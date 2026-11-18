import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../preload/personal'

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Checks GitHub Releases for a newer installer (latest.yml), downloads it in the background and
 * installs only when the user asks. Packaged builds only; a failed check stays silent and retries
 * on the next interval. The download is verified against the sha512 in latest.yml.
 */
export class Updater {
  private current: UpdateState = { state: 'idle', version: null, percent: 0 }
  private timers: NodeJS.Timeout[] = []

  constructor(private changed: () => void) {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    // The user installs from the notification; nothing installs silently on quit.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent)
      if (percent !== this.current.percent) this.set({ ...this.current, percent })
    })
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, percent: 100 }))
    autoUpdater.on('error', () => {
      // A half-finished download starts over on the next check; a ready update stays installable.
      if (this.current.state !== 'ready') this.set({ state: 'idle', version: null, percent: 0 })
    })
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS))
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS))
  }

  state(): UpdateState {
    return { ...this.current }
  }

  /** Quits and runs the downloaded installer silently, then relaunches the app. */
  install(): void {
    if (this.current.state !== 'ready') throw new Error('설치할 업데이트가 없습니다.')
    autoUpdater.quitAndInstall(true, true)
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  private check(): void {
    if (this.current.state !== 'idle') return
    autoUpdater.checkForUpdates().catch(() => {})
  }

  private set(next: UpdateState): void {
    this.current = next
    this.changed()
  }
}

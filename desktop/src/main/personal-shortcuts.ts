import { globalShortcut } from 'electron'
import type { ShortcutInfo } from '../preload/personal'

let state: ShortcutInfo = { accelerator: null, fallback: false }
export function registerQuestionShortcut(activate: () => void): ShortcutInfo {
  for (const [index, accelerator] of [
    'CommandOrControl+Shift+Space',
    'CommandOrControl+Alt+Space'
  ].entries()) {
    try {
      if (globalShortcut.register(accelerator, activate)) {
        state = { accelerator, fallback: index > 0 }
        return state
      }
    } catch {
      /* Try the fallback if the OS rejects this combination. */
    }
  }
  state = { accelerator: null, fallback: false }
  return state
}
export function questionShortcutInfo(): ShortcutInfo {
  return { ...state }
}

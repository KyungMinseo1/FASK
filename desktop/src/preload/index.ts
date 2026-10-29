import { contextBridge, ipcRenderer } from 'electron'
import type { PersonalApi, StreamEvent } from './personal'

const fask: PersonalApi = {
  activateProject: (id) => ipcRenderer.invoke('personal:active-project', id),
  rename: (kind, id, name) => ipcRenderer.invoke('personal:rename', kind, id, name),
  remove: (kind, id) => ipcRenderer.invoke('personal:remove', kind, id),
  clearRecent: (id) => ipcRenderer.invoke('personal:clear-recent', id),
  editOverlayRegion: () => ipcRenderer.invoke('personal:edit-overlay-region'),
  overlayRegions: (drawing, regions, panelOpen) =>
    ipcRenderer.invoke('personal:overlay-regions', drawing, regions, panelOpen),
  shortcutInfo: () => ipcRenderer.invoke('personal:shortcut-info'),
  onTogglePanel: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('personal:toggle-panel', listener)
    return () => {
      ipcRenderer.removeListener('personal:toggle-panel', listener)
    }
  },
  onOutsideClick: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('personal:outside-click', listener)
    return () => {
      ipcRenderer.removeListener('personal:outside-click', listener)
    }
  },
  snapshot: () => ipcRenderer.invoke('personal:snapshot'),
  create: (kind, name, parent) => ipcRenderer.invoke('personal:create', kind, name, parent),
  switchProfile: (id) => ipcRenderer.invoke('personal:switch-profile', id),
  saveSettings: (settings, key) => ipcRenderer.invoke('personal:save-settings', settings, key),
  models: (endpoint, key) => ipcRenderer.invoke('personal:models', endpoint, key),
  updateQuestion: (id, patch) => ipcRenderer.invoke('personal:update-question', id, patch),
  moveQuestion: (id, projectId) => ipcRenderer.invoke('personal:move-question', id, projectId),
  editConcept: (id, name, parent) => ipcRenderer.invoke('personal:edit-concept', id, name, parent),
  mergeConcept: (source, target) => ipcRenderer.invoke('personal:merge-concept', source, target),
  ask: (input) => ipcRenderer.invoke('personal:ask', input),
  cancel: (id) => ipcRenderer.invoke('personal:cancel', id),
  turnState: (questionId, turnId) =>
    ipcRenderer.invoke('personal:turn-state', questionId, turnId),
  refine: (raw, image) => ipcRenderer.invoke('personal:refine', raw, image),
  attachment: (id) => ipcRenderer.invoke('personal:attachment', id),
  clearAttachment: (id, turnId) => ipcRenderer.invoke('personal:clear-attachment', id, turnId),
  exportContext: (id) => ipcRenderer.invoke('personal:export', id),
  backup: () => ipcRenderer.invoke('personal:backup'),
  restore: () => ipcRenderer.invoke('personal:restore'),
  displays: () => ipcRenderer.invoke('personal:displays'),
  openCaptureEditor: (id) => ipcRenderer.invoke('personal:open-editor', id),
  capturePreview: () => ipcRenderer.invoke('personal:preview'),
  saveRegion: (region) => ipcRenderer.invoke('personal:save-region', region),
  closeCaptureEditor: () => ipcRenderer.invoke('personal:close-editor'),
  openOverlay: (id, questionId) => ipcRenderer.invoke('personal:open-overlay', id, questionId),
  showDashboard: () => ipcRenderer.invoke('personal:dashboard'),
  captureQuestion: (strokes) => ipcRenderer.invoke('personal:capture', strokes),
  hubStatus: () => ipcRenderer.invoke('personal:hub-status'),
  setHub: (enabled) => ipcRenderer.invoke('personal:hub-enable', enabled),
  setHubAddresses: (addresses) => ipcRenderer.invoke('personal:hub-addresses', addresses),
  resetHubPairing: () => ipcRenderer.invoke('personal:hub-reset'),
  onStream: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, event: StreamEvent): void => cb(event)
    ipcRenderer.on('personal:stream', listener)
    return () => {
      ipcRenderer.removeListener('personal:stream', listener)
    }
  },
  onChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('personal:changed', listener)
    return () => {
      ipcRenderer.removeListener('personal:changed', listener)
    }
  },
  onEscape: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('personal:escape', listener)
    return () => {
      ipcRenderer.removeListener('personal:escape', listener)
    }
  }
}
contextBridge.exposeInMainWorld('fask', fask)

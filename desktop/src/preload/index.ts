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
  editConceptInfo: (id, info) => ipcRenderer.invoke('personal:edit-concept-info', id, info),
  mergeConcept: (source, target) => ipcRenderer.invoke('personal:merge-concept', source, target),
  setRelation: (id, action) => ipcRenderer.invoke('personal:set-relation', id, action),
  focusQuestion: (id) => ipcRenderer.invoke('personal:focus-question', id),
  tidyPlan: (workspaceId) => ipcRenderer.invoke('personal:tidy-plan', workspaceId),
  tidyStart: (workspaceId) => ipcRenderer.invoke('personal:tidy-start', workspaceId),
  tidyStatus: (workspaceId) => ipcRenderer.invoke('personal:tidy-status', workspaceId),
  tidyClear: (workspaceId, jobId) => ipcRenderer.invoke('personal:tidy-clear', workspaceId, jobId),
  tidyManagerRequest: (workspaceId) => ipcRenderer.invoke('personal:tidy-manager-request', workspaceId),
  tidyApply: (workspaceId, proposalId, accepted, dismissed) =>
    ipcRenderer.invoke('personal:tidy-apply', workspaceId, proposalId, accepted, dismissed),
  ask: (input) => ipcRenderer.invoke('personal:ask', input),
  cancel: (id) => ipcRenderer.invoke('personal:cancel', id),
  turnState: (questionId, turnId) =>
    ipcRenderer.invoke('personal:turn-state', questionId, turnId),
  refine: (raw, image) => ipcRenderer.invoke('personal:refine', raw, image),
  attachment: (id) => ipcRenderer.invoke('personal:attachment', id),
  clearAttachment: (id, turnId) => ipcRenderer.invoke('personal:clear-attachment', id, turnId),
  export: (id, options) => ipcRenderer.invoke('personal:export', id, options),
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
  peerCodeBegin: () => ipcRenderer.invoke('personal:peer-code-begin'),
  peerCodeStatus: () => ipcRenderer.invoke('personal:peer-code-status'),
  peerCodeCancel: () => ipcRenderer.invoke('personal:peer-code-cancel'),
  peerGrants: () => ipcRenderer.invoke('personal:peer-grants'),
  peerGrantRevoke: (id) => ipcRenderer.invoke('personal:peer-grant-revoke', id),
  peerGrantManager: (id, decision) => ipcRenderer.invoke('personal:peer-grant-manager', id, decision),
  peerPair: (target, code) => ipcRenderer.invoke('personal:peer-pair', target, code),
  peerLinks: () => ipcRenderer.invoke('personal:peer-links'),
  peerUnlink: (id) => ipcRenderer.invoke('personal:peer-unlink', id),
  hubStatus: () => ipcRenderer.invoke('personal:hub-status'),
  setHub: (enabled) => ipcRenderer.invoke('personal:hub-enable', enabled),
  setHubAddresses: (addresses) => ipcRenderer.invoke('personal:hub-addresses', addresses),
  setHubRelay: (enabled, url) => ipcRenderer.invoke('personal:hub-relay', enabled, url),
  resetHubPairing: () => ipcRenderer.invoke('personal:hub-reset'),
  setUiLanguage: (lang) => ipcRenderer.invoke('personal:ui-language', lang),
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

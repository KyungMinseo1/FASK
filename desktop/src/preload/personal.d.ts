export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}
export interface TextAttachment {
  name: string
  text: string
}
export interface ShortcutInfo {
  accelerator: string | null
  fallback: boolean
}
export interface CaptureRegion {
  displayId: number
  rect: CaptureRect
  screenWidth: number
  screenHeight: number
}
export interface LocalSettings {
  endpoint: string
  hasKey: boolean
  model: string
  fastModel: string
  deepModel: string
  models: string[]
  routing: 'manual' | 'recommend' | 'auto'
  refine: boolean
  organize: boolean
  memory: boolean
  retention: 'minimal' | 'balanced' | 'preserve'
  regions: CaptureRegion[]
  displayId?: number
}
export interface Profile {
  id: string
  name: string
}
export interface Workspace {
  id: string
  profileId: string
  name: string
}
export interface Project {
  id: string
  workspaceId: string
  name: string
  description: string
}
export interface Concept {
  id: string
  projectId: string
  name: string
  parentId: string | null
  manual: boolean
}
export interface Question {
  title?: string
  documents?: TextAttachment[]
  id: string
  projectId: string
  conversationId: string
  createdAt: string
  raw: string
  refined: string
  sent: string
  answer: string
  model: string
  actualModel: string
  status: 'saved' | 'running' | 'completed' | 'failed' | 'cancelled'
  complexity: 'simple' | 'complex' | 'unknown'
  routingReason: string
  conceptIds: string[]
  suggestions: string[]
  memo: string
  important: boolean
  attachment: string | null
  error: string
}
export interface Snapshot {
  recentQuestions?: Record<string, string>
  profiles: Profile[]
  activeProfileId: string
  workspaces: Workspace[]
  projects: Project[]
  concepts: Concept[]
  questions: Question[]
  settings: LocalSettings
  storageBytes: number
}
export interface AskInput {
  documents?: TextAttachment[]
  requestId: string
  profileId: string
  projectId: string
  conversationId?: string
  raw: string
  refined?: string
  model: string
  image?: string
  saveOnly?: boolean
}
export interface StreamEvent {
  requestId: string
  questionId: string
  delta?: string
  done?: boolean
  error?: string
}
export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
}
export interface CapturePreview {
  image: string
  display: DisplayInfo
  region: CaptureRegion | null
}
export interface PersonalApi {
  activateProject(id: string): Promise<void>
  rename(
    kind: 'profile' | 'workspace' | 'project' | 'concept' | 'question',
    id: string,
    name: string
  ): Promise<void>
  remove(
    kind: 'profile' | 'workspace' | 'project' | 'concept' | 'question',
    id: string
  ): Promise<void>
  clearRecent(projectId: string): Promise<void>
  editOverlayRegion(): Promise<void>
  overlayRegions(drawing: boolean, regions: CaptureRect[], panelOpen: boolean): Promise<void>
  shortcutInfo(): Promise<ShortcutInfo>
  onTogglePanel(cb: () => void): () => void
  snapshot(): Promise<Snapshot>
  create(
    kind: 'profile' | 'workspace' | 'project' | 'concept',
    name: string,
    parentId?: string
  ): Promise<string>
  switchProfile(id: string): Promise<void>
  saveSettings(settings: LocalSettings, key?: string): Promise<void>
  models(endpoint: string, key?: string): Promise<string[]>
  updateQuestion(
    id: string,
    patch: Partial<Pick<Question, 'memo' | 'important' | 'conceptIds' | 'suggestions'>>
  ): Promise<void>
  editConcept(id: string, name: string, parentId: string | null): Promise<void>
  mergeConcept(source: string, target: string): Promise<void>
  ask(input: AskInput): Promise<string>
  cancel(requestId: string): Promise<void>
  refine(raw: string, image?: string): Promise<string>
  attachment(id: string): Promise<string | null>
  clearAttachment(id: string): Promise<void>
  exportContext(projectId: string): Promise<boolean>
  backup(): Promise<boolean>
  restore(): Promise<boolean>
  displays(): Promise<DisplayInfo[]>
  openCaptureEditor(displayId: number): Promise<void>
  capturePreview(): Promise<CapturePreview>
  saveRegion(region: CaptureRegion): Promise<void>
  closeCaptureEditor(): Promise<void>
  openOverlay(projectId: string, questionId?: string): Promise<void>
  captureQuestion(strokes?: string): Promise<string>
  onStream(cb: (event: StreamEvent) => void): () => void
  onChanged(cb: () => void): () => void
  onEscape(cb: () => void): () => void
  onOutsideClick(cb: () => void): () => void
  showDashboard(): Promise<void>
}
declare global {
  interface Window {
    fask: PersonalApi
  }
}

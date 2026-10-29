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
  autoTitle: boolean
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
export type TurnStatus = 'saved' | 'running' | 'completed' | 'failed' | 'cancelled'
export interface Turn {
  id: string
  createdAt: string
  raw: string
  refined: string
  sent: string
  answer: string
  model: string
  actualModel: string
  status: TurnStatus
  complexity: 'simple' | 'complex' | 'unknown'
  routingReason: string
  attachment: string | null
  documents: TextAttachment[]
  error: string
  /** Incremented whenever answer or status changes; a new turn starts at 0. */
  revision: number
}
export interface Question {
  id: string
  projectId: string
  /** createdAt of the first turn. */
  createdAt: string
  /** 1–200 characters; AI generated or renamed by the user. */
  title?: string
  /** One or more turns in chronological order. */
  turns: Turn[]
  conceptIds: string[]
  suggestions: string[]
  memo: string
  important: boolean
}
export interface AskResult {
  questionId: string
  turnId: string
}
export interface TurnState {
  answer: string
  revision: number
  status: TurnStatus
  error: string
  actualModel: string
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
  /** Question to continue; omitted for a new question. */
  questionId?: string
  raw: string
  refined?: string
  model: string
  image?: string
  saveOnly?: boolean
}
export interface StreamEvent {
  requestId: string
  questionId: string
  turnId: string
  /** Delta: revision after applying it. Done: final stored revision. */
  revision: number
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
/** Knowledge operations shared by the desktop preload and the mobile hub client. */
export interface KnowledgeApi {
  snapshot(): Promise<Snapshot>
  create(
    kind: 'profile' | 'workspace' | 'project' | 'concept',
    name: string,
    parentId?: string
  ): Promise<string>
  rename(
    kind: 'profile' | 'workspace' | 'project' | 'concept' | 'question',
    id: string,
    name: string
  ): Promise<void>
  remove(
    kind: 'profile' | 'workspace' | 'project' | 'concept' | 'question',
    id: string
  ): Promise<void>
  updateQuestion(
    id: string,
    patch: Partial<Pick<Question, 'memo' | 'important' | 'conceptIds' | 'suggestions'>>
  ): Promise<void>
  moveQuestion(id: string, projectId: string): Promise<void>
  editConcept(id: string, name: string, parentId: string | null): Promise<void>
  mergeConcept(source: string, target: string): Promise<void>
  ask(input: AskInput): Promise<AskResult>
  /** Accepts a requestId or a turnId, never a question ID. */
  cancel(id: string): Promise<void>
  turnState(questionId: string, turnId: string): Promise<TurnState>
  refine(raw: string, image?: string): Promise<string>
  attachment(id: string): Promise<string | null>
  clearAttachment(questionId: string, turnId: string): Promise<void>
  onStream(cb: (event: StreamEvent) => void): () => void
  onChanged(cb: () => void): () => void
}
export interface HubAddress {
  address: string
  kind: 'lan' | 'tailscale' | 'other'
  recommended: boolean
  selected: boolean
  listening: boolean
  error: string
}
export interface HubStatus {
  enabled: boolean
  port: number
  addresses: HubAddress[]
  /** QR payload; empty while no address is listening. */
  pairing: string
  error: string
}
export interface PersonalApi extends KnowledgeApi {
  activateProject(id: string): Promise<void>
  clearRecent(projectId: string): Promise<void>
  editOverlayRegion(): Promise<void>
  overlayRegions(drawing: boolean, regions: CaptureRect[], panelOpen: boolean): Promise<void>
  shortcutInfo(): Promise<ShortcutInfo>
  onTogglePanel(cb: () => void): () => void
  switchProfile(id: string): Promise<void>
  saveSettings(settings: LocalSettings, key?: string): Promise<void>
  models(endpoint: string, key?: string): Promise<string[]>
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
  onEscape(cb: () => void): () => void
  onOutsideClick(cb: () => void): () => void
  showDashboard(): Promise<void>
  hubStatus(): Promise<HubStatus>
  setHub(enabled: boolean): Promise<HubStatus>
  setHubAddresses(addresses: string[]): Promise<HubStatus>
  resetHubPairing(): Promise<HubStatus>
}
declare global {
  interface Window {
    fask: PersonalApi
  }
}

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
  /** Knowledge injected into answers: off, current project, or the whole workspace. */
  memoryScope: 'off' | 'project' | 'workspace'
  /** Budget for injected knowledge (estimated as characters / 3). */
  memoryTokens: number
  /** Seconds after a completed turn before its concepts are extracted. */
  extractDelaySec: number
  /** Model for extraction and tidy; empty uses fastModel, then model. */
  organizeModel: string
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
  /** Set when the workspace lives on a linked PC (read through this PC). */
  remote?: { peerId: string; name: string; status: PeerStatus }
}
export type PeerStatus = 'online' | 'offline' | 'revoked' | 'blocked'
export interface PeerLinkInfo {
  id: string
  name: string
  paths: ('tailscale' | 'relay')[]
  status: PeerStatus
}
export interface PeerGrantInfo {
  id: string
  name: string
  createdAt: number
}
export interface PeerCode {
  /** 8 characters, display as RRRP-PPPP. */
  code: string
  expiresAt: number
  addresses: string[]
  relay: boolean
}
export interface PeerCodeStatus {
  code: string
  expiresAt: number
  waiting: HubRelayStatus['state']
}
export type PeerTarget = { kind: 'direct'; address: string } | { kind: 'relay' }
export interface Project {
  id: string
  workspaceId: string
  name: string
  description: string
}
/** Exactly three levels; a parent is exactly one level up (detail→concept→topic), topics have no parent. */
export type ConceptLevel = 'topic' | 'concept' | 'detail'
export interface Concept {
  id: string
  workspaceId: string
  name: string
  /** SKOS broader. */
  parentId: string | null
  manual: boolean
  aliases: string[]
  definition: string
  level: ConceptLevel
  /** Topics only: direct concept count when tidy last reviewed this topic (absent = never). */
  tidiedCount?: number
  /**
   * Placement (`placementKey`) in which tidy last reviewed this parentless or misplaced concept and
   * left it as it was; tidy skips it until the placement changes. Any write that moves it drops this.
   */
  tidyReviewed?: string
  /** Similar-name partners tidy reviewed with this concept and left apart; skipped as tidy pairs. */
  tidyPairs?: string[]
}
export type RelationType = 'prerequisite' | 'part' | 'uses' | 'contrast' | 'example'
export interface Relation {
  id: string
  workspaceId: string
  /** Concept ids in the same workspace. */
  from: string
  to: string
  type: RelationType
  /** Provenance. */
  questionId: string | null
  turnIds: string[]
  /** 0..1 */
  confidence: number
  /** false = low-confidence, waiting for user approval */
  approved: boolean
  createdAt: string
  /** Relations are never deleted by tidy or extraction; the user's "remove" sets this. */
  invalidatedAt: string | null
}
export interface Reference {
  kind: 'concept' | 'question'
  id: string
  name: string
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
  /** Knowledge injected into this turn's prompt ("참고한 지식"). */
  references?: Reference[]
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
  /** conceptId -> turn ids where it appears; a link without a key has no recorded turn. */
  conceptTurns: Record<string, string[]>
  /** Number of leading turns already sent to concept extraction. */
  extractedTurns: number
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
  relations: Relation[]
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
  /** The image is a screen capture with the user's pen marks drawn on it. */
  annotated?: boolean
  /** Per-question knowledge override; undefined follows settings.memoryScope. */
  useMemory?: boolean
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
/** A concept named by a tidy proposal; `id` is null for one the proposal itself creates. */
export interface TidyRef {
  id: string | null
  name: string
}
/** A concept going under a parent: where it sits now and the level it takes there. */
export interface TidyPlacement {
  concept: TidyRef
  from: TidyRef | null
  levelFrom: ConceptLevel
  levelTo: ConceptLevel
}
/**
 * One reviewable change of a tidy proposal, accepted or rejected as a whole. `newParent` creates a
 * concept at `level` under `parent` (an id-less parent is a new topic created with it) and moves
 * `children` under it; `move` puts an existing concept under an existing (or earlier created) one.
 */
export type TidyChange =
  | { kind: 'merge'; source: TidyRef; target: TidyRef }
  | { kind: 'newParent'; name: string; level: ConceptLevel; parent: TidyRef | null; children: TidyPlacement[] }
  | ({ kind: 'move'; to: TidyRef } & TidyPlacement)
  | { kind: 'level'; concept: TidyRef; from: ConceptLevel; to: ConceptLevel }
  | { kind: 'relation'; from: TidyRef; to: TidyRef; type: RelationType; confidence: number }
/** A tidy preview: nothing is written until `tidyApply` with its id. */
export interface TidyProposal {
  id: string
  changes: TidyChange[]
}
/**
 * What applying a tidy proposal changed; `moved` counts existing concepts whose parent or level
 * changed. `skipped` lists accepted change indexes the current graph no longer allows.
 */
export interface TidyResult {
  merged: number
  parents: number
  moved: number
  relations: number
  skipped: number[]
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
    patch: Partial<Pick<Question, 'memo' | 'important' | 'conceptIds' | 'conceptTurns' | 'suggestions'>>
  ): Promise<void>
  moveQuestion(id: string, projectId: string): Promise<void>
  editConcept(id: string, name: string, parentId: string | null): Promise<void>
  editConceptInfo(
    id: string,
    info: Partial<Pick<Concept, 'aliases' | 'definition' | 'level'>>
  ): Promise<void>
  mergeConcept(source: string, target: string): Promise<void>
  /** remove => invalidatedAt = now. */
  setRelation(id: string, action: 'approve' | 'remove'): Promise<void>
  /** The question open on screen; leaving one extracts it immediately. */
  focusQuestion(questionId: string | null): Promise<void>
  /** Local estimate only, no LLM call. */
  tidyPlan(workspaceId: string): Promise<{ candidates: number; estimatedTokens: number }>
  /** One LLM call, user-triggered; returns the proposed changes without writing anything. */
  tidyPreview(workspaceId: string): Promise<TidyProposal>
  /**
   * Applies the accepted changes of the latest proposal; the proposal's other candidates are
   * recorded as reviewed so tidy stops offering them until they change.
   */
  tidyApply(workspaceId: string, proposalId: string, accepted: number[]): Promise<TidyResult>
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
export interface HubRelayStatus {
  enabled: boolean
  /** Effective relay URL (custom or build default); empty when none is configured. */
  url: string
  state: 'off' | 'connecting' | 'online' | 'error'
  error: string
}
export interface HubStatus {
  enabled: boolean
  port: number
  addresses: HubAddress[]
  relay: HubRelayStatus
  /** QR payload; empty while neither an address nor the relay is serving. */
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
  /** Zip with README, JSONL and SKOS; images only when chosen. */
  export(projectId: string, options: { images: boolean }): Promise<boolean>
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
  setHubRelay(enabled: boolean, url: string): Promise<HubStatus>
  setUiLanguage(lang: 'ko' | 'en'): Promise<void>
  peerCodeBegin(): Promise<PeerCode>
  peerCodeStatus(): Promise<PeerCodeStatus | null>
  peerCodeCancel(): Promise<void>
  peerGrants(): Promise<PeerGrantInfo[]>
  peerGrantRevoke(id: string): Promise<void>
  peerPair(target: PeerTarget, code: string): Promise<void>
  peerLinks(): Promise<PeerLinkInfo[]>
  peerUnlink(id: string): Promise<void>
}
declare global {
  interface Window {
    fask: PersonalApi
  }
}

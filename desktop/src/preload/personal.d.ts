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
export type CaptureSetupReason =
  | 'no-displays'
  | 'display-missing'
  | 'display-selection-required'
  | 'region-changed'
export interface CaptureSetupRequired {
  ok: false
  reason: CaptureSetupReason
}
export type CaptureResult<T> =
  | { ok: true; value: T }
  | CaptureSetupRequired
export interface CaptureRegionSaved {
  region: CaptureRegion
  overlayChanged: boolean
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
  /** Language of the instructions sent to the model (not the UI language); outputs still follow the conversation's language. */
  promptLanguage: 'ko' | 'en'
  retention: 'minimal' | 'balanced' | 'preserve'
  autoTitle: boolean
  regions: CaptureRegion[]
  displayId?: number
}
/** The settings that pick an answer model; a linked PC shares its own with this PC. */
export type ModelSettings = Pick<LocalSettings, 'model' | 'fastModel' | 'deepModel' | 'models' | 'routing'>
/** OpenAI-compatible `reasoning_effort`; undefined leaves it to the model's default. */
export type ReasoningEffort = 'low' | 'medium' | 'high'
export interface Profile {
  id: string
  name: string
}
export interface Workspace {
  id: string
  profileId: string
  name: string
  /** Set when the workspace lives on a linked PC (read through this PC). */
  remote?: {
    peerId: string
    name: string
    status: PeerStatus
    /** That PC's answer-model settings, which its answers use; absent when it runs an older build. */
    models?: ModelSettings
  }
  /**
   * Normalized candidate names a tidy offered for promotion and the user left as candidates;
   * tidy does not offer them again.
   */
  tidyCandidates?: string[]
}
export type PeerStatus = 'online' | 'offline' | 'revoked' | 'blocked'
export interface PeerLinkInfo {
  id: string
  name: string
  paths: ('tailscale' | 'relay')[]
  status: PeerStatus
}
/** A linked PC's knowledge-manager state on this PC's workspaces; only `granted` may tidy them. */
export type ManagerState = 'none' | 'pending' | 'granted' | 'rejected'
export interface PeerGrantInfo {
  id: string
  name: string
  createdAt: number
  manager: ManagerState
  managerAt: number | null
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
export type ConceptRole = 'focus' | 'support'
export type TagSource = 'user' | 'model'
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
  /**
   * Usage key (`usageKey`: its links, roles and children) at which tidy last offered this concept
   * as weak, thin or promotable and the user left it; skipped until its usage changes.
   */
  tidyKept?: string
  /** Name at which tidy last offered a rename and the user kept it; skipped until renamed. */
  tidyNamed?: string
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
  /** Answer sentence the extraction quoted for it, verified against the answer text. */
  evidence?: string
  /** Tidy offered this relation's pair as conflicting and the user kept it. */
  tidyKept?: boolean
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
  /**
   * conceptId -> what the question is about ('focus', shown as a tag) or what the answer drew on
   * ('support', listed as related). Keys ⊂ conceptIds; a link without an entry predates roles
   * and counts as focus until tidy re-judges it.
   */
  conceptRoles?: Record<string, ConceptRole>
  /**
   * conceptId -> who linked it. Keys ⊂ conceptIds; a link without an entry predates sources
   * (unknown): tidy never replaces or removes it without a confirm-flagged change.
   */
  conceptSources?: Record<string, TagSource>
  /** Number of leading turns already sent to concept extraction. */
  extractedTurns: number
  /**
   * Candidate concepts: names the answers drew on that are not nodes yet (not in the tree, no
   * tags, no relations). One recurring in another question of the workspace becomes a node.
   */
  suggestions: string[]
  /** Workspace id in which tidy offered to move this question elsewhere and the user kept it. */
  tidyStay?: string
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
  /** Records the question without asking the model; sent by mobile builds and test scripts, no desktop UI. */
  saveOnly?: boolean
  /** The image is a screen capture with the user's pen marks drawn on it. */
  annotated?: boolean
  /** Per-question knowledge override; undefined follows settings.memoryScope. */
  useMemory?: boolean
  /** Sent as `reasoning_effort`; omitted uses the model's default. */
  reasoningEffort?: ReasoningEffort
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
export interface TidyQuestionRef {
  id: string
  title: string
}
/** A concept going under a parent: where it sits now and the level it takes there. */
export interface TidyPlacement {
  concept: TidyRef
  from: TidyRef | null
  levelFrom: ConceptLevel
  levelTo: ConceptLevel
}
/**
 * How a re-judged tag of a question changes: becomes `focus` or `support`; `fold` folds the concept
 * into `target` (the question keeps `target` as support); `replace` unlinks it and links `target`
 * as focus (a target with a null id is not a node yet and becomes a candidate name instead);
 * `remove` unlinks it.
 */
export type RetagVerdict = 'focus' | 'support' | 'fold' | 'replace' | 'remove'
export interface RetagItem {
  concept: TidyRef
  /** Its role before (null: none recorded). */
  from: ConceptRole | null
  verdict: RetagVerdict
  target: TidyRef | null
  /** Local check: neither its name nor an alias appears in any turn of the question. */
  suspect: boolean
}
/**
 * One reviewable change of a tidy proposal, accepted or rejected as a whole.
 * - `merge`: same concept; `fold`: narrower `source` into broader `target` (name → alias,
 *   definition appended, question links move to `target` as support).
 * - `demote`: the node leaves the tree; its name becomes a candidate of the questions linking it.
 * - `newParent` creates a concept at `level` under `parent` (an id-less parent is a new topic
 *   created with it) and moves `children` under it; `move` puts an existing concept under an
 *   existing (or earlier created) one; `level` changes a level in place.
 * - `rename`: the old name stays as an alias.
 * - `promote`: a candidate name recurring in `questions` becomes a node linked to them as support.
 * - `unrelate`: removes one relation of a conflicting pair.
 * - `retag`: the re-judged tags of one question. `confirm` marks one that replaces or removes
 *   links of unknown source; the review leaves it unchecked.
 * - `moveQuestion`: the question fits another workspace better; moving clears its links there.
 */
export type TidyChange =
  | { kind: 'merge'; source: TidyRef; target: TidyRef }
  | { kind: 'fold'; source: TidyRef; target: TidyRef }
  | { kind: 'demote'; concept: TidyRef }
  | { kind: 'newParent'; name: string; level: ConceptLevel; parent: TidyRef | null; children: TidyPlacement[] }
  | ({ kind: 'move'; to: TidyRef } & TidyPlacement)
  | { kind: 'level'; concept: TidyRef; from: ConceptLevel; to: ConceptLevel }
  | { kind: 'rename'; concept: TidyRef; to: string }
  | { kind: 'promote'; name: string; level: ConceptLevel; parent: TidyRef | null; questions: TidyQuestionRef[] }
  | { kind: 'unrelate'; relation: string; from: TidyRef; to: TidyRef; type: RelationType }
  | { kind: 'retag'; question: TidyQuestionRef; items: RetagItem[]; confirm: boolean }
  | {
      kind: 'moveQuestion'
      question: TidyQuestionRef
      to: { projectId: string; projectName: string; workspaceName: string }
    }
/**
 * A tidy proposal: nothing is written until `tidyApply` with its id. `retag` is the number of
 * questions the tidy job re-judged (or still re-judges) and appends to `changes`.
 */
export interface TidyProposal {
  id: string
  changes: TidyChange[]
  retag: number
}
/** A record tidy will look at, chosen locally before any LLM call. */
export type TidyCandidate =
  | { kind: 'orphan' | 'misplaced' | 'crowded' | 'weak' | 'thin' | 'promotable' | 'rename'; concept: TidyRef }
  | { kind: 'pair' | 'conflict'; a: TidyRef; b: TidyRef }
  | { kind: 'recurring'; name: string; questions: number }
  | { kind: 'question'; question: TidyQuestionRef }
/** Local estimate of a tidy, no LLM call: structural candidates and questions to re-judge. */
export interface TidyEstimate {
  candidates: number
  retag: number
  /** Input characters ÷ 3; the model's output is not included. */
  estimatedTokens: number
  items: TidyCandidate[]
}
/**
 * A background tidy run on the PC that owns the workspace. `ready` with a non-empty `error`: the
 * re-judging stopped early and the partial proposal is still reviewable. Kept in memory only:
 * a host restart loses it.
 */
export interface TidyJob {
  id: string
  state: 'running' | 'ready' | 'failed'
  startedAt: number
  finishedAt: number | null
  progress: { done: number; total: number }
  proposal: TidyProposal | null
  error: string
}
/** owner: this device's own PC; else this PC's manager state on the workspace's host. */
export type TidyAccess = 'owner' | ManagerState
/** `lastApplied`: id of the last job applied on this workspace since the host started, else null. */
export interface TidyStatus {
  access: TidyAccess
  job: TidyJob | null
  lastApplied: string | null
}
/**
 * What applying a tidy proposal changed; `moved` counts existing concepts whose parent or level
 * changed. `skipped` lists accepted change indexes the current graph no longer allows.
 */
export interface TidyResult {
  merged: number
  folded: number
  demoted: number
  renamed: number
  promoted: number
  parents: number
  moved: number
  unrelated: number
  retagged: number
  movedQuestions: number
  skipped: number[]
}
/** What a project export contains. `images` and `memo` only apply with `conversations`. */
export interface ExportOptions {
  /** questions.jsonl plus question provenance on concepts/relations; off = concept graph only. */
  conversations: boolean
  memo: boolean
  images: boolean
  /** Leave out relations the user has not approved. */
  approvedOnly: boolean
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
  tidyPlan(workspaceId: string): Promise<TidyEstimate>
  /**
   * Starts the workspace's tidy job (the structural LLM call, then re-judging the queued
   * questions) and returns at once; a running job is returned as is. Owner or granted manager only.
   */
  tidyStart(workspaceId: string): Promise<TidyJob>
  tidyStatus(workspaceId: string): Promise<TidyStatus>
  /** Removes a failed job; anything else is left alone. */
  tidyClear(workspaceId: string, jobId: string): Promise<void>
  /** Asks the workspace's host to make this PC a knowledge manager; a no-op on this PC's own. */
  tidyManagerRequest(workspaceId: string): Promise<void>
  /**
   * Applies the `accepted` changes of the job's proposal. `dismissed` changes are recorded as
   * reviewed with the untouched candidates, so tidy stops offering them until they change; the
   * subjects of changes in neither list are skipped this time and offered again next tidy.
   */
  tidyApply(workspaceId: string, proposalId: string, accepted: number[], dismissed: number[]): Promise<TidyResult>
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
  /** The overlay question panel continues this question without reopening the overlay. */
  continueQuestion(projectId: string, questionId: string): Promise<void>
  editOverlayRegion(): Promise<CaptureResult<void>>
  overlayRegions(drawing: boolean, regions: CaptureRect[], panelOpen: boolean): Promise<void>
  shortcutInfo(): Promise<ShortcutInfo>
  onTogglePanel(cb: () => void): () => void
  switchProfile(id: string): Promise<void>
  saveSettings(settings: LocalSettings, key?: string): Promise<void>
  models(endpoint: string, key?: string): Promise<string[]>
  /** Zip with README, JSONL and SKOS per the chosen options; a linked-PC project is fetched from its host. */
  export(projectId: string, options: ExportOptions): Promise<boolean>
  backup(): Promise<boolean>
  restore(): Promise<boolean>
  displays(): Promise<DisplayInfo[]>
  openCaptureEditor(displayId: number): Promise<CaptureResult<void>>
  capturePreview(): Promise<CapturePreview>
  saveRegion(region: CaptureRegion): Promise<CaptureResult<CaptureRegionSaved>>
  closeCaptureEditor(): Promise<void>
  onCaptureRegionSaved(cb: (event: CaptureRegionSaved) => void): () => void
  onCaptureSetupRequired(cb: (issue: CaptureSetupRequired) => void): () => void
  openOverlay(projectId: string, questionId?: string): Promise<CaptureResult<void>>
  captureQuestion(strokes?: string): Promise<CaptureResult<string>>
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
  /** Host side: answers or withdraws a linked PC's knowledge-manager role. */
  peerGrantManager(id: string, decision: 'grant' | 'reject' | 'revoke'): Promise<void>
  peerPair(target: PeerTarget, code: string): Promise<void>
  peerLinks(): Promise<PeerLinkInfo[]>
  peerUnlink(id: string): Promise<void>
}
declare global {
  interface Window {
    fask: PersonalApi
  }
}

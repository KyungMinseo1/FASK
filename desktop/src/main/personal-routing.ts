// Linked-PC routing: merges remote workspaces into this PC's snapshot, forwards calls on remote ids,
// and authorizes what a peer PC may do on this host.
import { validCard } from '../shared/avatar'
import { questionImages } from '../shared/questions'
import type {
  AskInput,
  AskResult,
  ManagerState,
  Project,
  Question,
  Snapshot,
  StreamEvent,
  PeerStatus
} from '../preload/personal'
import { PEER_BLOCKED, PEER_REVOKED } from './personal-peers'
import { defaults } from './personal-store'

export const NOT_ALLOWED = '권한이 없는 요청입니다.'
export const UNSUPPORTED = '지원하지 않는 요청입니다.'
export const CROSS_BOUNDARY = '로컬과 외부 워크스페이스 사이에서는 이동·병합할 수 없습니다.'
export const REMOTE_OFFLINE = '외부 PC가 오프라인이라 사용할 수 없습니다.'
export const TIDY_MANAGER_ONLY = '지식 관리자로 승인된 PC만 정리할 수 있습니다.'
export const EXPORT_MANAGER_ONLY = '지식 관리자로 승인된 PC만 내보낼 수 있습니다.'
const MANAGER_ONLY: ReadonlyMap<string, string> = new Map([
  ['tidy-start', TIDY_MANAGER_ONLY],
  ['tidy-apply', TIDY_MANAGER_ONLY],
  ['tidy-clear', TIDY_MANAGER_ONLY],
  ['export-archive', EXPORT_MANAGER_ONLY]
])

/** Tidying or exporting this host's workspaces needs the caller PC's knowledge-manager grant. */
export function checkPeerManager(manager: ManagerState | undefined, name: string): void {
  const message = MANAGER_ONLY.get(name)
  if (message && manager !== 'granted') throw new Error(message)
}

/**
 * Validates one peer call against the host's active profile before its handler runs.
 * `own(kind, id)` must throw when the record is not in the active profile.
 */
export function checkPeerCall(own: (kind: string, id: string) => unknown, name: string, args: unknown[]): void {
  const owned = (kind: string, id: unknown): void => {
    if (typeof id !== 'string') throw new Error(NOT_ALLOWED)
    try {
      own(kind, id)
    } catch {
      throw new Error(NOT_ALLOWED)
    }
  }
  const [a, b, c] = args
  switch (name) {
    case 'create':
      if (a === 'project') return owned('workspace', c)
      if (a === 'concept') return owned('project', c)
      throw new Error('외부 PC에서는 워크스페이스를 만들 수 없습니다.')
    case 'rename':
      if (a === 'workspace' || a === 'project' || a === 'concept' || a === 'question') return owned(a, b)
      throw new Error(NOT_ALLOWED)
    case 'remove':
      if (a === 'workspace') throw new Error('외부 PC에서는 워크스페이스를 삭제할 수 없습니다.')
      if (a === 'project' || a === 'concept' || a === 'question') return owned(a, b)
      throw new Error(NOT_ALLOWED)
    case 'update-question':
    case 'clear-attachment':
    case 'turn-state':
      return owned('question', a)
    case 'move-question':
      owned('question', a)
      return owned('project', b)
    case 'edit-concept':
      owned('concept', a)
      if (c !== undefined && c !== null && c !== '') owned('concept', c)
      return
    case 'merge-concept':
      owned('concept', a)
      return owned('concept', b)
    case 'edit-concept-info':
      return owned('concept', a)
    case 'set-relation':
      return owned('relation', a)
    case 'focus-question':
      if (a === null) return
      return owned('question', a)
    case 'tidy-plan':
    case 'tidy-status':
    case 'tidy-start':
    case 'tidy-clear':
    case 'tidy-manager-request':
    case 'tidy-apply':
      return owned('workspace', a)
    case 'export-archive':
      return owned('project', a)
    case 'attachment':
    case 'cancel':
      return
    case 'extract-run':
      return owned('question', a)
    case 'ask': {
      const input = a as Partial<AskInput> | null
      if (!input || typeof input !== 'object') throw new Error(NOT_ALLOWED)
      owned('project', input.projectId)
      if (input.questionId !== undefined) owned('question', input.questionId)
      return
    }
    default:
      throw new Error(UNSUPPORTED)
  }
}

export interface RemotePeer {
  link: { id: string; name: string }
  status: PeerStatus
  snapshot: Snapshot | null
  rpc(name: string, args: unknown[], options?: { retry?: boolean }): Promise<unknown>
}

/**
 * What a linked PC sees of this host: only the workspaces shared with it (and their records),
 * no recent-question state, and default settings instead of the host's own.
 */
export function peerSnapshot(s: Snapshot, shared: ReadonlySet<string>): Snapshot {
  const workspaces = s.workspaces.filter((w) => shared.has(w.id))
  const projects = s.projects.filter((p) => shared.has(p.workspaceId))
  const projectIds = new Set(projects.map((p) => p.id))
  return {
    ...s,
    workspaces,
    projects,
    concepts: s.concepts.filter((c) => shared.has(c.workspaceId)),
    relations: s.relations.filter((r) => shared.has(r.workspaceId)),
    questions: s.questions.filter((q) => projectIds.has(q.projectId)),
    recentQuestions: {},
    storageBytes: 0,
    settings: { ...defaults, endpoint: '', regions: [] }
  }
}

/** Remote ids a linked PC last showed this PC; compared to find what to purge locally. */
export type SeenIds = { workspaceIds: string[]; projectIds: string[]; questionIds: string[] }

export function seenIds(s: Snapshot | null): SeenIds {
  if (!s) return { workspaceIds: [], projectIds: [], questionIds: [] }
  return {
    workspaceIds: s.workspaces.map((w) => w.id),
    projectIds: s.projects.map((p) => p.id),
    questionIds: s.questions.map((q) => q.id)
  }
}

/** Ids in `prev` that `next` no longer has. */
export function removedIds(prev: SeenIds, next: SeenIds): SeenIds {
  const gone = (a: string[], b: string[]): string[] => {
    const keep = new Set(b)
    return a.filter((id) => !keep.has(id))
  }
  return {
    workspaceIds: gone(prev.workspaceIds, next.workspaceIds),
    projectIds: gone(prev.projectIds, next.projectIds),
    questionIds: gone(prev.questionIds, next.questionIds)
  }
}

type Part = Pick<Snapshot, 'workspaces' | 'projects' | 'concepts' | 'relations' | 'questions'> & { peer: RemotePeer }

export interface RouterHooks {
  onAsked?: (projectId: string, questionId: string, turnId: string, peerId: string, args: unknown[]) => void
  /** Rewrites the args of a call about to be forwarded to `peerId` (e.g. attaches a compute ticket). */
  prepare?: (name: string, args: unknown[], peerId: string, ctx: { mobile: boolean }) => Promise<unknown[]>
  /** The forwarded call with these (prepared) args failed. */
  onForwardFailed?: (name: string, args: unknown[]) => void
}

// Which argument names the record a call acts on.
const ROUTE_KEY: Record<string, (args: unknown[]) => unknown> = {
  create: (a) => a[2],
  rename: (a) => a[1],
  remove: (a) => a[1],
  'update-question': (a) => a[0],
  'move-question': (a) => a[0],
  'edit-concept': (a) => a[0],
  attachment: (a) => a[0],
  'merge-concept': (a) => a[0],
  'edit-concept-info': (a) => a[0],
  'set-relation': (a) => a[0],
  'focus-question': (a) => a[0],
  'tidy-plan': (a) => a[0],
  'tidy-status': (a) => a[0],
  'tidy-start': (a) => a[0],
  'tidy-clear': (a) => a[0],
  'tidy-manager-request': (a) => a[0],
  'tidy-apply': (a) => a[0],
  'clear-attachment': (a) => a[0],
  'turn-state': (a) => a[0],
  ask: (a) => (a[0] as Partial<AskInput> | null)?.questionId ?? (a[0] as Partial<AskInput> | null)?.projectId,
  'active-project': (a) => a[0],
  'clear-recent': (a) => a[0],
  'continue-question': (a) => a[0],
  'open-overlay': (a) => a[0],
  'export-archive': (a) => a[0]
}
// Reads are idempotent; `ask` is deduplicated by requestId on the host. Nothing else is retried.
const RETRY = new Set(['snapshot', 'turn-state', 'attachment', 'ask', 'export-archive'])

export class RemoteRouter {
  private owners = new Map<string, string>()
  private parts: Part[] = []
  private warned = new Set<string>()
  /** requestId/turnId of forwarded asks → owning peer, for `cancel`. */
  private runs = new Map<string, string>()
  /** Questions created through forwarded asks or seen in a peer stream → owning peer, until that peer's snapshot lists them. */
  private created = new Map<string, string>()

  constructor(
    private peers: () => Iterable<RemotePeer>,
    private localHas: (id: string) => boolean,
    private local: (name: string, args: unknown[], ctx: { mobile: boolean }) => unknown,
    private hooks: RouterHooks = {}
  ) {}

  /** Recomputes ownership from the latest remote snapshots; colliding remote workspaces are dropped. */
  rebuild(): void {
    const owners = new Map<string, string>()
    const parts: Part[] = []
    for (const peer of this.peers()) {
      const s = peer.snapshot
      if (!s) continue
      for (const w of s.workspaces) {
        const projects = s.projects.filter((p) => p.workspaceId === w.id)
        const ids = new Set(projects.map((p) => p.id))
        const concepts = s.concepts.filter((c) => c.workspaceId === w.id)
        // A linked PC may run an older build whose snapshot has no relations.
        const relations = (s.relations ?? []).filter((r) => r.workspaceId === w.id)
        const questions = s.questions.filter((q) => ids.has(q.projectId))
        const all = [
          w.id,
          ...projects.map((p) => p.id),
          ...concepts.map((c) => c.id),
          ...relations.map((r) => r.id),
          ...questions.flatMap((q) => [q.id, ...questionImages(q)])
        ]
        if (all.some((id) => owners.has(id) || this.localHas(id))) {
          const tag = `${peer.link.id}:${w.id}`
          if (!this.warned.has(tag)) {
            this.warned.add(tag)
            console.warn(`linked workspace ${w.id} from ${peer.link.name} collides with an existing id; hidden`)
          }
          continue
        }
        for (const id of all) owners.set(id, peer.link.id)
        parts.push({ peer, workspaces: [w], projects, concepts, relations, questions })
      }
    }
    this.owners = owners
    this.parts = parts
    const linked = new Set([...this.peers()].map((p) => p.link.id))
    for (const [id, peerId] of this.created) if (owners.has(id) || !linked.has(peerId)) this.created.delete(id)
  }

  merge(local: Snapshot): Snapshot {
    const out = { ...local }
    out.workspaces = [...local.workspaces]
    out.projects = [...local.projects]
    out.concepts = [...local.concepts]
    out.relations = [...local.relations]
    out.questions = [...local.questions]
    for (const part of this.parts) {
      const s = part.peer.snapshot
      const remote = {
        peerId: part.peer.link.id,
        name: part.peer.link.name,
        status: part.peer.status,
        ...(s && typeof s.profile?.id === 'string' && validCard(s.profile)
          ? { owner: { id: s.profile.id, name: s.profile.name, avatar: s.profile.avatar } }
          : {})
      }
      out.workspaces.push(...part.workspaces.map((w) => ({ ...w, remote })))
      out.projects.push(...part.projects)
      out.concepts.push(...part.concepts)
      out.relations.push(...part.relations)
      out.questions.push(...part.questions)
    }
    return out
  }

  ownerOf(id: unknown): string | undefined {
    return typeof id === 'string' ? (this.owners.get(id) ?? this.created.get(id)) : undefined
  }

  /**
   * A project in a linked PC's workspace as of its last snapshot. Only peers currently in the link list
   * (unlink deletes them and rebuilds) and workspaces that passed the collision check in rebuild() count;
   * local ids are never returned. The host re-checks ownership of every forwarded call (checkPeerCall).
   */
  remoteProject(id: string): Project | undefined {
    for (const part of this.parts) {
      const hit = part.projects.find((p) => p.id === id)
      if (hit) return hit
    }
    return undefined
  }

  /** A question in a visible linked-PC workspace, under the same contract as remoteProject(). */
  remoteQuestion(id: string): Question | undefined {
    for (const part of this.parts) {
      const hit = part.questions.find((q) => q.id === id)
      if (hit) return hit
    }
    return undefined
  }

  /** Every question in the visible linked-PC workspaces. */
  remoteQuestions(): Question[] {
    return this.parts.flatMap((part) => part.questions)
  }

  /** Profile id of the linked PC owning a visible remote project; undefined for older hosts. */
  remoteOwner(projectId: string): string | undefined {
    const part = this.parts.find((p) => p.projects.some((project) => project.id === projectId))
    const id = part?.peer.snapshot?.profile?.id
    return typeof id === 'string' ? id : undefined
  }

  /** Drops forwarded-ask bookkeeping for a peer whose link ended. */
  forget(peerId: string): void {
    for (const [id, owner] of this.created) if (owner === peerId) this.created.delete(id)
    for (const [id, owner] of this.runs) if (owner === peerId) this.runs.delete(id)
  }

  noteStream(peerId: string, event: StreamEvent): void {
    // Stream events can arrive before the forwarded ask's reply names the new question.
    if (!this.owners.has(event.questionId) && !this.localHas(event.questionId)) this.created.set(event.questionId, peerId)
    if (event.done) {
      this.runs.delete(event.requestId)
      this.runs.delete(event.turnId)
    } else {
      this.runs.set(event.requestId, peerId)
      this.runs.set(event.turnId, peerId)
    }
  }

  private peer(id: string): RemotePeer {
    const peer = [...this.peers()].find((p) => p.link.id === id)
    if (!peer || peer.status === 'offline') throw new Error(REMOTE_OFFLINE)
    if (peer.status === 'revoked') throw new Error(PEER_REVOKED)
    if (peer.status === 'blocked') throw new Error(PEER_BLOCKED)
    return peer
  }

  async route(name: string, args: unknown[], ctx: { mobile: boolean } = { mobile: false }): Promise<unknown> {
    if (name === 'cancel') {
      const owner = typeof args[0] === 'string' ? this.runs.get(args[0]) : undefined
      return owner ? this.peer(owner).rpc('cancel', args) : this.local(name, args, ctx)
    }
    const owner = this.ownerOf(ROUTE_KEY[name]?.(args))
    const other =
      name === 'move-question' || name === 'merge-concept' ? args[1] : name === 'edit-concept' ? args[2] : undefined
    if (typeof other === 'string' && other && (this.ownerOf(other) ?? 'local') !== (owner ?? 'local'))
      throw new Error(CROSS_BOUNDARY)
    if (!owner) return this.local(name, args, ctx)
    // The overlay window and its recent-conversation state live on this PC, even for linked-PC projects.
    if (
      name === 'active-project' ||
      name === 'clear-recent' ||
      name === 'continue-question' ||
      name === 'open-overlay'
    )
      return this.local(name, args, ctx)
    const peer = this.peer(owner)
    args = (await this.hooks.prepare?.(name, args, owner, ctx)) ?? args
    const forward = async (call: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await call()
      } catch (error) {
        this.hooks.onForwardFailed?.(name, args)
        throw error
      }
    }
    if (name === 'ask') {
      // Forwarded as prepared: this PC's profile runs every model and Jev call (see prepare).
      const input = args[0] as AskInput
      this.runs.set(input.requestId, owner)
      const result = (await forward(() => peer.rpc('ask', args, { retry: true }))) as AskResult
      if (result?.turnId) this.runs.set(result.turnId, owner)
      if (result?.questionId) {
        // Registered before onAsked: it triggers the renderer resync that calls turn-state on this id.
        this.created.set(result.questionId, owner)
        this.hooks.onAsked?.(input.projectId, result.questionId, result.turnId, owner, args)
      }
      return result
    }
    return forward(() => peer.rpc(name, args, { retry: RETRY.has(name) }))
  }
}

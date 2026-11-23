import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage, type WebContents } from 'electron'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addressKind,
  createHubCertificate,
  PersonalHub,
  type HubCaller,
  type HubListenResult,
  type HubTls
} from './personal-hub'
import { HubRelay, normalizeRelayUrl, RELAY_REPLACED, relayRoom } from './personal-relay'
import { HUB_PORT, pairWithHost, PeerConnection, type PeerLink } from './personal-peers'
import { PairError, PairingHost } from './peer-pairing'
import {
  checkPeerCall,
  checkPeerManager,
  NOT_ALLOWED,
  peerSnapshot,
  RemoteRouter,
  removedIds,
  seenIds,
  UNSUPPORTED,
  type SeenIds
} from './personal-routing'
import { isTailscaleTarget, pairRelayKey, TAILSCALE_ADDRESS_ERROR, type PairPayload } from '../shared/pair-code'
import { PersonalStore } from './personal-store'
import { DisplayImages } from './image-display'
import { PersonalCapture } from './personal-capture'
import { validateBackup } from './personal-backup'
import { KnowledgeExtractor, organizeModel, recallMemory, type RecallParams, type RecallResult } from './knowledge-extract'
import { jevRecall } from './jev-recall'
import {
  decideHabit,
  habitFile,
  habitPrompt,
  importHabitFile,
  listHabits,
  recallHabits,
  saveHabit,
  toLines
} from './habits'
import { HabitDetector } from './habit-detect'
import { prompt } from './prompts'
import { buildExport, EXPORT_TOO_LARGE, EXPORT_TRANSFER_MAX } from './knowledge-export'
import { questionShortcutInfo, registerQuestionShortcut } from './personal-shortcuts'
import { localModels, normalizeEndpoint, streamChat, type WireMessage } from './local-api'
import { JEV_BASE_URL, jevClient, validResponse, type JevCall } from './jev-api'
import {
  ComputeBroker,
  ComputeRunner,
  COMPUTE_UNREACHABLE,
  LOCAL,
  PEER_OUTDATED,
  SHARE_REVOKED,
  TICKET,
  type Executor
} from './compute'
import { ProfileLock, PROFILE_LOCKED } from './profile-lock'
import { Updater } from './updater'
import { validCard } from '../shared/avatar'
import { JEV_ROUTE_TIMEOUT_MS, jevRoute, RouteCache, routeKey } from './jev-routing'
import { cleanTitle, questionImages, recommend, routedModel } from '../shared/questions'
import { exportFileName, exportOptions } from '../shared/export'
import { i18n, t } from '../shared/i18n'
import type {
  AskInput,
  AskResult,
  CaptureSetupRequired,
  ComposerFiles,
  Concept,
  ExportOptions,
  HubAddress,
  HubStatus,
  Habit,
  HabitInput,
  HabitLine,
  JevProvider,
  LocalSettings,
  PeerAsk,
  Project,
  PurgeBatch,
  Question,
  ReasoningEffort,
  RouteResult,
  Snapshot,
  StreamEvent,
  TextAttachment,
  TidyStatus,
  Turn,
  TurnAuthor,
  TurnState,
  Workspace
} from '../preload/personal'
import { noFiles, sameFiles } from '../shared/composer-files'

// Build-time default relay (release builds set MAIN_VITE_FASK_RELAY_URL); Settings can override it.
const DEFAULT_RELAY_URL = normalizeRelayUrl(import.meta.env.MAIN_VITE_FASK_RELAY_URL ?? '') ?? ''
/** Text attachments within the ask limits: at most 5, names ≤255, ≤50,000 chars each, ≤100,000 total. */
const validDocuments = (documents: unknown): documents is TextAttachment[] =>
  Array.isArray(documents) &&
  documents.length <= 5 &&
  documents.every(
    (d) =>
      !!d &&
      typeof d.name === 'string' &&
      typeof d.text === 'string' &&
      d.name.length <= 255 &&
      d.text.length <= 50000
  ) &&
  documents.reduce((sum: number, d: TextAttachment) => sum + d.text.length, 0) <= 100000
const HUB_METHODS: ReadonlySet<string> = new Set([
  'snapshot',
  'create',
  'rename',
  'remove',
  'update-question',
  'move-question',
  'edit-concept',
  'merge-concept',
  'edit-concept-info',
  'set-relation',
  'focus-question',
  'tidy-plan',
  'tidy-status',
  'tidy-start',
  'tidy-clear',
  'tidy-manager-request',
  'tidy-apply',
  'ask',
  'cancel',
  'turn-state',
  'refine',
  'compute-reply',
  'extract-run',
  'attachment',
  'clear-attachment',
  'peer-leave',
  'export-archive',
  'habits',
  'habit-decide'
])
const HUB_KIND_ORDER: Record<HubAddress['kind'], number> = { tailscale: 0, lan: 1, other: 2 }
interface PeerGrant {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  manager?: 'pending' | 'granted' | 'rejected'
  managerAt?: number
  /** This PC's workspaces shared with that PC; a new link shares none. */
  workspaces: string[]
  /** Set once the host saved the share scope. */
  shareReviewedAt?: number
}
/** Who sent a question: this PC (its windows or its phone) or a linked PC asking with its own resources. */
type AskOrigin = { kind: 'local'; mobile: boolean } | { kind: 'peer'; peerId: string; device: string }
/** How one question runs: whose resources answer it and the settings that shape the prompt. */
interface AskPlan {
  executor: Executor
  routing: RouteResult
  model: string
  memoryScope: LocalSettings['memoryScope']
  memoryTokens: number
  jevRecall: boolean
  promptLanguage: 'ko' | 'en'
  autoTitle: boolean
  /** Habit lines sent by a linked PC; null = this PC's own habits. */
  habits: HabitLine[] | null
}

export interface PersonalRuntime {
  capture: PersonalCapture
  quickQuestion: () => void
  initializeShortcut: () => void
  close: () => void
}
export function registerPersonal(root: string, main: () => BrowserWindow | null): PersonalRuntime {
  const store = new PersonalStore(root)
  const display = new DisplayImages(
    store,
    join(dirname(require.resolve('@jsquash/webp/package.json')), 'codec/enc/webp_enc_simd.wasm'),
    join(__dirname, 'webp-worker.js')
  )
  const saveImage = (data: string): string => {
    const id = store.saveImage(data)
    display.ensure(id)
    return id
  }
  // Older attachments get their copies once startup work has settled.
  const backfillTimer = setTimeout(() => display.backfill(), 5000)
  // Deliberately in memory: reopening an overlay restores the conversation, restarting resets it.
  const recentQuestions = new Map<string, string>()
  // Unsent composer files by `${profileId}:${projectId}`; in memory like recentQuestions, so a restart drops them.
  // Revisions come from one counter that only grows, so a window can drop anything older than what it shows.
  const composerFiles = new Map<string, { projectId: string; files: ComposerFiles | null; revision: number }>()
  let composerRevision = 0
  const controllers = new Map<
    string,
    { controller: AbortController; profile: string; questionId: string; turnId: string }
  >()
  // Answer state of running turns, keyed by turnId; fresher than the 400ms DB checkpoints.
  const live = new Map<string, { questionId: string; profile: string; state: TurnState }>()
  // Electron's invoke boundary has heterogeneous arguments; each handler validates its domain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Handler = (...args: any[]) => any
  const handlers = new Map<string, Handler>()
  // The phone is this profile's companion device; it never sees PC-local details.
  const mobileSnapshot = (s: Snapshot): Snapshot => ({
    ...s,
    recentQuestions: {},
    settings: { ...s.settings, endpoint: '', hasKey: false, hasJevKey: false, regions: [], displayId: undefined },
    storageBytes: 0
  })
  const hubInvoke = async (caller: HubCaller, name: string, args: unknown[]): Promise<unknown> => {
    if (caller.kind === 'peer') {
      // The reply to a compute request this PC sent; the broker matches it to that peer's request.
      if (name === 'compute-reply') {
        broker.reply(caller.id, args[0])
        return null
      }
      // Local data only: a peer never sees or reaches this PC's own linked PCs.
      if (name === 'snapshot') return peerSnapshot(localSnapshot(), sharedFor(caller.id))
      if (name === 'peer-leave') {
        revokeGrant(caller.id)
        return null
      }
      const shared = sharedFor(caller.id)
      checkPeerCall(
        (kind, id) => {
          store.record(kind, id)
          if (!shared.has(store.scopeOf(kind as Parameters<PersonalStore['scopeOf']>[0], id)))
            throw new Error(NOT_ALLOWED)
        },
        name,
        args
      )
      const grant = grants().find((g) => g.id === caller.id)
      checkPeerManager(grant?.manager, name)
      if (name === 'tidy-status')
        return { ...(handlers.get(name)!(...args) as TidyStatus), access: grant?.manager ?? 'none' }
      if (name === 'tidy-manager-request') {
        if (grant && grant.manager !== 'granted' && grant.manager !== 'pending') {
          saveGrants(grants().map((g) => (g.id === grant.id ? { ...g, manager: 'pending', managerAt: Date.now() } : g)))
          changed()
        }
        return null
      }
      // A linked PC tags its own clients (its windows, its phone) so their focus stays apart.
      if (name === 'focus-question')
        return focusQuestion(`peer:${caller.id}:${typeof args[1] === 'string' ? args[1].slice(0, 100) : ''}`, args[0])
      if (name === 'ask')
        return ask(args[0] as AskInput, { kind: 'peer', peerId: caller.id, device: grant?.name ?? '다른 PC' })
      if (name === 'tidy-start' || name === 'extract-run') {
        // Tickets are checked for shape only; the linked PC that issued one enforces its meaning.
        if (typeof args[1] !== 'string' || !TICKET.test(args[1])) throw new Error(PEER_OUTDATED)
        const executor: Executor = { kind: 'peer', peerId: caller.id, ticket: args[1] }
        if (name === 'extract-run') return extractor.startFor(store.active, String(args[0]), executor)
        store.record<Workspace>('workspace', String(args[0]))
        return extractor.tidyStart(store.active, String(args[0]), executor)
      }
      if (name === 'attachment') {
        const id = args[0]
        if (
          typeof id !== 'string' ||
          !store
            .list<Question>('question')
            .some((q) => questionImages(q).includes(id) && shared.has(store.workspaceOf(q.projectId)))
        )
          throw new Error(NOT_ALLOWED)
        return store.displayImage(id)
      }
      // A linked PC stops only the answers it asked.
      if (name === 'cancel') {
        const item = findController(args[0])
        const turn =
          item && store.record<Question>('question', item.questionId).turns.find((t) => t.id === item.turnId)
        if (!item || turn?.author?.peer !== caller.id) throw new Error(NOT_ALLOWED)
        item.controller.abort()
        return null
      }
      const handler = handlers.get(name)
      if (!handler) throw new Error(UNSUPPORTED)
      return handler(...args)
    }
    if (name === 'peer-leave' || name === 'compute-reply' || name === 'extract-run') throw new Error(UNSUPPORTED)
    // Parentless creation (workspace) skips the profile-scope check, so only concepts are allowed.
    if (name === 'create' && args[0] !== 'concept')
      throw new Error('모바일에서는 개념만 만들 수 있습니다.')
    if (!handlers.has(name)) throw new Error(UNSUPPORTED)
    if (name === 'snapshot') return mobileSnapshot(mergedSnapshot())
    if (name === 'focus-question') return focusQuestion('mobile', args[0])
    return router.route(name, args, { mobile: true })
  }
  const pairing = new PairingHost(hostname())
  const hub = new PersonalHub(hubInvoke, HUB_METHODS, app.getVersion(), {
    ke1: (body) => pairing.ke1(body),
    ke3: async (body) => {
      const result = await pairing.ke3(body, pairPayload)
      // The code is spent; the rendezvous room closes once this response had time to leave.
      const generation = pairGeneration
      setTimeout(() => generation === pairGeneration && pairStop(), 2000)
      return result
    }
  })
  const hubRelay = new HubRelay((stream) => hub.inject(stream))
  // Rendezvous for code pairing: a separate room derived from the code's public part.
  const pairRelay = new HubRelay((stream) => hub.inject(stream, 'pair'))
  let pairTimer: NodeJS.Timeout | null = null
  let pairGeneration = 0
  const pairStop = (): void => {
    clearTimeout(pairTimer ?? undefined)
    pairTimer = null
    pairRelay.stop()
    pairing.cancel()
  }
  /** `remote` marks events relayed from linked PCs; peers of this PC never receive those. */
  const changed = (remote = false): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('personal:changed')
    hub.broadcast('changed', {}, remote ? 'remote' : 'local')
  }
  const emit = (event: StreamEvent, remote = false): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('personal:stream', event)
    if (remote) {
      hub.broadcast('stream', event, 'remote')
      return
    }
    // A linked PC receives live answers of the workspaces shared with it only.
    let workspace = ''
    try {
      workspace = store.scopeOf('question', event.questionId)
    } catch {
      /* Deleted meanwhile: no linked PC gets it. */
    }
    hub.broadcast('stream', event, 'local', (c) => c.kind !== 'peer' || sharedFor(c.id).has(workspace))
  }
  // ── Linked PCs (this PC as client) ── host data stays in memory, never on disk.
  const peers = new Map<string, PeerConnection>()
  const localHas = (id: string): boolean => !!store.db.prepare('SELECT 1 FROM records WHERE id=?').get(id)
  // Questions this PC forwarded, by turn: the ticket ends and extraction is scheduled when the answer is done.
  const forwarded = new Map<string, { peerId: string; questionId: string; ticket: string }>()
  const router = new RemoteRouter(
    () => peers.values(),
    localHas,
    (name, args, ctx) => {
      if (name === 'ask') return ask(args[0] as AskInput, { kind: 'local', mobile: ctx.mobile })
      const handler = handlers.get(name)
      if (!handler) throw new Error(UNSUPPORTED)
      return handler(...args)
    },
    {
      onAsked: (projectId, questionId, turnId, peerId, args) => {
        recentQuestions.set(projectId, questionId)
        const ticket = (args[0] as AskInput).peer?.ticket
        if (ticket) forwarded.set(turnId, { peerId, questionId, ticket })
        changed(true)
      },
      prepare: (name, args, peerId, ctx) => prepareForward(name, args, peerId, ctx),
      onForwardFailed: (name, args) => {
        const ticket = name === 'ask' ? (args[0] as AskInput).peer?.ticket : name === 'tidy-start' ? args[1] : undefined
        if (typeof ticket === 'string') runner.revoke(ticket)
      }
    }
  )
  /** A project/question of this PC or of a visible linked-PC workspace; throws like store.record when missing. */
  const anyProject = (id: string): Project => router.remoteProject(id) ?? store.record<Project>('project', id)
  const anyQuestion = (id: string): Question =>
    router.remoteQuestion(id) ?? store.record<Question>('question', id)
  /** Re-reads linked-PC ownership; recent conversations of projects no longer visible anywhere are dropped. */
  const rebuildPeers = (): void => {
    router.rebuild()
    for (const project of [...recentQuestions.keys()])
      if (!localHas(project) && !router.remoteProject(project)) recentQuestions.delete(project)
    const remote = router.remoteQuestions()
    habitDetector.scanRemote(remote)
    // This profile's turns another PC deferred are extracted with this PC's resources once it is reachable.
    if (store.settings().organize)
      for (const q of remote) {
        if (peerExtract.has(q.id) || !q.deferredTurns?.length) continue
        const mine = q.deferredTurns.some(
          (d) => q.turns.find((t) => t.id === d.turnId)?.author?.profileId === store.active
        )
        const owner = router.ownerOf(q.id)
        if (mine && owner) schedulePeerExtract(owner, q.id, 0)
      }
  }
  const connectPeer = (link: PeerLink): void => {
    peers.get(link.id)?.close()
    const conn: PeerConnection = new PeerConnection(
      link,
      () => {
        const gone = conn.status === 'revoked' || conn.status === 'blocked'
        if (gone) {
          runner.dropPeer(link.id)
          router.forget(link.id)
        }
        const next = gone ? seenIds(null) : conn.snapshot ? seenIds(conn.snapshot) : undefined
        if (next) {
          purge(removedIds(peerSeen()[link.id] ?? seenIds(null), next))
          savePeerSeen(link.id, next)
        }
        rebuildPeers()
        changed(true)
      },
      (event) => {
        router.noteStream(link.id, event)
        emit(event, true)
        const sent = event.done ? forwarded.get(event.turnId) : undefined
        if (sent) {
          forwarded.delete(event.turnId)
          // A title may still be generating; it gets one more minute.
          runner.expireSoon(sent.ticket, 60_000)
          const s = store.settings()
          if (!event.error && s.organize) schedulePeerExtract(sent.peerId, sent.questionId, s.extractDelaySec * 1000)
        }
      },
      (event, data) => (event === 'compute' ? runner.handle(link.id, data) : runner.cancel(link.id, data))
    )
    peers.set(link.id, conn)
  }
  const capture = new PersonalCapture(store, main, () => changed())
  const captureIssues = new WeakMap<WebContents, CaptureSetupRequired>()
  const requestCaptureSetup = (issue: CaptureSetupRequired): void => {
    const overlay = capture.overlay
    if (overlay && !overlay.isDestroyed()) capture.presentRecovery()
    const target = overlay && !overlay.isDestroyed() ? overlay : main()
    if (!target || target.isDestroyed()) return
    captureIssues.set(target.webContents, issue)
    target.webContents.send('personal:capture-setup-required')
    if (!capture.editor) {
      target.show()
      target.focus()
    }
  }
  let lastProjectId = ''
  const quickQuestion = (): void => {
    // A locked profile opens the lock screen, never the overlay.
    if (lock.locked) {
      main()?.show()
      main()?.focus()
      return
    }
    try {
      if (capture.editor) {
        const issue = capture.editorSetupRequired()
        if (issue) {
          capture.editor.close()
          requestCaptureSetup(issue)
        } else {
          capture.editor.show()
          capture.editor.focus()
        }
        return
      }
      if (capture.overlay) {
        const issue = capture.captureSetupRequired()
        if (issue) requestCaptureSetup(issue)
        else capture.toggleQuestionPanel()
        return
      }
      const projects = store.list<Project>('project')
      const project =
        router.remoteProject(lastProjectId) ??
        projects.find((p) => p.id === lastProjectId) ??
        projects[0]
      if (project) {
        const result = capture.open(project.id, true)
        if (!result.ok) requestCaptureSetup(result)
      } else {
        main()?.show()
        main()?.focus()
      }
    } catch (error) {
      dialog.showErrorBox(t('화면 질문 오류'), error instanceof Error ? error.message : String(error))
    }
  }
  // ── Profile lock ── the only access path to this profile's model and Jev keys.
  const lock = new ProfileLock(store, safeStorage)
  const key = (): string => lock.readSecret('key')
  const jevKey = (): string => lock.readSecret('jev-key')
  const requireLocalWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (
      !win ||
      event.senderFrame !== event.sender.mainFrame ||
      ![main(), capture.overlay, capture.editor].includes(win)
    )
      throw new Error('허용되지 않은 요청입니다.')
    return win
  }
  ipcMain.handle('personal:take-capture-setup', (event) => {
    requireLocalWindow(event)
    const issue = captureIssues.get(event.sender) ?? null
    captureIssues.delete(event.sender)
    return issue
  })
  const draftKey = (profileId: unknown, projectId: unknown): string => {
    if (
      typeof profileId !== 'string' ||
      typeof projectId !== 'string' ||
      !profileId ||
      !projectId ||
      profileId.length > 200 ||
      projectId.length > 200
    )
      throw new Error(BAD_REQUEST)
    return `${profileId}:${projectId}`
  }
  const checkFiles = (value: unknown): ComposerFiles | null => {
    if (value === null) return null
    const f = value as Partial<ComposerFiles> | undefined
    if (
      !f ||
      typeof f.image !== 'string' ||
      (f.image !== '' && !/^data:image\/(png|jpeg);base64,/.test(f.image)) ||
      !validDocuments(f.documents)
    )
      throw new Error(BAD_REQUEST)
    const files = { image: f.image, documents: f.documents }
    return noFiles(files) ? null : files
  }
  ipcMain.handle('personal:composer-files', (event, profileId: unknown, projectId: unknown) => {
    requireLocalWindow(event)
    if (lock.locked) throw new Error(PROFILE_LOCKED)
    const entry = composerFiles.get(draftKey(profileId, projectId))
    return { files: entry?.files ?? null, revision: entry?.revision ?? 0 }
  })
  ipcMain.handle(
    'personal:set-composer-files',
    (event, profileId: unknown, projectId: unknown, files: unknown, expect: unknown) => {
      requireLocalWindow(event)
      if (lock.locked) throw new Error(PROFILE_LOCKED)
      const key = draftKey(profileId, projectId)
      const next = checkFiles(files)
      const entry = composerFiles.get(key)
      if (expect !== undefined && !sameFiles(entry?.files ?? null, checkFiles(expect)))
        return { applied: false, revision: entry?.revision ?? 0 }
      const revision = ++composerRevision
      // Kept with `files: null` when cleared so revisions keep growing per key.
      composerFiles.set(key, { projectId: projectId as string, files: next, revision })
      // The sender already shows this value; every other window follows it.
      for (const win of BrowserWindow.getAllWindows())
        if (win.webContents !== event.sender)
          win.webContents.send('personal:composer-files-changed', profileId, projectId, {
            files: next,
            revision
          })
      return { applied: true, revision }
    }
  )
  const handle = (name: string, fn: Handler): void => {
    handlers.set(name, fn)
    ipcMain.handle(`personal:${name}`, (event, ...args) => {
      requireLocalWindow(event)
      if (lock.locked) throw new Error(PROFILE_LOCKED)
      if (name === 'focus-question') return focusQuestion(`window:${event.sender.id}`, args[0])
      return router.route(name, args)
    })
  }
  /** Local-window IPC that works while locked; never reachable through the hub. */
  const handleUnlocked = (name: string, fn: Handler): void => {
    ipcMain.handle(`personal:${name}`, (event, ...args) => {
      requireLocalWindow(event)
      return fn(...args)
    })
  }
  /** Records one model call's tokens; without reported usage they are estimated from text length. */
  const meter = (messages: WireMessage[], output: string, usage: { input: number; output: number } | null): void => {
    if (usage) {
      store.addUsage('model', usage.input, usage.output, 0, false)
      return
    }
    let chars = 0
    for (const m of messages)
      if (typeof m.content === 'string') chars += m.content.length
      else for (const part of m.content) if (part.type === 'text') chars += part.text?.length ?? 0
    store.addUsage('model', Math.ceil(chars / 3), Math.ceil(output.length / 3), 0, true)
  }
  /** Every non-streamed model call of this PC goes through here (metered). */
  const complete = async (model: string, messages: WireMessage[], signal: AbortSignal): Promise<string> => {
    const settings = store.settings()
    let result = ''
    let usage: { input: number; output: number } | null = null
    try {
      usage = (
        await streamChat(settings.endpoint, key(), model, messages, signal, {}, (t) => {
          result += t
        })
      ).usage
    } finally {
      meter(messages, result, usage)
    }
    if (!result.trim()) throw new Error('모델이 빈 답변을 반환했습니다.')
    return result.trim()
  }
  /** Every streamed answer of this PC goes through here (metered). */
  const streamAnswer = async (
    model: string,
    messages: WireMessage[],
    effort: ReasoningEffort | undefined,
    signal: AbortSignal,
    delta: (text: string, actualModel?: string) => void
  ): Promise<void> => {
    let text = ''
    let usage: { input: number; output: number } | null = null
    try {
      usage = (
        await streamChat(store.settings().endpoint, key(), model, messages, signal, { reasoningEffort: effort }, (d, m) => {
          text += d
          delta(d, m)
        })
      ).usage
    } finally {
      meter(messages, text, usage)
    }
  }
  const userMessage = (instruction: string, raw: string, image?: string): WireMessage[] => [
    { role: 'system', content: instruction },
    {
      role: 'user',
      content: image
        ? [
            { type: 'text', text: raw },
            { type: 'image_url', image_url: { url: image } }
          ]
        : raw
    }
  ]
  const textCall = (instruction: string, raw: string, image?: string, signal = AbortSignal.timeout(90000)): Promise<string> => {
    const s = store.settings()
    return complete(s.fastModel || s.model, userMessage(instruction, raw, image), signal)
  }
  const routeCache = new RouteCache()
  /** This PC's Jev, metered; read the key per call so a decryption failure is a rejection the callers fall back on. */
  const meteredJev = (provider: JevProvider, secret: () => string): JevCall => async (request, signal) => {
    const res = await jevClient(JEV_BASE_URL[provider], secret())(request, signal)
    store.addUsage('jev', res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0, res.usage?.cost ?? 0, false)
    return res
  }
  const jev = (): JevCall | undefined => {
    const s = store.settings()
    return s.hasJevKey ? meteredJev(s.jevProvider, jevKey) : undefined
  }
  // `auto` may call Jev (once per draft, shared with the preview); `manual` never asks Jev.
  const askRoute = async (
    profile: string,
    settings: LocalSettings,
    raw: string,
    hasImage: boolean
  ): Promise<RouteResult> => {
    const local = recommend(raw, hasImage)
    const call = settings.jevRouting && settings.routing !== 'manual' && raw.trim() ? jev() : undefined
    if (!call) return local
    const k = routeKey(profile, raw, hasImage)
    if (settings.routing !== 'auto') return routeCache.settled(k) ?? local
    return routeCache
      .route(k, () => jevRoute(call, raw, hasImage, AbortSignal.timeout(JEV_ROUTE_TIMEOUT_MS)))
      .catch(() => local)
  }
  // ── Requester resources ── a question runs on the resources of the device that asked it.
  const broker = new ComputeBroker((peerId, event, data) => hub.sendTo(peerId, event, data), validResponse)
  const runner = new ComputeRunner({
    chat: (role, messages, signal) => {
      const s = store.settings()
      return complete(role === 'organize' ? organizeModel(s) : s.fastModel || s.model, messages, signal)
    },
    stream: streamAnswer,
    jev: () => jev(),
    reply: (peerId, r) =>
      peers.get(peerId)?.rpc('compute-reply', [r], { retry: true }).then(() => {}) ??
      Promise.reject(new Error(COMPUTE_UNREACHABLE))
  })
  const chatVia = async (
    ex: Executor,
    role: 'fast' | 'organize',
    instruction: string,
    raw: string,
    image: string | undefined,
    signal: AbortSignal
  ): Promise<string> => {
    const messages = userMessage(instruction, raw, image)
    if (ex.kind === 'local') {
      const s = store.settings()
      return complete(role === 'organize' ? organizeModel(s) : s.fastModel || s.model, messages, signal)
    }
    const text = (await broker.run(ex, { kind: 'chat', role, messages }, signal)).text.trim()
    if (!text) throw new Error('모델이 빈 답변을 반환했습니다.')
    return text
  }
  const streamVia = async (
    ex: Executor,
    model: string,
    messages: WireMessage[],
    effort: ReasoningEffort | undefined,
    signal: AbortSignal,
    delta: (text: string, actualModel?: string) => void
  ): Promise<void> => {
    if (ex.kind === 'local') return streamAnswer(model, messages, effort, signal, delta)
    await broker.run(ex, { kind: 'stream', model, messages, reasoningEffort: effort }, signal, delta)
  }
  const jevVia = (ex: Executor, wanted: boolean): JevCall | undefined => {
    if (!wanted) return undefined
    if (ex.kind === 'local') return jev()
    return async (request, signal) => {
      const { response } = await broker.run(ex, { kind: 'jev', request }, signal)
      if (!response) throw new Error('Jev 응답 형식이 잘못되었습니다.')
      return response
    }
  }
  const extractor = new KnowledgeExtractor(
    store,
    (_profile, executor, instruction, input, signal) =>
      chatVia(executor, 'organize', instruction, input, undefined, signal),
    changed,
    (peerId, workspaceId) => sharedFor(peerId).has(workspaceId)
  )
  const habitDetector = new HabitDetector({
    store,
    chat: (instruction, input, signal) =>
      complete(
        organizeModel(store.settings()),
        [
          { role: 'system', content: instruction },
          { role: 'user', content: input }
        ],
        signal
      ),
    remoteQuestion: (id) => {
      const question = router.remoteQuestion(id)
      const owner = question && router.remoteOwner(question.projectId)
      return question && owner ? { question, owner } : undefined
    },
    changed
  })
  const localSnapshot = (): Snapshot => ({
    ...store.snapshot(),
    device: hostname(),
    recentQuestions: Object.fromEntries(
      store
        .list<Project>('project')
        .flatMap((p) => (recentQuestions.has(p.id) ? [[p.id, recentQuestions.get(p.id) ?? '']] : []))
    )
  })
  const mergedSnapshot = (): Snapshot => {
    const merged = router.merge(localSnapshot())
    // Linked-PC projects keep their recent conversation on this PC only; peers never see it.
    const remote = [...recentQuestions].filter(([project]) => router.remoteProject(project))
    return remote.length
      ? { ...merged, recentQuestions: { ...merged.recentQuestions, ...Object.fromEntries(remote) } }
      : merged
  }
  handle('snapshot', () => mergedSnapshot())
  handle('clear-recent', (id: string) => {
    anyProject(id)
    recentQuestions.delete(id)
    changed()
  })
  handle('continue-question', (id: string, questionId: string) => {
    anyProject(id)
    if (anyQuestion(questionId).projectId !== id) throw new Error('프로젝트가 다른 질문입니다.')
    recentQuestions.set(id, questionId)
    lastProjectId = id
    changed()
  })
  handle('remove', (kind: string, id: string) => {
    if (controllers.size) throw new Error('진행 중인 답변을 마치거나 중지한 뒤 삭제해 주세요.')
    if (capture.overlay || capture.editor)
      throw new Error('오버레이와 캡처 설정을 닫고 삭제해 주세요.')
    store.remove(kind, id)
    if (kind === 'workspace' && grants().some((g) => g.workspaces.includes(id)))
      saveGrants(grants().map((g) => ({ ...g, workspaces: g.workspaces.filter((w) => w !== id) })))
    for (const [project, question] of recentQuestions)
      if (!router.ownerOf(question) && !store.db.prepare('SELECT id FROM records WHERE id=?').get(question))
        recentQuestions.delete(project)
    changed()
  })
  handle('shortcut-info', () => questionShortcutInfo())
  handle('active-project', (id: string) => {
    anyProject(id)
    lastProjectId = id
  })
  handle('overlay-regions', (drawing, regions, panelOpen) =>
    capture.setRegions(drawing, regions, panelOpen)
  )
  handle('rename', (kind, id, name) => {
    store.rename(kind, id, name)
    changed()
  })
  handle('create', (kind, name, parentId) => {
    const id = store.create(kind, name, parentId)
    changed()
    return id
  })
  // ── Profile ── one per PC; other profiles left by older builds stay hidden until merged.
  handle('profile-update', (patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('요청 형식이 잘못되었습니다.')
    store.updateProfile(patch as Parameters<PersonalStore['updateProfile']>[0])
    changed()
  })
  handle('profile-merge-info', () => store.mergeInfo())
  handle('profile-merge', () => {
    if (controllers.size || capture.overlay || capture.editor)
      throw new Error('진행 중인 요청과 오버레이를 닫은 뒤 합쳐 주세요.')
    store.mergeProfiles()
    extractor.scan([store.active])
    habitDetector.scanLocal()
    changed()
  })
  handle('usage', () => store.usage())
  const updater = new Updater(() => changed())
  handle('update-state', () => updater.state())
  handle('update-install', () => {
    if (controllers.size) throw new Error('진행 중인 답변을 마친 뒤 업데이트해 주세요.')
    updater.install()
  })
  /** Locks the profile: keys become unreadable and every run on this PC's resources stops. */
  const lockNow = (): void => {
    lock.lock()
    runner.abortAll()
    capture.overlay?.close()
    capture.editor?.close()
    changed()
  }
  let scanned = false
  /** Background extraction and habit scans need the keys, so they start once unlocked. */
  const startScans = (): void => {
    if (scanned) return
    scanned = true
    extractor.scan([store.active])
    habitDetector.scanLocal()
  }
  handleUnlocked('lock-state', () => {
    const p = store.profile()
    return { ...lock.state(), profile: { name: p.name, avatar: p.avatar } }
  })
  handleUnlocked('unlock', async (pin: unknown) => {
    if (typeof pin !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
    await lock.unlock(pin)
    startScans()
    changed()
  })
  handleUnlocked('pin-reset', () => {
    lock.reset()
    startScans()
    changed()
  })
  handleUnlocked('ui-language', async (lang: unknown) => {
    if (lang !== 'ko' && lang !== 'en') throw new Error('요청 형식이 잘못되었습니다.')
    await i18n.changeLanguage(lang)
  })
  handle('lock', () => lockNow())
  handle('pin-set', async (current: unknown, next: unknown) => {
    if ((current !== undefined && typeof current !== 'string') || typeof next !== 'string')
      throw new Error('요청 형식이 잘못되었습니다.')
    await lock.setPin(current, next)
    changed()
  })
  handle('pin-remove', async (current: unknown) => {
    if (typeof current !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
    await lock.removePin(current)
    changed()
  })
  const onLockScreen = (): void => {
    if (lock.hasPin) lockNow()
  }
  powerMonitor.on('lock-screen', onLockScreen)
  powerMonitor.on('suspend', onLockScreen)
  handle('save-settings', (settings: LocalSettings, newKey?: string, newJevKey?: string) => {
    const clean = {
      ...store.settings(),
      endpoint: normalizeEndpoint(settings.endpoint),
      model: String(settings.model),
      fastModel: String(settings.fastModel),
      deepModel: String(settings.deepModel),
      models: settings.models.filter((m) => typeof m === 'string').slice(0, 1000),
      routing: settings.routing,
      refine: !!settings.refine,
      organize: !!settings.organize,
      organizeModel: String(settings.organizeModel),
      promptLanguage: settings.promptLanguage,
      memoryScope: settings.memoryScope,
      memoryTokens: Math.round(Number(settings.memoryTokens)),
      extractDelaySec: Math.round(Number(settings.extractDelaySec)),
      retention: settings.retention,
      autoTitle: !!settings.autoTitle,
      answerHabits: !!settings.answerHabits,
      jevProvider: settings.jevProvider,
      jevRouting: !!settings.jevRouting,
      jevPreviewSec: Number(settings.jevPreviewSec),
      jevRecall: !!settings.jevRecall
    }
    if (
      !['manual', 'auto'].includes(clean.routing) ||
      ![0, 1, 2, 3].includes(clean.jevPreviewSec) ||
      !['minimal', 'balanced', 'preserve'].includes(clean.retention) ||
      !['off', 'project', 'workspace'].includes(clean.memoryScope) ||
      !(clean.memoryTokens >= 100 && clean.memoryTokens <= 20000) ||
      !(clean.extractDelaySec >= 0 && clean.extractDelaySec <= 3600) ||
      !['ko', 'en'].includes(clean.promptLanguage) ||
      !['typesafe', 'openrouter'].includes(clean.jevProvider)
    )
      throw new Error('설정 값이 잘못되었습니다.')
    if (newKey !== undefined) lock.writeSecret('key', String(newKey))
    if (newJevKey !== undefined) lock.writeSecret('jev-key', String(newJevKey).trim())
    store.saveSettings(clean)
    changed()
  })
  handle('models', (endpoint: string, newKey?: string) =>
    localModels(endpoint, newKey === undefined ? key() : newKey)
  )
  handle('route-preview', async (text: unknown, hasImage: unknown): Promise<RouteResult | null> => {
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) return null
    const profile = store.active,
      settings = store.settings(profile)
    const call = settings.jevRouting && settings.routing !== 'manual' ? jev() : undefined
    if (!call) return null
    const image = hasImage === true
    return routeCache
      .route(routeKey(profile, text, image), () =>
        jevRoute(call, text, image, AbortSignal.timeout(JEV_ROUTE_TIMEOUT_MS))
      )
      .catch(() => null)
  })
  handle('jev-test', async (provider: JevProvider, newJevKey?: string) => {
    if (!['typesafe', 'openrouter'].includes(provider)) throw new Error('설정 값이 잘못되었습니다.')
    const res = await meteredJev(provider, () => (newJevKey === undefined ? jevKey() : String(newJevKey).trim()))(
      {
        state: 'FASK connection check',
        questions: { ok: { type: 'noul', instructions: 'This text is a connection check.' } }
      },
      AbortSignal.timeout(15000)
    )
    return { model: res.model }
  })
  handle('update-question', (id, patch) => {
    store.updateQuestion(id, patch)
    changed()
  })
  handle('move-question', (id: string, projectId: string) => {
    if ([...controllers.values()].some((c) => c.questionId === id))
      throw new Error('진행 중인 답변을 마친 뒤 이동해 주세요.')
    store.moveQuestion(id, projectId)
    for (const [project, question] of recentQuestions)
      if (question === id) recentQuestions.delete(project)
    // A move to another workspace resets the watermark; the new graph extracts it again.
    extractor.completed(store.active, id)
    changed()
  })
  handle('edit-concept', (id, name, parent) => {
    store.editConcept(id, name, parent)
    changed()
  })
  handle('merge-concept', (source, target) => {
    store.mergeConcept(source, target)
    changed()
  })
  handle('edit-concept-info', (id: string, info: Parameters<PersonalStore['editConceptInfo']>[1]) => {
    if (!info || typeof info !== 'object') throw new Error('요청 형식이 잘못되었습니다.')
    store.editConceptInfo(id, info)
    changed()
  })
  handle('set-relation', (id: string, action: unknown) => {
    if (action !== 'approve' && action !== 'remove') throw new Error('요청 형식이 잘못되었습니다.')
    store.setRelation(id, action)
    changed()
  })
  // Open question per client, any owner; leaving one extracts it on the PC that owns it.
  const focused = new Map<string, string>()
  const focusQuestion = (client: string, questionId: unknown): void => {
    if (questionId !== null && typeof questionId !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
    const previous = focused.get(client)
    if (questionId) focused.set(client, questionId)
    else focused.delete(client)
    const owner = router.ownerOf(questionId),
      previousOwner = router.ownerOf(previous)
    // A linked PC learns that this client left its question only from here.
    if (previousOwner && previousOwner !== owner)
      void peers.get(previousOwner)?.rpc('focus-question', [null, client]).catch(() => {})
    if (owner) void peers.get(owner)?.rpc('focus-question', [questionId, client]).catch(() => {})
    extractor.focus(client, owner ? null : questionId)
    // This PC's last viewer left the question: its pending habit check and forwarded extraction run now.
    const local = (c: string): boolean => !c.startsWith('peer:')
    if (
      previous &&
      previous !== questionId &&
      local(client) &&
      ![...focused].some(([c, q]) => q === previous && local(c))
    ) {
      habitDetector.runNow(previous)
      const pending = peerExtract.get(previous)
      if (pending) schedulePeerExtract(pending.peerId, previous, 0)
    }
  }
  // Dispatched with its caller in the IPC wrapper and hubInvoke; registered for the allowlists.
  handle('focus-question', () => {
    throw new Error(UNSUPPORTED)
  })
  handle('tidy-plan', (workspaceId: string) => {
    store.record<Workspace>('workspace', workspaceId)
    const { candidates, estimatedTokens, retag, items } = extractor.plan(store.active, workspaceId)
    return { candidates, estimatedTokens, retag, items }
  })
  handle('tidy-start', (workspaceId: string) => {
    store.record<Workspace>('workspace', workspaceId)
    return extractor.tidyStart(store.active, workspaceId)
  })
  handle('tidy-status', (workspaceId: string): TidyStatus => {
    store.record<Workspace>('workspace', workspaceId)
    return {
      access: 'owner',
      job: extractor.tidyStatus(store.active, workspaceId),
      lastApplied: extractor.tidyLastApplied(store.active, workspaceId)
    }
  })
  handle('tidy-clear', (workspaceId: string, jobId: unknown) => {
    store.record<Workspace>('workspace', workspaceId)
    if (typeof jobId !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
    extractor.tidyClear(store.active, workspaceId, jobId)
  })
  // This PC owns its workspaces, so there is no manager role to request.
  handle('tidy-manager-request', (workspaceId: string) => {
    store.record<Workspace>('workspace', workspaceId)
    return null
  })
  handle('tidy-apply', (workspaceId: string, proposalId: unknown, accepted: unknown, dismissed: unknown) => {
    store.record<Workspace>('workspace', workspaceId)
    if (
      typeof proposalId !== 'string' ||
      !Array.isArray(accepted) ||
      !accepted.every(Number.isInteger) ||
      !Array.isArray(dismissed) ||
      !dismissed.every(Number.isInteger)
    )
      throw new Error('요청 형식이 잘못되었습니다.')
    return extractor.tidyApply(store.active, workspaceId, proposalId, accepted, dismissed)
  })
  handle('attachment', (id: string) => {
    if (!store.list<Question>('question').some((q) => questionImages(q).includes(id)))
      throw new Error('이미지 접근 권한이 없습니다.')
    return store.displayImage(id)
  })
  handle('clear-attachment', (questionId: string, turnId: string) => {
    store.removeAttachment(questionId, turnId)
    changed()
  })
  handle('refine', (raw: string, image?: string) =>
    textCall(prompt(store.settings().promptLanguage, 'refine'), raw, image)
  )
  const findController = (
    id: unknown
  ): { controller: AbortController; profile: string; questionId: string; turnId: string } | undefined =>
    typeof id === 'string' ? (controllers.get(id) ?? [...controllers.values()].find((v) => v.turnId === id)) : undefined
  handle('cancel', (id: string) => {
    const item = findController(id)
    if (item?.profile === store.active) item.controller.abort()
  })
  handle('turn-state', (questionId: string, turnId: string): TurnState => {
    const item = live.get(turnId)
    if (item && item.questionId === questionId && item.profile === store.active)
      return { ...item.state }
    const t = store.record<Question>('question', questionId).turns.find((t) => t.id === turnId)
    if (!t) throw new Error('대화 항목을 찾을 수 없습니다.')
    return {
      answer: t.answer,
      revision: t.revision,
      status: t.status,
      error: t.error,
      actualModel: t.actualModel
    }
  })
  /** A linked PC's work is written only while the workspace is still shared with it. */
  const stillShared = (origin: AskOrigin, workspaceId: string): boolean =>
    origin.kind !== 'peer' || sharedFor(origin.peerId).has(workspaceId)
  const generateTitle = async (
    questionId: string,
    turn: Turn,
    image: string | undefined,
    profile: string,
    plan: AskPlan,
    origin: AskOrigin,
    workspaceId: string
  ): Promise<void> => {
    try {
      const lang = plan.promptLanguage
      let text = prompt(lang, 'title-question', { question: turn.sent })
      if (turn.documents.length)
        text += `\n\n${prompt(lang, 'title-attachments', {
          files: turn.documents
            .map((d) => prompt(lang, 'title-file', { name: d.name, text: d.text.slice(0, 2000) }))
            .join('\n\n')
            .slice(0, 6000)
        })}`
      const title = cleanTitle(
        await chatVia(plan.executor, 'fast', prompt(lang, 'title'), text, image, AbortSignal.timeout(30000))
      )
      if (!stillShared(origin, workspaceId)) return
      const fresh = store.record<Question>('question', questionId, profile)
      // A rename made while the title was generating wins.
      if (!fresh.title && title) {
        store.put('question', profile, { ...fresh, title })
        changed()
      }
    } catch {
      /* No endpoint, empty output, or deleted question: the first turn stays the heading. */
    }
  }
  const BAD_REQUEST = '요청 형식이 잘못되었습니다.'
  /** The linked PC's part of a forwarded question; anything malformed is rejected before any work. */
  const checkPeerAsk = (p: unknown): PeerAsk => {
    if (!p || typeof p !== 'object') throw new Error(BAD_REQUEST)
    const v = p as PeerAsk
    const author = v.author as PeerAsk['author'] | undefined
    const route = v.route as RouteResult | undefined
    if (
      typeof v.ticket !== 'string' ||
      !TICKET.test(v.ticket) ||
      !author ||
      typeof author !== 'object' ||
      !validCard({ name: author.name, avatar: author.avatar }) ||
      typeof author.profileId !== 'string' ||
      author.profileId.length < 1 ||
      author.profileId.length > 100 ||
      typeof author.mobile !== 'boolean' ||
      !route ||
      typeof route !== 'object' ||
      !['simple', 'complex', 'unknown'].includes(route.complexity) ||
      typeof route.reason !== 'string' ||
      route.reason.length > 300 ||
      !['local', 'jev'].includes(route.source) ||
      !['off', 'project', 'workspace'].includes(v.memoryScope) ||
      !Number.isInteger(v.memoryTokens) ||
      v.memoryTokens < 100 ||
      v.memoryTokens > 20000 ||
      (v.promptLanguage !== 'ko' && v.promptLanguage !== 'en') ||
      typeof v.autoTitle !== 'boolean' ||
      typeof v.jevRecall !== 'boolean' ||
      !Array.isArray(v.habits) ||
      v.habits.length > 20 ||
      !v.habits.every(
        (h) =>
          !!h &&
          typeof h.rule === 'string' &&
          h.rule.length >= 1 &&
          h.rule.length <= 300 &&
          typeof h.when === 'string' &&
          h.when.length <= 200 &&
          typeof h.project === 'boolean'
      )
    )
      throw new Error(BAD_REQUEST)
    return {
      ticket: v.ticket,
      author: { profileId: author.profileId, name: author.name.trim(), avatar: author.avatar, mobile: author.mobile },
      route: { complexity: route.complexity, reason: route.reason, source: route.source },
      memoryScope: v.memoryScope,
      memoryTokens: v.memoryTokens,
      jevRecall: v.jevRecall,
      promptLanguage: v.promptLanguage,
      autoTitle: v.autoTitle,
      habits: v.habits.map((h) => ({ rule: h.rule, when: h.when, project: h.project }))
    }
  }
  const ask = async (input: AskInput, origin: AskOrigin): Promise<AskResult> => {
    if (!input || typeof input !== 'object') throw new Error(BAD_REQUEST)
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(input.requestId))
      throw new Error('요청 ID가 잘못되었습니다.')
    if (origin.kind === 'local' && input.peer !== undefined) throw new Error(BAD_REQUEST)
    if (origin.kind === 'peer' && input.peer === undefined) throw new Error(PEER_OUTDATED)
    const peerAsk = origin.kind === 'peer' ? checkPeerAsk(input.peer) : null
    if (peerAsk && (typeof input.model !== 'string' || !input.model || input.model.length > 200))
      throw new Error(BAD_REQUEST)
    const project = store.record<Project>('project', input.projectId)
    if (typeof input.raw !== 'string') throw new Error(BAD_REQUEST)
    if (!input.raw.trim() && !input.image && !input.documents?.length)
      throw new Error('질문이나 첨부를 추가해 주세요.')
    if (input.raw.length > 50000) throw new Error('질문은 50,000자 이내로 입력해 주세요.')
    const documents = input.documents ?? []
    if (!validDocuments(documents)) throw new Error('텍스트 첨부는 최대 5개, 전체 100,000자까지 지원합니다.')
    if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 200))
      throw new Error('모델 이름이 잘못되었습니다.')
    const effort = input.reasoningEffort
    if (effort !== undefined && !['low', 'medium', 'high'].includes(effort))
      throw new Error('추론 강도가 잘못되었습니다.')
    const profile = store.active,
      settings = store.settings(profile)
    // A model the user picked for this question skips routing, Jev included.
    const pinned = input.pinModel === true && !!input.model
    let plan: AskPlan
    let author: TurnAuthor
    if (peerAsk && origin.kind === 'peer') {
      // The linked PC routed the question and runs every model and Jev call itself.
      plan = {
        executor: { kind: 'peer', peerId: origin.peerId, ticket: peerAsk.ticket },
        routing: peerAsk.route,
        model: input.model,
        memoryScope: peerAsk.memoryScope,
        memoryTokens: peerAsk.memoryTokens,
        jevRecall: peerAsk.jevRecall,
        promptLanguage: peerAsk.promptLanguage,
        autoTitle: peerAsk.autoTitle,
        habits: peerAsk.habits
      }
      author = {
        profileId: peerAsk.author.profileId,
        name: peerAsk.author.name,
        avatar: peerAsk.author.avatar,
        device: origin.device,
        ...(peerAsk.author.mobile ? { mobile: true } : {}),
        peer: origin.peerId
      }
    } else {
      const routing = pinned
        ? recommend(input.raw, !!input.image)
        : await askRoute(profile, settings, input.raw, !!input.image)
      plan = {
        executor: LOCAL,
        routing,
        model:
          settings.routing === 'auto' && !pinned ? routedModel(settings, routing.complexity) : input.model || settings.model,
        memoryScope: settings.memoryScope,
        memoryTokens: settings.memoryTokens,
        jevRecall: settings.jevRecall,
        promptLanguage: settings.promptLanguage,
        autoTitle: settings.autoTitle,
        habits: null
      }
      const me = store.profile()
      author = {
        profileId: me.id,
        name: me.name,
        avatar: me.avatar,
        device: hostname(),
        ...(origin.kind === 'local' && origin.mobile ? { mobile: true } : {})
      }
    }
    const { routing, model } = plan
    const saveOnly = !!input.saveOnly
    const annotated = input.annotated === true && !!input.image
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          project.id,
          input.questionId ?? '',
          input.raw,
          input.refined ?? '',
          input.model ?? '',
          input.image ? createHash('sha256').update(input.image).digest('hex') : '',
          documents,
          saveOnly,
          annotated,
          input.useMemory ?? null,
          effort ?? '',
          pinned
        ])
      )
      .digest('hex')
    // Images are content-addressed files written outside the transaction.
    const attachment = input.image ? saveImage(input.image) : null
    const turn: Turn = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      raw: input.raw,
      refined: input.refined || '',
      sent:
        input.refined ||
        input.raw ||
        (input.image ? '첨부한 이미지를 설명해 주세요.' : '첨부한 파일을 설명해 주세요.'),
      answer: '',
      model,
      actualModel: '',
      status: saveOnly ? 'saved' : 'running',
      complexity: routing.complexity,
      routingReason: routing.reason,
      attachment,
      documents,
      error: '',
      revision: 0,
      author
    }
    let recorded: { questionId: string; turnId: string; replay: boolean }
    try {
      recorded = store.recordAsk({
        requestId: input.requestId,
        requestHash,
        profile,
        projectId: project.id,
        questionId: input.questionId,
        turn,
        saveOnly
      })
    } catch (e) {
      if (attachment && !store.isImageReferenced(attachment)) store.deleteImage(attachment)
      throw e
    }
    const { questionId, turnId } = recorded
    // A retried request returns the original IDs without restarting any work.
    if (recorded.replay) return { questionId, turnId }
    recentQuestions.set(project.id, questionId)
    changed()
    if (!input.questionId && plan.autoTitle)
      void generateTitle(questionId, turn, input.image, profile, plan, origin, project.workspaceId)
    if (saveOnly) return { questionId, turnId }
    const controller = new AbortController()
    controllers.set(input.requestId, { controller, profile, questionId, turnId })
    const state: TurnState = {
      answer: '',
      revision: 0,
      status: 'running',
      error: '',
      actualModel: ''
    }
    live.set(turnId, { questionId, profile, state })
    /** Stops a linked PC's question whose workspace is no longer shared with it. */
    const revokedShare = (): boolean => {
      if (stillShared(origin, project.workspaceId)) return false
      if (!controller.signal.aborted) controller.abort(new Error(SHARE_REVOKED))
      return true
    }
    // Return the saved IDs immediately. Work continues through event notifications.
    void (async () => {
      try {
        const history = store
          .record<Question>('question', questionId, profile)
          .turns.filter((t) => t.id !== turnId && t.status === 'completed')
          .slice(-8)
        const scope =
          input.useMemory === false
            ? 'off'
            : input.useMemory === true && plan.memoryScope === 'off'
              ? 'project'
              : plan.memoryScope
        // Text clues: the current question, its text files, and recent questions of a follow-up.
        // An image without refined text (refine already reads the image) adds search keywords
        // from the fast model; failure only loses the clue.
        const lang = plan.promptLanguage
        const imageClue =
          scope !== 'off' && input.image && !input.refined
            ? await chatVia(
                plan.executor,
                'fast',
                prompt(lang, 'search-keywords'),
                input.raw || prompt(lang, 'search-keywords-fallback'),
                input.image,
                AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
              ).catch(() => '')
            : ''
        const clues = [
          input.refined || input.raw,
          imageClue.slice(0, 200),
          ...documents.map((d) => d.text.slice(0, 1000)),
          ...history.slice(-2).map((t) => t.refined || t.raw)
        ].join('\n')
        let memory: RecallResult = { context: [], references: [] }
        if (scope !== 'off') {
          const params: RecallParams = {
            profile,
            scope,
            projectId: project.id,
            workspaceId: project.workspaceId,
            questionId,
            text: clues,
            budgetChars: plan.memoryTokens * 3
          }
          const call = jevVia(plan.executor, plan.jevRecall)
          memory = call
            ? await jevRecall(
                store,
                params,
                call,
                AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
              ).catch((e: unknown) => {
                if (controller.signal.aborted) throw e
                console.warn('Jev recall failed; falling back to keyword search')
                return recallMemory(store, params)
              })
            : recallMemory(store, params)
        }
        if (revokedShare()) controller.signal.throwIfAborted()
        if (memory.references.length)
          store.updateTurn(questionId, turnId, { references: memory.references }, profile)
        // A linked PC sends its own profile's habit lines; this PC's questions use this profile's habits.
        const habitLines =
          plan.habits ??
          (settings.answerHabits
            ? toLines(recallHabits(store, { profile, project: { owner: profile, id: project.id }, text: clues }))
            : [])
        const messages: WireMessage[] = [
          {
            role: 'system',
            content:
              prompt(lang, 'answer', { project: project.name }) +
              (memory.context.length
                ? `\n\n${prompt(lang, 'answer-memory', { context: JSON.stringify(memory.context) })}`
                : '') +
              (habitLines.length
                ? `\n\n${prompt(lang, 'answer-habits', { habits: habitPrompt(habitLines, lang) })}`
                : '') +
              (annotated ? `\n\n${prompt(lang, 'annotation')}` : '')
          }
        ]
        const contentWithFiles = (t: Turn): string =>
          t.sent +
          (t.documents.length
            ? `\n\n${prompt(lang, 'attachments', { documents: JSON.stringify(t.documents) })}`
            : '')
        for (const previous of history)
          messages.push(
            { role: 'user', content: contentWithFiles(previous) },
            { role: 'assistant', content: previous.answer.slice(0, 12000) }
          )
        messages.push({
          role: 'user',
          content: input.image
            ? [
                { type: 'text', text: contentWithFiles(turn) },
                { type: 'image_url', image_url: { url: input.image } }
              ]
            : contentWithFiles(turn)
        })
        let lastSave = 0
        await streamVia(plan.executor, model, messages, effort, controller.signal, (delta, actualModel) => {
          state.answer += delta
          state.revision += 1
          if (actualModel) state.actualModel = actualModel
          emit({ requestId: input.requestId, questionId, turnId, revision: state.revision, delta })
          if (Date.now() - lastSave > 400) {
            if (revokedShare()) return
            store.updateTurn(
              questionId,
              turnId,
              { answer: state.answer, actualModel: state.actualModel, revision: state.revision },
              profile
            )
            lastSave = Date.now()
          }
        })
        if (revokedShare()) controller.signal.throwIfAborted()
        if (!state.answer.trim()) throw new Error('모델이 빈 답변을 반환했습니다.')
        state.status = 'completed'
      } catch (e) {
        const reason: unknown = controller.signal.reason
        state.status = controller.signal.aborted ? 'cancelled' : 'failed'
        state.error =
          reason instanceof Error && reason.message === SHARE_REVOKED
            ? SHARE_REVOKED
            : e instanceof Error
              ? e.message
              : '요청이 실패했습니다.'
      } finally {
        if (revokedShare()) {
          state.status = 'cancelled'
          state.error = SHARE_REVOKED
        }
        // The final state is stored before `done`, so a client re-reading on done sees it.
        state.revision += 1
        store.updateTurn(
          questionId,
          turnId,
          {
            answer: state.answer,
            actualModel: state.actualModel,
            status: state.status,
            error: state.error,
            revision: state.revision
          },
          profile
        )
        store.db
          .prepare('UPDATE runs SET status=?,error=? WHERE id=?')
          .run(state.status, state.error, input.requestId)
        live.delete(turnId)
        emit({
          requestId: input.requestId,
          questionId,
          turnId,
          revision: state.revision,
          done: true,
          error: state.error || undefined
        })
        changed()
      }
      if (state.status === 'completed') {
        extractor.completed(profile, questionId)
        // A linked PC checks its own habit feedback on its own device.
        if (origin.kind === 'local' && store.settings().answerHabits)
          habitDetector.schedule(questionId, false, store.settings().extractDelaySec * 1000)
      }
      if (
        settings.retention === 'minimal' &&
        state.status === 'completed' &&
        attachment &&
        profile === store.active
      ) {
        store.removeAttachment(questionId, turnId)
        changed()
      }
      controllers.delete(input.requestId)
    })()
    return { questionId, turnId }
  }
  // Dispatched with its origin by the router's local callback and hubInvoke; registered for the allowlists.
  handle('ask', () => {
    throw new Error(UNSUPPORTED)
  })
  handle('displays', () => capture.displays())
  handle('open-editor', (id: number) => capture.edit(id))
  // ── Forwarding (this PC asking a linked PC's workspace with its own resources) ──
  const prepareForward = async (
    name: string,
    args: unknown[],
    peerId: string,
    ctx: { mobile: boolean }
  ): Promise<unknown[]> => {
    if (name !== 'ask' && name !== 'tidy-start') return args
    // An older host would answer with its own resources; there is no such fallback.
    if (typeof peers.get(peerId)?.snapshot?.profile?.id !== 'string') throw new Error(PEER_OUTDATED)
    if (name === 'tidy-start') return [args[0], runner.issue(peerId, 'tidy')]
    const input = args[0] as AskInput
    if (!input || typeof input !== 'object' || typeof input.raw !== 'string') throw new Error(BAD_REQUEST)
    const s = store.settings()
    const hasImage = !!input.image
    const pinned = input.pinModel === true && !!input.model
    const route = pinned ? recommend(input.raw, hasImage) : await askRoute(store.active, s, input.raw, hasImage)
    const model = s.routing === 'auto' && !pinned ? routedModel(s, route.complexity) : input.model || s.model
    if (!model) throw new Error('설정에서 사용할 모델을 선택해 주세요.')
    const owner = router.remoteOwner(input.projectId)
    if (!owner) throw new Error(PEER_OUTDATED)
    const documents = Array.isArray(input.documents) ? input.documents : []
    const habits = s.answerHabits
      ? toLines(
          recallHabits(store, {
            profile: store.active,
            project: { owner, id: input.projectId },
            text: [input.refined || input.raw, ...documents.map((d) => String(d?.text ?? '').slice(0, 1000))].join('\n')
          })
        )
      : []
    const me = store.profile()
    const ticket = runner.issue(peerId, 'ask', { model, question: input.refined || input.raw })
    const peer: PeerAsk = {
      ticket,
      author: { profileId: me.id, name: me.name, avatar: me.avatar, mobile: ctx.mobile },
      route,
      memoryScope: s.memoryScope,
      memoryTokens: s.memoryTokens,
      jevRecall: s.jevRecall && s.hasJevKey,
      promptLanguage: s.promptLanguage,
      autoTitle: s.autoTitle,
      habits
    }
    return [{ ...input, model, peer }]
  }
  // Extraction of forwarded questions runs on this PC's resources; the host calls back with a ticket.
  const peerExtract = new Map<string, { peerId: string; timer: NodeJS.Timeout; tries: number }>()
  const schedulePeerExtract = (peerId: string, questionId: string, ms: number, tries = 0): void => {
    const previous = peerExtract.get(questionId)
    if (previous) clearTimeout(previous.timer)
    const attempt = tries || previous?.tries || 0
    const timer = setTimeout(async () => {
      const ticket = runner.issue(peerId, 'extract')
      let result: unknown
      try {
        result = await peers.get(peerId)?.rpc('extract-run', [questionId, ticket])
      } catch {
        result = undefined
      }
      if (peerExtract.get(questionId)?.timer !== timer) return
      // Started: the ticket's single call and 10-minute life end it on their own.
      if (result === 'started') {
        peerExtract.delete(questionId)
        return
      }
      runner.revoke(ticket)
      if (attempt < 10) schedulePeerExtract(peerId, questionId, 60_000, attempt + 1)
      else peerExtract.delete(questionId)
    }, ms)
    peerExtract.set(questionId, { peerId, timer, tries: attempt })
  }
  handle('preview', () => {
    if (!capture.preview) throw new Error('편집 미리보기가 없습니다.')
    return capture.preview
  })
  handle('save-region', (region) => {
    const result = capture.saveRegion(region)
    if (!result.ok) {
      requestCaptureSetup(result)
      return result
    }
    const targets = new Set([main(), capture.overlay])
    for (const target of targets)
      if (target && !target.isDestroyed())
        target.webContents.send('personal:capture-region-saved', result.value)
    capture.editor?.close()
    return result
  })
  handle('close-editor', () => capture.editor?.close())
  handle('edit-overlay-region', () => {
    if (capture.displayId === null) throw new Error('오버레이를 먼저 열어 주세요.')
    return capture.edit(capture.displayId)
  })
  handle('open-overlay', (id: string, questionId?: string) => {
    anyProject(id)
    if (questionId && anyQuestion(questionId).projectId !== id)
      throw new Error('프로젝트가 다른 질문입니다.')
    const result = capture.open(id, !!questionId)
    if (result.ok) {
      if (questionId) recentQuestions.set(id, questionId)
      lastProjectId = id
    }
    return result
  })
  handle('capture', (strokes?: string) => capture.question(strokes))
  handle('dashboard', () => capture.showDashboard())
  const projectArchive = (projectId: string, options: ExportOptions): Buffer => {
    const project = store.record<Project>('project', projectId)
    return buildExport(
      {
        workspace: store.record<Workspace>('workspace', project.workspaceId),
        project,
        concepts: store.list('concept'),
        relations: store.list('relation'),
        questions: store.list<Question>('question').filter((q) => q.projectId === projectId),
        image: (id) => {
          const path = store.imagePath(id)
          return existsSync(path) ? readFileSync(path) : null
        }
      },
      options
    )
  }
  // Sent to a linked PC or the phone over the pinned-TLS hub connection; never written to disk here.
  handle('export-archive', (projectId: string, raw: unknown) => {
    const archive = projectArchive(projectId, exportOptions(raw))
    if (archive.length > EXPORT_TRANSFER_MAX) throw new Error(EXPORT_TOO_LARGE)
    return archive.toString('base64')
  })
  handle('export', async (projectId: string, raw: unknown) => {
    const project = anyProject(projectId)
    const options = exportOptions(raw)
    // A linked-PC archive is fetched before the dialog so grant and size errors show before a path is picked.
    let archive: Buffer
    if (router.remoteProject(projectId)) {
      const data = await router.route('export-archive', [projectId, options])
      if (typeof data !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
      archive = Buffer.from(data, 'base64')
    } else archive = projectArchive(projectId, options)
    const result = await dialog.showSaveDialog({
      title: t('프로젝트 기억 내보내기'),
      defaultPath: exportFileName(project.name),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, archive)
    return true
  })
  handle('backup', async () => {
    if (controllers.size) throw new Error('진행 중인 요청을 마친 뒤 백업해 주세요.')
    const result = await dialog.showSaveDialog({
      title: t('백업 (이미지 포함, 설정·접속 키 제외)'),
      defaultPath: 'fask-backup.json',
      filters: [{ name: 'FASK backup', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const { workspaces, projects, concepts, relations, questions } = store.snapshot()
    const images = Object.fromEntries(
      [...new Set(questions.flatMap(questionImages))].map((id) => [id, store.image(id)])
    )
    writeFileSync(
      result.filePath,
      JSON.stringify({
        version: 4,
        owner: store.active,
        snapshot: { workspaces, projects, concepts, relations, questions },
        images,
        // Superseded habits too, so `replaces` chains survive a restore.
        habits: store.list<Habit>('habit')
      }),
      'utf8'
    )
    return true
  })
  handle('restore', async () => {
    if (controllers.size || capture.overlay || capture.editor)
      throw new Error('요청과 오버레이를 닫고 복원해 주세요.')
    const result = await dialog.showOpenDialog({
      title: t('백업 가져오기'),
      properties: ['openFile'],
      filters: [{ name: 'FASK backup', extensions: ['json'] }]
    })
    if (result.canceled) return false
    const backup = validateBackup(JSON.parse(readFileSync(result.filePaths[0], 'utf8')))
    // Validate all references before mutation; restore under fresh IDs into this profile.
    const snapshot = backup.snapshot
    const ids = new Map<string, string>()
    for (const item of [
      ...snapshot.workspaces,
      ...snapshot.projects,
      ...snapshot.concepts,
      ...snapshot.relations,
      ...snapshot.questions
    ]) {
      if (typeof item.id !== 'string' || ids.has(item.id))
        throw new Error('백업 ID가 잘못되었습니다.')
      ids.set(item.id, randomUUID())
    }
    const mapped = (id: string): string => {
      const value = ids.get(id)
      if (!value) throw new Error('백업 참조가 잘못되었습니다.')
      return value
    }
    for (const p of snapshot.projects) mapped(p.workspaceId)
    for (const c of snapshot.concepts) {
      mapped(c.workspaceId)
      if (c.parentId) mapped(c.parentId)
    }
    for (const r of snapshot.relations) {
      mapped(r.workspaceId)
      mapped(r.from)
      mapped(r.to)
    }
    // Turn IDs key live state, cancellation, and runs, so restored copies get new ones.
    const turnIds = new Map<string, string>()
    for (const q of snapshot.questions) {
      mapped(q.projectId)
      for (const id of q.conceptIds) mapped(id)
      for (const id of Object.keys(q.conceptTurns)) mapped(id)
      for (const t of q.turns) turnIds.set(t.id, randomUUID())
      for (const image of questionImages(q))
        if (typeof backup.images?.[image] !== 'string') throw new Error('백업 이미지가 없습니다.')
    }
    const turnMapped = (list: string[]): string[] => list.flatMap((id) => turnIds.get(id) ?? [])
    store.db.exec('BEGIN')
    try {
      const profile = store.active
      const taken = new Set(store.list<Workspace>('workspace').map((w) => w.name))
      const suffix = ` (복원 ${new Date().toLocaleDateString('ko-KR')})`
      for (const w of snapshot.workspaces)
        store.put('workspace', profile, {
          ...w,
          id: mapped(w.id),
          profileId: profile,
          name: taken.has(w.name) ? `${w.name}${suffix}` : w.name
        })
      for (const p of snapshot.projects)
        store.put('project', profile, {
          ...p,
          id: mapped(p.id),
          workspaceId: mapped(p.workspaceId)
        })
      for (const c of snapshot.concepts) {
        const concept: Concept = {
          ...c,
          id: mapped(c.id),
          workspaceId: mapped(c.workspaceId),
          parentId: c.parentId ? mapped(c.parentId) : null
        }
        // Partner ids of pairs tidy left apart; partners missing from the backup are dropped.
        const pairs = c.tidyPairs?.flatMap((id) => ids.get(id) ?? [])
        if (pairs?.length) concept.tidyPairs = pairs
        else delete concept.tidyPairs
        store.put('concept', profile, concept)
      }
      for (const r of snapshot.relations)
        store.put('relation', profile, {
          ...r,
          id: mapped(r.id),
          workspaceId: mapped(r.workspaceId),
          from: mapped(r.from),
          to: mapped(r.to),
          questionId: r.questionId ? (ids.get(r.questionId) ?? null) : null,
          turnIds: turnMapped(r.turnIds)
        })
      for (const q of snapshot.questions) {
        const question: Question = {
          ...q,
          id: mapped(q.id),
          projectId: mapped(q.projectId),
          conceptIds: q.conceptIds.map(mapped),
          conceptTurns: Object.fromEntries(
            Object.entries(q.conceptTurns).map(([id, turns]) => [mapped(id), turnMapped(turns)])
          ),
          ...(q.conceptRoles
            ? { conceptRoles: Object.fromEntries(Object.entries(q.conceptRoles).map(([id, v]) => [mapped(id), v])) }
            : {}),
          ...(q.conceptSources
            ? { conceptSources: Object.fromEntries(Object.entries(q.conceptSources).map(([id, v]) => [mapped(id), v])) }
            : {}),
          turns: q.turns.map((t) => ({
            ...t,
            id: turnIds.get(t.id) ?? randomUUID(),
            status: t.status === 'running' ? 'failed' : t.status,
            revision: t.status === 'running' ? t.revision + 1 : t.revision,
            attachment: t.attachment ? saveImage(backup.images[t.attachment]) : null,
            ...(t.references
              ? {
                  references: t.references.flatMap((r) => {
                    const id = ids.get(r.id)
                    return id ? [{ ...r, id }] : []
                  })
                }
              : {})
          })),
          // Past turns of an older backup are not checked for habits after the restore.
          habitTurns: q.habitTurns ?? q.turns.length
        }
        // The workspace in which tidy's move offer was kept; one outside the backup is dropped.
        const stay = q.tidyStay === undefined ? undefined : ids.get(q.tidyStay)
        if (stay) question.tidyStay = stay
        else delete question.tidyStay
        store.put('question', profile, question)
      }
      const habitIds = new Map(backup.habits.map((h) => [h.id, randomUUID()]))
      for (const h of backup.habits)
        store.put<Habit>('habit', profile, {
          ...h,
          id: habitIds.get(h.id) ?? randomUUID(),
          ...(h.scope === 'project' && h.projectOwner === backup.owner && h.projectId
            ? { projectOwner: profile, projectId: mapped(h.projectId) }
            : {}),
          overrides: h.overrides ? (habitIds.get(h.overrides) ?? null) : null,
          replaces: h.replaces ? (habitIds.get(h.replaces) ?? null) : null,
          sources: h.sources.flatMap((s) => {
            const questionId = ids.get(s.questionId)
            return questionId ? [{ questionId, turnIds: turnMapped(s.turnIds) }] : []
          })
        })
      store.db.exec('COMMIT')
      changed()
      return true
    } catch (e) {
      store.db.exec('ROLLBACK')
      throw e
    }
  })
  // ── Answer habits ── per profile, local to this PC; the phone may list and decide them.
  /** This PC's projects plus the remote projects visible now (hosts on older builds have no owner id). */
  const habitProjects = (): { owner: string; id: string; name: string }[] => {
    const local = store.list<Project>('project').map((p) => ({ owner: store.active, id: p.id, name: p.name }))
    const merged = router.merge(localSnapshot())
    const remote = merged.workspaces.flatMap((w) => {
      const owner = w.remote?.owner?.id
      if (!owner || !w.remote) return []
      const pc = w.remote.name
      return merged.projects
        .filter((p) => p.workspaceId === w.id)
        .map((p) => ({ owner, id: p.id, name: `${pc} / ${p.name}` }))
    })
    return [...local, ...remote]
  }
  handle('habits', () => listHabits(store, store.active, habitProjects()))
  handle('habit-decide', (id: string, decision: unknown) => {
    if (decision !== 'active' && decision !== 'rejected') throw new Error('요청 형식이 잘못되었습니다.')
    decideHabit(store, store.active, String(id), decision)
    changed()
  })
  handle('habit-save', (input: HabitInput) => {
    const id = saveHabit(
      store,
      store.active,
      input,
      (owner, projectId) =>
        (owner === store.active && store.list<Project>('project').some((p) => p.id === projectId)) ||
        router.remoteOwner(projectId) === owner
    )
    changed()
    return id
  })
  handle('habit-remove', (id: string) => {
    store.removeHabit(String(id))
    changed()
  })
  handle('habit-export', async () => {
    const result = await dialog.showSaveDialog({
      title: t('답변 습관 저장'),
      defaultPath: 'fask-habits.json',
      filters: [{ name: 'FASK habits', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, habitFile(store, store.active), 'utf8')
    return true
  })
  handle('habit-import', (text: string) => {
    const result = importHabitFile(store, store.active, text)
    changed()
    return result
  })
  // ── Mobile hub ── global (not per-profile) settings; secrets are encrypted with safeStorage.
  const readSecret = (name: string): string => {
    const value = store.pref(name)
    if (!value) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 키 저장소를 사용할 수 없습니다.')
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }
  const writeSecret = (name: string, value: string): void => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 키 저장소를 사용할 수 없습니다.')
    store.pref(name, safeStorage.encryptString(value).toString('base64'))
  }
  const hubTls = (): HubTls => {
    const value: unknown = JSON.parse(readSecret('hub:tls'))
    if (
      !value ||
      typeof value !== 'object' ||
      !('cert' in value && typeof value.cert === 'string') ||
      !('key' in value && typeof value.key === 'string') ||
      !('fingerprint' in value && typeof value.fingerprint === 'string')
    )
      throw new Error('모바일 연결 인증서가 손상되었습니다. 연결을 초기화해 주세요.')
    return { cert: value.cert, key: value.key, fingerprint: value.fingerprint }
  }
  const resetHubSecrets = async (): Promise<void> => {
    const tls = await createHubCertificate()
    writeSecret('hub:token', randomBytes(32).toString('base64url'))
    writeSecret('hub:tls', JSON.stringify(tls))
    writeSecret('hub:relay-key', randomBytes(32).toString('base64url'))
    // A new certificate invalidates every linked PC's pin, so their grants go too.
    for (const grant of grants()) hub.disconnect(grant.id)
    writeSecret('hub:peers', '[]')
    pairStop()
  }
  const relayUrl = (): string => normalizeRelayUrl(store.pref('hub:relay-url') || DEFAULT_RELAY_URL) ?? ''
  const relayActive = (): boolean => store.pref('hub:relay') === '1' && !!relayUrl()
  const selectedAddresses = (): string[] => {
    const value: unknown = JSON.parse(store.pref('hub:addresses') || '[]')
    return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : []
  }
  const interfaceAddresses = (): string[] =>
    Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)
    )
  let hubResults: HubListenResult[] = []
  let hubError = ''
  // Start/stop/reset run one at a time so a restart never races a stop.
  let hubQueue: Promise<unknown> = Promise.resolve()
  const hubTask = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = hubQueue.then(fn, fn)
    hubQueue = next.catch(() => {})
    return next
  }
  const stopHub = async (): Promise<void> => {
    pairStop()
    hubRelay.stop()
    await hub.stop()
    broker.close()
    hubResults = []
    hubError = ''
    mobileTokenHash = null
  }
  const startHub = async (): Promise<void> => {
    await stopHub()
    const addresses = selectedAddresses()
    // Never bind automatically: the user picks each interface the phone may reach.
    if (!addresses.length && !relayActive()) {
      hubError = '연결에 사용할 주소를 선택하거나 중계 연결을 켜세요.'
      return
    }
    try {
      if (!store.pref('hub:token') || !store.pref('hub:tls')) await resetHubSecrets()
      if (!store.pref('hub:relay-key')) writeSecret('hub:relay-key', randomBytes(32).toString('base64url'))
      mobileTokenHash = sha256(readSecret('hub:token'))
      hubResults = await hub.start(addresses, HUB_PORT, hubAuth, hubTls())
      if (relayActive()) hubRelay.start(relayUrl(), readSecret('hub:relay-key'))
    } catch (e) {
      hubError = e instanceof Error ? e.message : String(e)
    }
  }
  const PAIRING_ORDER: Record<HubAddress['kind'], number> = { lan: 0, tailscale: 1, other: 2 }
  const hubStatus = (): HubStatus => {
    const enabled = store.pref('hub:enabled') === '1'
    const selected = selectedAddresses(),
      current = interfaceAddresses()
    const addresses = [...new Set([...current, ...selected])]
      .map((address): HubAddress => {
        const kind = addressKind(address)
        const result = hubResults.find((r) => r.address === address)
        return {
          address,
          kind,
          recommended: kind !== 'other',
          selected: selected.includes(address),
          listening: hub.running && !!result && !result.error,
          error: current.includes(address) ? (result?.error ?? '') : t('현재 네트워크에 없는 주소입니다.')
        }
      })
      .sort((a, b) => HUB_KIND_ORDER[a.kind] - HUB_KIND_ORDER[b.kind])
    const listening = addresses
      .filter((a) => a.listening)
      .sort((a, b) => PAIRING_ORDER[a.kind] - PAIRING_ORDER[b.kind])
    // The relay is part of the pairing only once this session registered it (secrets exist then).
    const relay = relayActive() && hubRelay.state !== 'off'
    const relayQuery = relay
      ? `&r=${encodeURIComponent(relayUrl())}&rk=${relayRoom(readSecret('hub:relay-key'))}`
      : ''
    return {
      enabled,
      port: HUB_PORT,
      addresses,
      relay: {
        enabled: store.pref('hub:relay') === '1',
        url: relayUrl(),
        state: hubRelay.state,
        error: hubRelay.error
      },
      pairing:
        enabled && (listening.length || relay)
          ? `fask://pair?v=1&p=${HUB_PORT}&fp=${hubTls().fingerprint}&t=${readSecret('hub:token')}${listening.map((a) => `&a=${a.address}`).join('')}${relayQuery}`
          : '',
      error: enabled ? hubError : ''
    }
  }
  handle('hub-status', () => hubTask(async () => hubStatus()))
  handle('hub-enable', (enabled: boolean) =>
    hubTask(async () => {
      store.pref('hub:enabled', enabled ? '1' : '')
      if (enabled) await startHub()
      else await stopHub()
      return hubStatus()
    })
  )
  handle('hub-addresses', (addresses: unknown) =>
    hubTask(async () => {
      const allowed = hubStatus().addresses.map((a) => a.address)
      if (
        !Array.isArray(addresses) ||
        addresses.some(
          (a) => typeof a !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(a) || !allowed.includes(a)
        )
      )
        throw new Error('선택할 수 없는 주소입니다.')
      store.pref('hub:addresses', JSON.stringify([...new Set(addresses)]))
      if (store.pref('hub:enabled') === '1') await startHub()
      return hubStatus()
    })
  )
  handle('hub-relay', (enabled: unknown, url: unknown) =>
    hubTask(async () => {
      if (typeof enabled !== 'boolean' || typeof url !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
      const normalized = url.trim() ? normalizeRelayUrl(url) : ''
      if (normalized === null) throw new Error('중계 서버 주소는 wss://로 시작해야 합니다.')
      if (enabled && !normalized && !DEFAULT_RELAY_URL) throw new Error('중계 서버 주소를 입력하세요.')
      store.pref('hub:relay', enabled ? '1' : '')
      store.pref('hub:relay-url', normalized === DEFAULT_RELAY_URL ? '' : normalized)
      if (store.pref('hub:enabled') === '1') await startHub()
      return hubStatus()
    })
  )
  handle('hub-reset', () =>
    hubTask(async () => {
      await resetHubSecrets()
      if (store.pref('hub:enabled') === '1') await startHub()
      return hubStatus()
    })
  )
  // ── Peer PCs authorized on this hub ── only token hashes are stored.
  const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()
  let mobileTokenHash: Buffer | null = null
  let grantCache: PeerGrant[] | null = null
  const grants = (): PeerGrant[] => {
    if (!grantCache) {
      const value: unknown = JSON.parse(readSecret('hub:peers') || '[]')
      const list = Array.isArray(value) ? (value as PeerGrant[]) : []
      // Grants from before selective sharing share nothing until the host picks again; it is told so.
      if (list.some((g) => !Array.isArray(g.workspaces))) {
        const reset = list.map((g) => (Array.isArray(g.workspaces) ? g : { ...g, workspaces: [] }))
        writeSecret('hub:peers', JSON.stringify(reset))
        store.pref('peer-share-notice', '1')
        grantCache = reset
      } else grantCache = list
    }
    return grantCache
  }
  const saveGrants = (list: PeerGrant[]): void => {
    writeSecret('hub:peers', JSON.stringify(list))
    grantCache = list
  }
  /** This PC's workspaces shared with a linked PC (existing ones only); none for an unknown caller. */
  const sharedFor = (peerId: string): Set<string> => {
    const grant = grants().find((g) => g.id === peerId)
    if (!grant?.workspaces.length) return new Set()
    return new Set(grant.workspaces.filter((id) => localHas(id)))
  }
  const hubAuth = (bearer: string): HubCaller | null => {
    const hash = sha256(bearer)
    if (mobileTokenHash && timingSafeEqual(hash, mobileTokenHash)) return { kind: 'mobile' }
    for (const grant of grants())
      if (timingSafeEqual(hash, Buffer.from(grant.tokenHash, 'hex'))) return { kind: 'peer', id: grant.id }
    return null
  }
  /**
   * Stops a linked PC's work on this PC's workspaces (`null` = all of them): its running answers,
   * extraction and tidy, its deferred extraction turns and, for a full cut, its compute requests.
   */
  const cutPeer = (peerId: string, workspaceIds: ReadonlySet<string> | null): void => {
    for (const item of controllers.values()) {
      let turn: Turn | undefined
      let workspace = ''
      try {
        turn = store.record<Question>('question', item.questionId).turns.find((t) => t.id === item.turnId)
        workspace = store.scopeOf('question', item.questionId)
      } catch {
        continue
      }
      if (turn?.author?.peer === peerId && (workspaceIds === null || workspaceIds.has(workspace)))
        item.controller.abort(new Error(SHARE_REVOKED))
    }
    extractor.abortPeer(peerId, workspaceIds)
    extractor.dropDeferred(store.active, peerId, workspaceIds)
    if (workspaceIds === null) broker.dropPeer(peerId)
  }
  const revokeGrant = (id: string): void => {
    saveGrants(grants().filter((g) => g.id !== id))
    hub.disconnect(id)
    cutPeer(id, null)
    for (const client of [...focused.keys()]) if (client.startsWith(`peer:${id}:`)) focusQuestion(client, null)
    changed()
  }
  const tailscaleListening = (): string[] =>
    hubResults.filter((r) => !r.error && addressKind(r.address) === 'tailscale').map((r) => r.address)
  const relayServing = (): boolean => relayActive() && hubRelay.state !== 'off'
  const pairPayload = (kind: 'pc' | 'mobile', name: string): PairPayload => {
    if (kind === 'mobile') {
      const uri = hubStatus().pairing
      if (!uri) throw new PairError(410, '연결 코드가 없거나 만료되었습니다.')
      setImmediate(() => changed())
      return { kind: 'mobile', pairing: uri }
    }
    const token = randomBytes(32).toString('base64url')
    const grant: PeerGrant = {
      id: randomUUID(),
      name: name.trim() || '다른 PC',
      tokenHash: sha256(token).toString('hex'),
      createdAt: Date.now(),
      workspaces: []
    }
    saveGrants([...grants(), grant])
    setImmediate(() => changed())
    return {
      kind: 'pc',
      peerId: grant.id,
      token,
      certPem: hubTls().cert,
      hostName: hostname(),
      addresses: tailscaleListening(),
      relay: relayServing() ? { url: relayUrl(), room: relayRoom(readSecret('hub:relay-key')) } : null
    }
  }
  handle('peer-code-begin', () =>
    hubTask(async () => {
      const addresses = tailscaleListening()
      const relay = relayServing()
      if (store.pref('hub:enabled') !== '1' || (!addresses.length && !relay))
        throw new Error('먼저 기기 연결을 켜고 Tailscale 주소나 릴레이를 사용해 주세요.')
      pairStop()
      const generation = ++pairGeneration
      const { code, rendezvous, expiresAt } = await pairing.begin(hubTls().fingerprint)
      if (relay) pairRelay.start(relayUrl(), await pairRelayKey(rendezvous))
      pairTimer = setTimeout(() => {
        if (generation !== pairGeneration) return
        pairStop()
        changed()
      }, expiresAt - Date.now())
      return { code, expiresAt, addresses, relay }
    })
  )
  handle('peer-code-status', () => {
    const status = pairing.status()
    if (!status) return null
    if (pairRelay.state === 'error' && pairRelay.error === RELAY_REPLACED) {
      pairStop()
      throw new Error('연결 코드 대기가 중단되었습니다. 새 코드를 만들어 주세요.')
    }
    return { ...status, waiting: pairRelay.state }
  })
  handle('peer-code-cancel', () => {
    pairStop()
    changed()
  })
  handle('peer-grants', () =>
    grants().map((g) => ({
      id: g.id,
      name: g.name,
      createdAt: g.createdAt,
      manager: g.manager ?? 'none',
      managerAt: g.managerAt ?? null,
      workspaces: [...sharedFor(g.id)],
      shareReviewed: !!g.shareReviewedAt
    }))
  )
  handle('peer-grant-share', (id: unknown, ids: unknown) => {
    if (typeof id !== 'string' || !Array.isArray(ids) || !ids.every((w) => typeof w === 'string'))
      throw new Error('요청 형식이 잘못되었습니다.')
    const grant = grants().find((g) => g.id === id)
    if (!grant) return
    const own = new Set(store.list<Workspace>('workspace').map((w) => w.id))
    if (!ids.every((w) => own.has(w))) throw new Error('공유할 수 없는 워크스페이스입니다.')
    const next = [...new Set(ids as string[])]
    const removed = grant.workspaces.filter((w) => !next.includes(w))
    saveGrants(grants().map((g) => (g.id === id ? { ...g, workspaces: next, shareReviewedAt: Date.now() } : g)))
    if (removed.length) cutPeer(id, new Set(removed))
    // The linked PC re-reads its snapshot and drops what is no longer shared.
    changed()
  })
  handle('peer-share-notice', () => store.pref('peer-share-notice') === '1')
  handle('peer-share-notice-ack', () => {
    store.db.prepare("DELETE FROM preferences WHERE key='peer-share-notice'").run()
  })
  handle('peer-grant-manager', (id: unknown, decision: unknown) => {
    if (typeof id !== 'string' || (decision !== 'grant' && decision !== 'reject' && decision !== 'revoke'))
      throw new Error('요청 형식이 잘못되었습니다.')
    if (!grants().some((g) => g.id === id)) return
    saveGrants(
      grants().map((g) => {
        if (g.id !== id) return g
        const next: PeerGrant = { ...g, managerAt: Date.now() }
        if (decision === 'revoke') delete next.manager
        else next.manager = decision === 'grant' ? 'granted' : 'rejected'
        return next
      })
    )
    changed()
  })
  handle('peer-grant-revoke', (id: unknown) => {
    if (typeof id !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
    revokeGrant(id)
  })
  // ── Leftovers of a linked PC's data on this PC ── ids last seen per link survive restarts.
  const peerSeen = (): Record<string, SeenIds> => {
    try {
      const value: unknown = JSON.parse(store.pref('peer-seen') || '{}')
      return value && typeof value === 'object' ? (value as Record<string, SeenIds>) : {}
    } catch {
      return {}
    }
  }
  const savePeerSeen = (peerId: string, ids: SeenIds | null): void => {
    const all = peerSeen()
    if (!ids || (!ids.workspaceIds.length && !ids.projectIds.length && !ids.questionIds.length)) delete all[peerId]
    else all[peerId] = ids
    store.pref('peer-seen', JSON.stringify(all))
  }
  const purgeBatches = (): PurgeBatch[] => {
    try {
      const value: unknown = JSON.parse(store.pref('purge-pending') || '[]')
      return Array.isArray(value) ? (value as PurgeBatch[]) : []
    } catch {
      return []
    }
  }
  /** Forgets remote ids a linked PC no longer shows: memory, habit marks and evidence, renderer storage. */
  const purge = (ids: SeenIds): void => {
    const { workspaceIds, projectIds, questionIds } = ids
    if (!workspaceIds.length && !projectIds.length && !questionIds.length) return
    const projects = new Set(projectIds),
      questions = new Set(questionIds)
    for (const p of projects) recentQuestions.delete(p)
    for (const [key, entry] of composerFiles) if (projects.has(entry.projectId)) composerFiles.delete(key)
    if (projects.has(lastProjectId)) lastProjectId = ''
    for (const [turnId, sent] of forwarded)
      if (questions.has(sent.questionId)) {
        forwarded.delete(turnId)
        runner.revoke(sent.ticket)
      }
    for (const q of questions) {
      const pending = peerExtract.get(q)
      if (pending) clearTimeout(pending.timer)
      peerExtract.delete(q)
    }
    for (const [client, q] of [...focused]) if (questions.has(q)) focused.delete(client)
    habitDetector.forget(questionIds)
    store.clearHabitMarks(questionIds)
    for (const h of store.list<Habit>('habit')) {
      const sources = h.sources.filter((s) => !questions.has(s.questionId))
      if (sources.length !== h.sources.length) store.put('habit', store.active, { ...h, sources })
    }
    store.pref(
      'purge-pending',
      JSON.stringify([...purgeBatches(), { id: randomUUID(), projectIds, workspaceIds }])
    )
    changed()
  }
  /** A link that is gone: its remote ids are purged and its compute and forwarding state dropped. */
  const forgetPeer = (peerId: string): void => {
    purge(removedIds(peerSeen()[peerId] ?? seenIds(null), seenIds(null)))
    savePeerSeen(peerId, null)
    router.forget(peerId)
    runner.dropPeer(peerId)
  }
  // Read without clearing; a renderer acknowledges each batch after deleting, so a crash retries it.
  handle('purge-pending', () => purgeBatches())
  handle('purge-ack', (id: unknown) => {
    if (typeof id !== 'string') return
    store.pref('purge-pending', JSON.stringify(purgeBatches().filter((b) => b.id !== id)))
  })
  // ── Links to other PCs (this PC as client) ──
  const links = (): PeerLink[] => {
    const value: unknown = JSON.parse(readSecret('peer:links') || '[]')
    return Array.isArray(value) ? (value as PeerLink[]) : []
  }
  handle('peer-pair', async (target: unknown, code: unknown) => {
    if (typeof code !== 'string' || !target || typeof target !== 'object' || !('kind' in target))
      throw new Error('요청 형식이 잘못되었습니다.')
    let link: PeerLink
    if (target.kind === 'direct') {
      const address = 'address' in target && typeof target.address === 'string' ? target.address.trim() : ''
      if (!isTailscaleTarget(address)) throw new Error(TAILSCALE_ADDRESS_ERROR)
      link = await pairWithHost({ kind: 'direct', address }, code, hostname())
    } else if (target.kind === 'relay') {
      const url = normalizeRelayUrl(relayUrl())
      if (!url) throw new Error('중계 서버 주소를 입력하세요.')
      link = await pairWithHost({ kind: 'relay', url }, code, hostname())
    } else throw new Error('요청 형식이 잘못되었습니다.')
    const stale = links().filter((l) => l.fingerprint === link.fingerprint || l.id === link.id)
    for (const old of stale) {
      peers.get(old.id)?.close()
      peers.delete(old.id)
      forgetPeer(old.id)
    }
    writeSecret('peer:links', JSON.stringify([...links().filter((l) => !stale.includes(l)), link]))
    connectPeer(link)
    rebuildPeers()
    changed()
  })
  handle('peer-links', () =>
    links().map((l) => ({
      id: l.id,
      name: l.name,
      paths: [...(l.addresses.length ? ['tailscale' as const] : []), ...(l.relay ? ['relay' as const] : [])],
      status: peers.get(l.id)?.status ?? 'offline'
    }))
  )
  handle('peer-unlink', async (id: unknown) => {
    if (typeof id !== 'string') throw new Error('요청 형식이 잘못되었습니다.')
    const conn = peers.get(id)
    await conn?.rpc('peer-leave', []).catch(() => {})
    conn?.close()
    peers.delete(id)
    forgetPeer(id)
    writeSecret('peer:links', JSON.stringify(links().filter((l) => l.id !== id)))
    rebuildPeers()
    changed()
  })
  try {
    for (const link of links()) connectPeer(link)
  } catch (e) {
    console.warn('linked PCs unavailable:', e)
  }
  if (store.pref('hub:enabled') === '1') void hubTask(startHub)
  // With a PIN the scans wait for the first unlock (they need the keys).
  if (!lock.hasPin) startScans()
  return {
    capture,
    quickQuestion,
    initializeShortcut: () => {
      registerQuestionShortcut(quickQuestion)
    },
    close: () => {
      clearTimeout(backfillTimer)
      powerMonitor.off('lock-screen', onLockScreen)
      powerMonitor.off('suspend', onLockScreen)
      extractor.close()
      updater.close()
      habitDetector.close()
      runner.abortAll()
      broker.close()
      for (const pending of peerExtract.values()) clearTimeout(pending.timer)
      peerExtract.clear()
      void display.close()
      for (const item of controllers.values()) item.controller.abort()
      for (const conn of peers.values()) conn.close()
      peers.clear()
      pairStop()
      hubRelay.stop()
      void hub.stop()
      store.close()
    }
  }
}

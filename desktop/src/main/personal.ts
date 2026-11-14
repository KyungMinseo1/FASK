import { app, BrowserWindow, dialog, ipcMain, safeStorage, type WebContents } from 'electron'
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
import { checkPeerCall, checkPeerManager, RemoteRouter, UNSUPPORTED } from './personal-routing'
import { isTailscaleTarget, pairRelayKey, TAILSCALE_ADDRESS_ERROR, type PairPayload } from '../shared/pair-code'
import { PersonalStore } from './personal-store'
import { DisplayImages } from './image-display'
import { PersonalCapture } from './personal-capture'
import { validateBackup } from './personal-backup'
import { KnowledgeExtractor, recallMemory } from './knowledge-extract'
import { decideHabit, habitFile, importHabitFile, listHabits, recallHabits, saveHabit } from './habits'
import { prompt } from './prompts'
import { buildExport, EXPORT_TOO_LARGE, EXPORT_TRANSFER_MAX } from './knowledge-export'
import { questionShortcutInfo, registerQuestionShortcut } from './personal-shortcuts'
import { localModels, normalizeEndpoint, streamChat, type WireMessage } from './local-api'
import { cleanTitle, questionImages, recommend, routedModel } from '../shared/questions'
import { exportFileName, exportOptions } from '../shared/export'
import { i18n, t } from '../shared/i18n'
import type {
  AskInput,
  AskResult,
  CaptureSetupRequired,
  Concept,
  ExportOptions,
  HubAddress,
  HubStatus,
  Habit,
  HabitInput,
  LocalSettings,
  Profile,
  Project,
  Question,
  Snapshot,
  StreamEvent,
  TidyStatus,
  Turn,
  TurnState,
  Workspace
} from '../preload/personal'

// Build-time default relay (release builds set MAIN_VITE_FASK_RELAY_URL); Settings can override it.
const DEFAULT_RELAY_URL = normalizeRelayUrl(import.meta.env.MAIN_VITE_FASK_RELAY_URL ?? '') ?? ''
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
  // The phone works on the active profile only and never sees other PC-local details.
  const mobileSnapshot = (s: Snapshot): Snapshot => ({
    ...s,
    profiles: s.profiles.filter((p) => p.id === s.activeProfileId),
    recentQuestions: {},
    settings: { ...s.settings, endpoint: '', hasKey: false, regions: [], displayId: undefined },
    storageBytes: 0
  })
  const hubInvoke = async (caller: HubCaller, name: string, args: unknown[]): Promise<unknown> => {
    if (caller.kind === 'peer') {
      // Local data only: a peer never sees or reaches this PC's own linked PCs.
      if (name === 'snapshot') return mobileSnapshot(localSnapshot())
      if (name === 'peer-leave') {
        revokeGrant(caller.id)
        return null
      }
      checkPeerCall((kind, id) => store.record(kind, id), name, args)
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
      const handler = handlers.get(name)
      if (!handler) throw new Error(UNSUPPORTED)
      return handler(...args)
    }
    if (name === 'peer-leave') throw new Error(UNSUPPORTED)
    if (['create', 'rename', 'remove'].includes(name) && args[0] === 'profile')
      throw new Error('모바일에서는 프로필을 변경할 수 없습니다.')
    // Parentless creation (workspace) skips the profile-scope check, so only concepts are allowed.
    if (name === 'create' && args[0] !== 'concept')
      throw new Error('모바일에서는 개념만 만들 수 있습니다.')
    if (!handlers.has(name)) throw new Error(UNSUPPORTED)
    if (name === 'snapshot') return mobileSnapshot(mergedSnapshot())
    if (name === 'focus-question') return focusQuestion('mobile', args[0])
    return router.route(name, args)
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
    hub.broadcast('stream', event, remote ? 'remote' : 'local')
  }
  // ── Linked PCs (this PC as client) ── host data stays in memory, never on disk.
  const peers = new Map<string, PeerConnection>()
  const localHas = (id: string): boolean => !!store.db.prepare('SELECT 1 FROM records WHERE id=?').get(id)
  const router = new RemoteRouter(
    () => peers.values(),
    localHas,
    (name, args) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(UNSUPPORTED)
      return handler(...args)
    },
    (projectId, questionId) => {
      recentQuestions.set(projectId, questionId)
      changed(true)
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
  }
  const connectPeer = (link: PeerLink): void => {
    peers.get(link.id)?.close()
    const conn = new PeerConnection(
      link,
      () => {
        rebuildPeers()
        changed(true)
      },
      (event) => {
        router.noteStream(link.id, event)
        emit(event, true)
      }
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
  const key = (profile = store.active): string => {
    const encrypted = store.pref(`key:${profile}`)
    if (!encrypted) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 키 저장소를 사용할 수 없습니다.')
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }
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
  const handle = (name: string, fn: Handler): void => {
    handlers.set(name, fn)
    ipcMain.handle(`personal:${name}`, (event, ...args) => {
      requireLocalWindow(event)
      if (name === 'focus-question') return focusQuestion(`window:${event.sender.id}`, args[0])
      return router.route(name, args)
    })
  }
  const textCall = async (
    instruction: string,
    raw: string,
    image?: string,
    signal = AbortSignal.timeout(90000),
    profile = store.active,
    model?: string
  ): Promise<string> => {
    const settings = store.settings(profile)
    let result = ''
    await streamChat(
      settings.endpoint,
      key(profile),
      model ?? (settings.fastModel || settings.model),
      [
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
      ],
      signal,
      {},
      (t) => {
        result += t
      }
    )
    if (!result.trim()) throw new Error('모델이 빈 답변을 반환했습니다.')
    return result.trim()
  }
  const extractor = new KnowledgeExtractor(
    store,
    (profile, model, instruction, input, signal) =>
      textCall(instruction, input, undefined, signal, profile, model),
    changed
  )
  const localSnapshot = (): Snapshot => ({
    ...store.snapshot(),
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
  handle('switch-profile', (id: string) => {
    if (controllers.size || capture.overlay || capture.editor)
      throw new Error('진행 중인 요청과 오버레이를 닫은 뒤 프로필을 바꿔 주세요.')
    store.switchProfile(id)
    changed()
  })
  handle('save-settings', (settings: LocalSettings, newKey?: string) => {
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
      answerHabits: !!settings.answerHabits
    }
    if (
      !['manual', 'recommend', 'auto'].includes(clean.routing) ||
      !['minimal', 'balanced', 'preserve'].includes(clean.retention) ||
      !['off', 'project', 'workspace'].includes(clean.memoryScope) ||
      !(clean.memoryTokens >= 100 && clean.memoryTokens <= 20000) ||
      !(clean.extractDelaySec >= 0 && clean.extractDelaySec <= 3600) ||
      !['ko', 'en'].includes(clean.promptLanguage)
    )
      throw new Error('설정 값이 잘못되었습니다.')
    if (newKey !== undefined) {
      if (newKey && !safeStorage.isEncryptionAvailable())
        throw new Error('OS 키 저장소를 사용할 수 없습니다.')
      store.pref(
        `key:${store.active}`,
        newKey ? safeStorage.encryptString(newKey).toString('base64') : ''
      )
    }
    store.saveSettings(clean)
    changed()
  })
  handle('models', (endpoint: string, newKey?: string) =>
    localModels(endpoint, newKey === undefined ? key() : newKey)
  )
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
  handle('cancel', (id: string) => {
    const item = controllers.get(id) ?? [...controllers.values()].find((v) => v.turnId === id)
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
  const generateTitle = async (
    questionId: string,
    turn: Turn,
    image: string | undefined,
    profile: string
  ): Promise<void> => {
    try {
      const lang = store.settings(profile).promptLanguage
      let text = prompt(lang, 'title-question', { question: turn.sent })
      if (turn.documents.length)
        text += `\n\n${prompt(lang, 'title-attachments', {
          files: turn.documents
            .map((d) => prompt(lang, 'title-file', { name: d.name, text: d.text.slice(0, 2000) }))
            .join('\n\n')
            .slice(0, 6000)
        })}`
      const title = cleanTitle(
        await textCall(prompt(lang, 'title'), text, image, AbortSignal.timeout(30000), profile)
      )
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
  handle('ask', async (input: AskInput): Promise<AskResult> => {
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(input.requestId))
      throw new Error('요청 ID가 잘못되었습니다.')
    if (input.profileId !== store.active)
      throw new Error('프로필이 변경되었습니다. 다시 열어 주세요.')
    const project = store.record<Project>('project', input.projectId)
    if (!input.raw.trim() && !input.image && !input.documents?.length)
      throw new Error('질문이나 첨부를 추가해 주세요.')
    if (input.raw.length > 50000) throw new Error('질문은 50,000자 이내로 입력해 주세요.')
    const documents = input.documents ?? []
    if (
      !Array.isArray(documents) ||
      documents.length > 5 ||
      documents.some(
        (d) =>
          !d ||
          typeof d.name !== 'string' ||
          typeof d.text !== 'string' ||
          d.name.length > 255 ||
          d.text.length > 50000
      ) ||
      documents.reduce((sum, d) => sum + d.text.length, 0) > 100000
    )
      throw new Error('텍스트 첨부는 최대 5개, 전체 100,000자까지 지원합니다.')
    if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 200))
      throw new Error('모델 이름이 잘못되었습니다.')
    const effort = input.reasoningEffort
    if (effort !== undefined && !['low', 'medium', 'high'].includes(effort))
      throw new Error('추론 강도가 잘못되었습니다.')
    const profile = store.active,
      settings = store.settings(profile),
      routing = recommend(input.raw, !!input.image)
    const model =
      settings.routing === 'auto' ? routedModel(settings, routing.complexity) : input.model || settings.model
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
          effort ?? ''
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
      revision: 0
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
    if (!input.questionId && settings.autoTitle)
      void generateTitle(questionId, turn, input.image, profile)
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
            : input.useMemory === true && settings.memoryScope === 'off'
              ? 'project'
              : settings.memoryScope
        // Text clues: the current question, its text files, and recent questions of a follow-up.
        // An image without refined text (refine already reads the image) adds search keywords
        // from the fast model; failure only loses the clue.
        const lang = settings.promptLanguage
        const imageClue =
          scope !== 'off' && input.image && !input.refined
            ? await textCall(
                prompt(lang, 'search-keywords'),
                input.raw || prompt(lang, 'search-keywords-fallback'),
                input.image,
                AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
                profile
              ).catch(() => '')
            : ''
        const clues = [
          input.refined || input.raw,
          imageClue.slice(0, 200),
          ...documents.map((d) => d.text.slice(0, 1000)),
          ...history.slice(-2).map((t) => t.refined || t.raw)
        ].join('\n')
        const memory =
          scope === 'off'
            ? { context: [], references: [] }
            : recallMemory(store, {
                profile,
                scope,
                projectId: project.id,
                workspaceId: project.workspaceId,
                questionId,
                text: clues,
                budgetChars: settings.memoryTokens * 3
              })
        if (memory.references.length)
          store.updateTurn(questionId, turnId, { references: memory.references }, profile)
        // Habits of this PC's active profile; a linked PC's workspace is answered there, with its habits.
        const habits = settings.answerHabits
          ? recallHabits(store, { profile, workspaceId: project.workspaceId, text: clues })
          : []
        const messages: WireMessage[] = [
          {
            role: 'system',
            content:
              prompt(lang, 'answer', { project: project.name }) +
              (memory.context.length
                ? `\n\n${prompt(lang, 'answer-memory', { context: JSON.stringify(memory.context) })}`
                : '') +
              (habits.length
                ? `\n\n${prompt(lang, 'answer-habits', {
                    habits: habits.map((h) => `- ${h.rule}${h.when ? ` [${h.when}]` : ''}`).join('\n')
                  })}`
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
        await streamChat(
          settings.endpoint,
          key(profile),
          model,
          messages,
          controller.signal,
          { reasoningEffort: effort },
          (delta, actualModel) => {
            state.answer += delta
            state.revision += 1
            if (actualModel) state.actualModel = actualModel
            emit({ requestId: input.requestId, questionId, turnId, revision: state.revision, delta })
            if (Date.now() - lastSave > 400) {
              store.updateTurn(
                questionId,
                turnId,
                { answer: state.answer, actualModel: state.actualModel, revision: state.revision },
                profile
              )
              lastSave = Date.now()
            }
          }
        )
        if (!state.answer.trim()) throw new Error('모델이 빈 답변을 반환했습니다.')
        state.status = 'completed'
      } catch (e) {
        state.status = controller.signal.aborted ? 'cancelled' : 'failed'
        state.error = e instanceof Error ? e.message : '요청이 실패했습니다.'
      } finally {
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
      if (state.status === 'completed') extractor.completed(profile, questionId)
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
  })
  handle('displays', () => capture.displays())
  handle('open-editor', (id: number) => capture.edit(id))
  handle('ui-language', async (lang: unknown) => {
    if (lang !== 'ko' && lang !== 'en') throw new Error('요청 형식이 잘못되었습니다.')
    await i18n.changeLanguage(lang)
  })
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
      title: t('현재 프로필 백업 (이미지 포함, 접속 키 제외)'),
      defaultPath: 'fask-backup.json',
      filters: [{ name: 'FASK backup', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const snapshot = store.snapshot()
    snapshot.profiles = snapshot.profiles.filter((p) => p.id === snapshot.activeProfileId)
    const images = Object.fromEntries(
      [...new Set(snapshot.questions.flatMap(questionImages))].map((id) => [id, store.image(id)])
    )
    writeFileSync(
      result.filePath,
      JSON.stringify({
        version: 3,
        snapshot: { ...snapshot, settings: { ...snapshot.settings, hasKey: false } },
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
      title: t('새 프로필로 복원'),
      properties: ['openFile'],
      filters: [{ name: 'FASK backup', extensions: ['json'] }]
    })
    if (result.canceled) return false
    const backup = validateBackup(JSON.parse(readFileSync(result.filePaths[0], 'utf8')))
    // Validate all references before mutation; restore under fresh IDs in a new profile.
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
    const previous = store.active
    store.db.exec('BEGIN')
    try {
      const profile = store.create('profile', `복원 ${new Date().toLocaleDateString('ko-KR')}`)
      store.pref('active', profile)
      for (const w of snapshot.workspaces)
        store.put('workspace', profile, { ...w, id: mapped(w.id), profileId: profile })
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
          workspaceId: h.workspaceId ? mapped(h.workspaceId) : null,
          replaces: h.replaces ? (habitIds.get(h.replaces) ?? null) : null,
          sources: h.sources.flatMap((s) => {
            const questionId = ids.get(s.questionId)
            return questionId ? [{ questionId, turnIds: turnMapped(s.turnIds) }] : []
          })
        })
      store.saveSettings({
        ...store.settings(),
        ...snapshot.settings,
        endpoint: normalizeEndpoint(snapshot.settings.endpoint),
        hasKey: false
      })
      store.db.exec('COMMIT')
      changed()
      return true
    } catch (e) {
      store.db.exec('ROLLBACK')
      store.pref('active', previous)
      throw e
    }
  })
  // ── Answer habits ── per profile, local to this PC; the phone may list and decide them.
  handle('habits', () => listHabits(store, store.active))
  handle('habit-decide', (id: string, decision: unknown) => {
    if (decision !== 'active' && decision !== 'rejected') throw new Error('요청 형식이 잘못되었습니다.')
    decideHabit(store, store.active, String(id), decision)
    changed()
  })
  handle('habit-save', (input: HabitInput) => {
    const id = saveHabit(store, store.active, input)
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
      grantCache = Array.isArray(value) ? (value as PeerGrant[]) : []
    }
    return grantCache
  }
  const saveGrants = (list: PeerGrant[]): void => {
    writeSecret('hub:peers', JSON.stringify(list))
    grantCache = list
  }
  const hubAuth = (bearer: string): HubCaller | null => {
    const hash = sha256(bearer)
    if (mobileTokenHash && timingSafeEqual(hash, mobileTokenHash)) return { kind: 'mobile' }
    for (const grant of grants())
      if (timingSafeEqual(hash, Buffer.from(grant.tokenHash, 'hex'))) return { kind: 'peer', id: grant.id }
    return null
  }
  const revokeGrant = (id: string): void => {
    saveGrants(grants().filter((g) => g.id !== id))
    hub.disconnect(id)
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
      createdAt: Date.now()
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
    grants().map(({ id, name, createdAt, manager, managerAt }) => ({
      id,
      name,
      createdAt,
      manager: manager ?? 'none',
      managerAt: managerAt ?? null
    }))
  )
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
  extractor.scan(store.list<Profile>('profile', '*').map((p) => p.id))
  return {
    capture,
    quickQuestion,
    initializeShortcut: () => {
      registerQuestionShortcut(quickQuestion)
    },
    close: () => {
      clearTimeout(backfillTimer)
      extractor.close()
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

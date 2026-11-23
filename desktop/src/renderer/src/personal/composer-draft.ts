import type { ComposerFiles, TextAttachment } from '../../../preload/personal'
import { noFiles, sameFiles } from '../../../shared/composer-files'

/** `persist`: text in localStorage, files in main-process memory (desktop). `memory`: both in this page's memory (mobile). `none`: nothing kept. */
export type DraftMode = 'persist' | 'memory' | 'none'
/** What a composer showed when it sent: its own text and attachments, never the screen capture. */
export interface DraftContent {
  raw: string
  image: string
  documents: TextAttachment[]
}
/** A change made elsewhere (another window or another composer of this page); `files: null` is none. */
export type DraftChange = { raw: string } | { files: ComposerFiles | null }
type Listener = (change: DraftChange) => void
export interface ComposerDraft {
  /** Saved question text; null when none is saved. */
  raw(): string | null
  setRaw(raw: string): void
  /** Saved files when known without waiting; undefined in persist mode, where refresh() delivers them. */
  filesNow(): ComposerFiles | null | undefined
  setFiles(files: ComposerFiles): void
  /** Re-reads the saved files and hands them to subscribers unless something newer is already known. */
  refresh(): void
  /** A send was accepted: forgets the saved text and files that still equal what was sent. */
  clearIfSent(sent: DraftContent): void
  /** A sent turn failed: puts the sent text and files back where nothing was saved since. */
  restoreIfEmpty(sent: DraftContent): void
  subscribe(listener: Listener): () => void
}

const filesOf = (sent: DraftContent): ComposerFiles => ({ image: sent.image, documents: sent.documents })

// ── persist ── one channel per draft for the whole page, so a remounted composer shares the
// queue and revision of the one before it. Main-process IPC order is never relied on: each
// channel sends one request at a time, and windows order each other's changes by revision.
type Op =
  | { kind: 'write'; files: ComposerFiles | null; expect?: ComposerFiles | null }
  | { kind: 'read'; at: number }
interface Channel {
  profileId: string
  projectId: string
  /** `fask:draft:${profileId}:${projectId}`, the existing localStorage key. */
  textKey: string
  /** Newest revision this page has seen, applied or not. */
  known: number
  /** Writes enqueued so far; a read enqueued before the latest write is stale. */
  writes: number
  /** Writes queued or in flight. */
  pendingWrites: number
  /** An update was skipped during a write, or a write did not apply. */
  missed: boolean
  queue: Op[]
  /** One op is in flight. */
  busy: boolean
  listeners: Set<Listener>
  /** storage + IPC handlers, installed while listeners exist. */
  detach: (() => void) | null
}
const channels = new Map<string, Channel>()
let active = 0
const idle: (() => void)[] = []

const emit = (ch: Channel, change: DraftChange): void => {
  for (const listener of [...ch.listeners]) listener(change)
}

function pump(ch: Channel): void {
  if (ch.busy) return
  const op = ch.queue.shift()
  if (!op) return
  ch.busy = true
  const finish = (): void => {
    ch.busy = false
    active--
    if (active === 0) for (const resolve of idle.splice(0)) resolve()
    pump(ch)
  }
  if (op.kind === 'write') {
    const wrote = (applied: boolean, revision: number): void => {
      if (applied) ch.known = Math.max(ch.known, revision)
      else ch.missed = true
      ch.pendingWrites--
      if (ch.pendingWrites === 0 && ch.missed) {
        ch.missed = false
        enqueueRead(ch)
      }
      finish()
    }
    const call =
      op.expect === undefined
        ? window.fask.setComposerFiles(ch.profileId, ch.projectId, op.files)
        : window.fask.setComposerFiles(ch.profileId, ch.projectId, op.files, op.expect)
    call.then(
      (r) => wrote(r.applied, r.revision),
      () => wrote(false, 0)
    )
    return
  }
  window.fask.composerFiles(ch.profileId, ch.projectId).then(
    (s) => {
      if (op.at === ch.writes && s.revision >= ch.known) {
        ch.known = s.revision
        // Equal revisions are delivered too: a composer that ignored them while sending catches up.
        emit(ch, { files: s.files })
      }
      finish()
    },
    () => finish()
  )
}

function enqueueWrite(ch: Channel, files: ComposerFiles | null, expect?: ComposerFiles | null): void {
  ch.writes++
  const last = ch.queue[ch.queue.length - 1]
  if (expect === undefined && last?.kind === 'write' && last.expect === undefined) {
    // Not sent yet: only the newest unconditional value matters.
    last.files = files
    return
  }
  ch.queue.push(expect === undefined ? { kind: 'write', files } : { kind: 'write', files, expect })
  ch.pendingWrites++
  active++
  pump(ch)
}

function enqueueRead(ch: Channel): void {
  ch.queue.push({ kind: 'read', at: ch.writes })
  active++
  pump(ch)
}

function channel(profileId: string, projectId: string): Channel {
  const key = `${profileId}:${projectId}`
  let ch = channels.get(key)
  if (!ch) {
    ch = {
      profileId,
      projectId,
      textKey: `fask:draft:${profileId}:${projectId}`,
      known: 0,
      writes: 0,
      pendingWrites: 0,
      missed: false,
      queue: [],
      busy: false,
      listeners: new Set(),
      detach: null
    }
    channels.set(key, ch)
  }
  return ch
}

function persistentDraft(profileId: string, projectId: string): ComposerDraft {
  const ch = channel(profileId, projectId)
  return {
    raw: () => localStorage.getItem(ch.textKey),
    setRaw: (raw) => localStorage.setItem(ch.textKey, raw),
    filesNow: () => undefined,
    setFiles: (files) => enqueueWrite(ch, noFiles(files) ? null : files),
    refresh: () => enqueueRead(ch),
    clearIfSent: (sent) => {
      if (localStorage.getItem(ch.textKey) === sent.raw) localStorage.removeItem(ch.textKey)
      const files = filesOf(sent)
      if (!noFiles(files)) enqueueWrite(ch, null, files)
    },
    restoreIfEmpty: (sent) => {
      if (sent.raw && localStorage.getItem(ch.textKey) === null) localStorage.setItem(ch.textKey, sent.raw)
      const files = filesOf(sent)
      if (!noFiles(files)) enqueueWrite(ch, files, null)
    },
    subscribe: (listener) => {
      ch.listeners.add(listener)
      if (!ch.detach) {
        const onStorage = (e: StorageEvent): void => {
          // The event's value may be older than the store; always read the current one.
          if (e.key === ch.textKey) emit(ch, { raw: localStorage.getItem(ch.textKey) ?? '' })
        }
        window.addEventListener('storage', onStorage)
        const offFiles = window.fask.onComposerFiles((p, proj, s) => {
          if (p !== ch.profileId || proj !== ch.projectId) return
          if (ch.pendingWrites > 0) {
            // Our own write decides the order; read the result once it is answered.
            ch.missed = true
            return
          }
          if (s.revision <= ch.known) return
          ch.known = s.revision
          emit(ch, { files: s.files })
        })
        ch.detach = () => {
          window.removeEventListener('storage', onStorage)
          offFiles()
        }
      }
      return () => {
        ch.listeners.delete(listener)
        if (!ch.listeners.size && ch.detach) {
          ch.detach()
          ch.detach = null
        }
      }
    }
  }
}

// ── memory ── this page only; a handle created before clearMemoryDrafts() never writes again.
const entries = new Map<string, { raw: string | null; files: ComposerFiles | null }>()
const watchers = new Map<string, Set<Listener>>()
let generation = 0

function memoryDraft(profileId: string, projectId: string): ComposerDraft {
  const key = `${profileId}:${projectId}`
  const born = generation
  let mine: Listener | null = null
  const live = (): boolean => born === generation
  const get = (): { raw: string | null; files: ComposerFiles | null } =>
    entries.get(key) ?? { raw: null, files: null }
  const put = (next: { raw: string | null; files: ComposerFiles | null }): void => {
    if (next.raw === null && next.files === null) entries.delete(key)
    else entries.set(key, next)
  }
  const tell = (change: DraftChange): void => {
    for (const listener of [...(watchers.get(key) ?? [])]) if (listener !== mine) listener(change)
  }
  return {
    raw: () => get().raw,
    setRaw: (raw) => {
      if (!live()) return
      put({ ...get(), raw })
      tell({ raw })
    },
    filesNow: () => get().files,
    setFiles: (value) => {
      if (!live()) return
      const files = noFiles(value) ? null : value
      put({ ...get(), files })
      tell({ files })
    },
    refresh: () => mine?.({ files: get().files }),
    clearIfSent: (sent) => {
      if (!live()) return
      const saved = get()
      if (saved.raw !== null && saved.raw === sent.raw) {
        put({ ...get(), raw: null })
        tell({ raw: '' })
      }
      const files = filesOf(sent)
      if (!noFiles(files) && sameFiles(saved.files, files)) {
        put({ ...get(), files: null })
        tell({ files: null })
      }
    },
    restoreIfEmpty: (sent) => {
      if (!live()) return
      if (sent.raw && get().raw === null) {
        put({ ...get(), raw: sent.raw })
        tell({ raw: sent.raw })
      }
      const files = filesOf(sent)
      if (!noFiles(files) && get().files === null) {
        put({ ...get(), files })
        tell({ files })
      }
    },
    subscribe: (listener) => {
      mine = listener
      let set = watchers.get(key)
      if (!set) watchers.set(key, (set = new Set()))
      set.add(listener)
      return () => {
        if (mine === listener) mine = null
        const current = watchers.get(key)
        current?.delete(listener)
        if (current && !current.size) watchers.delete(key)
      }
    }
  }
}

const noDraft: ComposerDraft = {
  raw: () => null,
  setRaw: () => {},
  filesNow: () => null,
  setFiles: () => {},
  refresh: () => {},
  clearIfSent: () => {},
  restoreIfEmpty: () => {},
  subscribe: () => () => {}
}

export function composerDraft(mode: DraftMode, profileId: string, projectId: string): ComposerDraft {
  if (mode === 'persist') return persistentDraft(profileId, projectId)
  if (mode === 'memory') return memoryDraft(profileId, projectId)
  return noDraft
}

/** Forgets every in-memory draft; handles created before the call stop writing (mobile unpair, tests). */
export function clearMemoryDrafts(): void {
  entries.clear()
  generation++
}

/** Resolves once every persist-mode file request of this page has been answered; await before closing the window. */
export function whenDraftsSaved(): Promise<void> {
  return active === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve))
}

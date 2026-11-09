import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from './api'
import { Icon } from './ToolbarIcons'
import TidyDialog from './TidyDialog'
import { errorText } from './common'
import { useT } from '../../../shared/i18n/react'
import type { PeerGrantInfo, TidyAccess, TidyEstimate, TidyStatus } from '../../../preload/personal'

/** What a tidy or manager request asks the notification center to follow. No-ops without a provider. */
export interface Notifications {
  /** Follows a tidy job until it is ready, failed, applied or lost. */
  watchTidy(workspaceId: string, jobId: string, name: string): void
  /** Follows a knowledge-manager request on a linked PC's workspace until it is answered. */
  watchManager(workspaceId: string, name: string): void
}
const NotificationsContext = createContext<Notifications>({ watchTidy: () => {}, watchManager: () => {} })
export function useNotifications(): Notifications {
  return useContext(NotificationsContext)
}

/** One popover entry: a Korean source text with its values, translated when rendered. */
export interface NotifyItem {
  id: string
  text: string
  vars: Record<string, unknown>
  actions: { label: string; primary?: boolean; run: () => void }[]
}
interface Center {
  items: NotifyItem[]
  seen: ReadonlySet<string>
  markSeen(ids: string[]): void
  /** The bell's window is the one that polls; overlay windows only record watches. */
  attach(): () => void
}
const CenterContext = createContext<Center | null>(null)

interface Watches {
  tidy: Record<string, { jobId: string; name: string }>
  manager: Record<string, { name: string; last: TidyAccess }>
}
const WATCH_KEY = 'fask:notify-watch'
const SEEN_KEY = 'fask:notify-seen'
const SEEN_MAX = 200

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const access = (v: unknown): v is TidyAccess =>
  v === 'owner' || v === 'none' || v === 'pending' || v === 'granted' || v === 'rejected'
/** Storage is the source of truth, read fresh each time: every window of this app shares it. */
function readWatches(): Watches {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(WATCH_KEY) ?? '{}')
    if (
      record(raw) &&
      record(raw.tidy) &&
      record(raw.manager) &&
      Object.entries(raw.tidy).every(
        ([ws, value]) => text(ws) && record(value) && text(value.jobId) && text(value.name)
      ) &&
      Object.entries(raw.manager).every(
        ([ws, value]) => text(ws) && record(value) && text(value.name) && access(value.last)
      )
    ) return raw as unknown as Watches
  } catch {
    // Malformed: start empty.
  }
  return { tidy: {}, manager: {} }
}
function updateWatches(fn: (w: Watches) => void): void {
  const w = readWatches()
  fn(w)
  localStorage.setItem(WATCH_KEY, JSON.stringify(w))
}
function readSeen(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')
    if (Array.isArray(raw)) return [...new Set(raw.filter((id): id is string => typeof id === 'string'))].slice(-SEEN_MAX)
  } catch {
    // Malformed: start empty.
  }
  return []
}

/**
 * Desktop notification center: follows tidy jobs and knowledge-manager requests this device
 * started (persisted in localStorage, so a job that finished while the app was closed still
 * notifies), and lists linked PCs asking to become knowledge managers of this PC's workspaces.
 * Re-polls on mount and on every `onChanged`; `열기` shows a ready tidy in its own dialog.
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const api = useApi()
  const [attached, setAttached] = useState(0)
  // Items derived from watches; they outlive the watch (lost, answered) until dismissed.
  const [watched, setWatched] = useState<Map<string, NotifyItem>>(new Map())
  const [requests, setRequests] = useState<NotifyItem[]>([])
  const [seen, setSeen] = useState<Set<string>>(() => new Set(readSeen()))
  const [open, setOpen] = useState<{ workspaceId: string; name: string } | null>(null)
  const pollRef = useRef<() => void>(() => {})
  const watchVersion = useRef(0)

  const markSeen = useCallback((ids: string[]): void => {
    if (!ids.length) return
    const merged = [...new Set([...readSeen().filter((id) => !ids.includes(id)), ...ids])].slice(-SEEN_MAX)
    localStorage.setItem(SEEN_KEY, JSON.stringify(merged))
    setSeen(new Set(merged))
  }, [])
  const drop = useCallback(
    (id: string): void => {
      setWatched((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      markSeen([id])
    },
    [markSeen]
  )

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === SEEN_KEY || event.key === null) setSeen(new Set(readSeen()))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (!attached) return
    let live = true
    let running = false
    let again = false
    const put = (item: NotifyItem): void =>
      setWatched((m) => (m.has(item.id) ? m : new Map(m).set(item.id, item)))
    const remove = (id: string): void =>
      setWatched((m) => {
        if (!m.has(id)) return m
        const next = new Map(m)
        next.delete(id)
        return next
      })
    const pollTidy = async (ws: string, jobId: string, name: string, version: number): Promise<void> => {
      let status: TidyStatus
      try {
        status = await api.tidyStatus(ws)
      } catch {
        return // Offline: keep the watch.
      }
      if (!live || version !== watchVersion.current) return
      const current = readWatches().tidy[ws]
      if (current?.jobId !== jobId || current.name !== name) return
      const job = status.job
      if (job?.id === jobId && job.state === 'running') return
      if (job?.id === jobId && job.state === 'ready') {
        remove(`tidy-failed:${jobId}`)
        put({
          id: `tidy-ready:${jobId}`,
          text: '{{name}} 정리안이 준비되었습니다. 확인이 필요합니다.',
          vars: { name },
          actions: [{ label: '열기', primary: true, run: () => setOpen({ workspaceId: ws, name }) }]
        })
        return
      }
      if (job?.id === jobId && job.state === 'failed') {
        remove(`tidy-ready:${jobId}`)
        const id = `tidy-failed:${jobId}`
        put({
          id,
          text: '{{name}} 정리안을 만들지 못했습니다: {{error}}',
          vars: { name, error: job.error },
          actions: [
            {
              label: '닫기',
              run: () => {
                updateWatches((w) => {
                  if (w.tidy[ws]?.jobId === jobId) delete w.tidy[ws]
                })
                drop(id)
                remove(`tidy-ready:${jobId}`)
                void api.tidyClear(ws, jobId).catch(() => {})
              }
            }
          ]
        })
        return
      }
      updateWatches((w) => {
        if (w.tidy[ws]?.jobId === jobId) delete w.tidy[ws]
      })
      remove(`tidy-ready:${jobId}`)
      remove(`tidy-failed:${jobId}`)
      if (!job && status.lastApplied === jobId) return // Applied here or on another device.
      const id = `tidy-lost:${jobId}`
      put({
        id,
        text: '{{name}} 정리안 작업이 중단되었습니다. 호스트 PC가 다시 시작되었을 수 있습니다. 다시 시도해 주세요.',
        vars: { name },
        actions: [{ label: '닫기', run: () => drop(id) }]
      })
    }
    const pollManager = async (ws: string, name: string, last: TidyAccess, version: number): Promise<void> => {
      let access: TidyAccess
      try {
        access = (await api.tidyStatus(ws)).access
      } catch {
        return
      }
      if (!live || version !== watchVersion.current) return
      const current = readWatches().manager[ws]
      if (current?.name !== name || current.last !== last) return
      const answered = last === 'pending' && (access === 'granted' || access === 'rejected')
      if (!answered) {
        if (access !== last) updateWatches((w) => {
          w.manager[ws] = { name, last: access }
        })
        return
      }
      updateWatches((w) => {
        delete w.manager[ws]
      })
      const id = `manager:${ws}:${access}`
      put({
        id,
        text:
          access === 'granted'
            ? '{{name}} 워크스페이스의 지식 관리자 요청이 수락되었습니다.'
            : '{{name}} 워크스페이스의 지식 관리자 요청이 거절되었습니다.',
        vars: { name },
        actions: [{ label: '닫기', run: () => drop(id) }]
      })
    }
    const pollRequests = async (): Promise<void> => {
      if (typeof window.fask?.peerGrants !== 'function') return
      let grants: PeerGrantInfo[]
      try {
        grants = await window.fask.peerGrants()
      } catch {
        return
      }
      if (!live) return
      const decide = (id: string, decision: 'grant' | 'reject') => (): void =>
        void window.fask
          .peerGrantManager(id, decision)
          .catch(() => {})
          .then(() => pollRef.current())
      setRequests(
        grants
          .filter((g) => g.manager === 'pending')
          .map((g) => ({
            id: `request:${g.id}:${g.managerAt ?? 0}`,
            text: '{{name}} PC가 지식 관리자 등록을 요청했습니다.',
            vars: { name: g.name },
            actions: [
              { label: '수락', primary: true, run: decide(g.id, 'grant') },
              { label: '거절', run: decide(g.id, 'reject') }
            ]
          }))
      )
    }
    const poll = async (): Promise<void> => {
      if (!live) return
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const w = readWatches()
          const version = watchVersion.current
          const tidyIds = new Set(Object.values(w.tidy).flatMap(({ jobId }) => [
            `tidy-ready:${jobId}`, `tidy-failed:${jobId}`
          ]))
          setWatched((items) => {
            const stale = [...items.keys()].filter((id) =>
              (id.startsWith('tidy-ready:') || id.startsWith('tidy-failed:')) && !tidyIds.has(id)
            )
            if (!stale.length) return items
            const next = new Map(items)
            for (const id of stale) next.delete(id)
            return next
          })
          await Promise.all([
            ...Object.entries(w.tidy).map(([ws, v]) => pollTidy(ws, v.jobId, v.name, version)),
            ...Object.entries(w.manager).map(([ws, v]) => pollManager(ws, v.name, v.last, version)),
            pollRequests()
          ])
        } while (again && live)
      } finally {
        running = false
      }
    }
    pollRef.current = () => void poll()
    void poll()
    const off = api.onChanged(() => {
      watchVersion.current++
      void poll()
    })
    // Another window (overlay) recorded a watch.
    const onStorage = (e: StorageEvent): void => {
      if (e.key === WATCH_KEY || e.key === null) {
        watchVersion.current++
        void poll()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      live = false
      pollRef.current = () => {}
      off()
      window.removeEventListener('storage', onStorage)
    }
  }, [api, attached, drop])

  const notifications = useMemo<Notifications>(
    () => ({
      watchTidy: (ws, jobId, name) => {
        watchVersion.current++
        updateWatches((w) => {
          w.tidy[ws] = { jobId, name }
        })
        pollRef.current()
      },
      watchManager: (ws, name) => {
        watchVersion.current++
        updateWatches((w) => {
          w.manager[ws] = { name, last: 'pending' }
        })
        pollRef.current()
      }
    }),
    []
  )
  const attach = useCallback((): (() => void) => {
    setAttached((n) => n + 1)
    return () => setAttached((n) => n - 1)
  }, [])
  const items = useMemo(() => [...requests, ...watched.values()], [requests, watched])
  const center = useMemo<Center>(() => ({ items, seen, markSeen, attach }), [items, seen, markSeen, attach])

  return (
    <NotificationsContext.Provider value={notifications}>
      <CenterContext.Provider value={center}>
        {children}
        {open && <WatchedTidy key={open.workspaceId} {...open} onClose={() => setOpen(null)} />}
      </CenterContext.Provider>
    </NotificationsContext.Provider>
  )
}

/** The tidy dialog for a workspace opened from a notification; loads and refreshes its own data. */
function WatchedTidy({
  workspaceId,
  name,
  onClose
}: {
  workspaceId: string
  name: string
  onClose: () => void
}): React.JSX.Element {
  const api = useApi()
  const t = useT()
  const [data, setData] = useState<{ estimate: TidyEstimate; status: TidyStatus } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useRef<() => void>(() => {})
  useEffect(() => {
    let live = true
    let latest = 0
    const load = (): void => {
      const request = ++latest
      setError(null)
      Promise.all([api.tidyPlan(workspaceId), api.tidyStatus(workspaceId)]).then(
        ([estimate, status]) => {
          if (live && request === latest) setData({ estimate, status })
        },
        (failure: unknown) => {
          if (!live || request !== latest) return
          setData(null)
          setError(errorText(failure))
        }
      )
    }
    reload.current = load
    load()
    const off = api.onChanged(load)
    return () => {
      live = false
      reload.current = () => {}
      off()
    }
  }, [api, workspaceId])
  useEffect(() => {
    if (data) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, onClose])
  if (!data) return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="create-modal tidy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watched-tidy-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header><h2 id="watched-tidy-title">{t('개념 정리 검토')}</h2></header>
        <div className="tidy-body" aria-busy={error === null}>
          {error !== null
            ? <p className="error" role="alert">{error}</p>
            : <p role="status">{t('확인 중…')}</p>}
        </div>
        <footer>
          {error !== null && <button type="button" onClick={() => reload.current()}>{t('다시 시도')}</button>}
          <button type="button" autoFocus onClick={onClose}>{t('닫기')}</button>
        </footer>
      </section>
    </div>,
    document.body
  )
  return (
    <TidyDialog
      workspaceId={workspaceId}
      workspaceName={name}
      estimate={data.estimate}
      status={data.status}
      onClose={onClose}
      onApplied={() => {}}
    />
  )
}

/** Sidebar bell: unseen items make it blink three times, then stay accent-colored until opened. */
export function NotificationBell(): React.JSX.Element | null {
  const t = useT()
  const center = useContext(CenterContext)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const attach = center?.attach
  useEffect(() => attach?.(), [attach])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  // Items arriving while the popover is open count as seen.
  const items = center?.items
  const markSeen = center?.markSeen
  const seen = center?.seen
  useEffect(() => {
    if (open && items && markSeen && seen) {
      const fresh = items.filter((i) => !seen.has(i.id)).map((i) => i.id)
      if (fresh.length) markSeen(fresh)
    }
  }, [open, items, seen, markSeen])
  if (!center) return null
  const unseen = center.items.some((i) => !center.seen.has(i.id))
  return (
    <div className="notify-wrap" ref={ref}>
      <button
        className={`sidebar-notify${unseen ? ' attention' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {t('알림')}
        {center.items.length > 0 && <small>{center.items.length}</small>}
      </button>
      {open && (
        <div className="notify-popover" role="dialog" aria-label={t('알림')}>
          {center.items.length ? (
            <ul>
              {center.items.map((item) => (
                <li key={item.id}>
                  <p>{t(item.text, item.vars)}</p>
                  <span>
                    {item.actions.map((a) => (
                      <button
                        key={a.label}
                        className={a.primary ? 'primary' : ''}
                        onClick={() => {
                          if (a.label === '열기') setOpen(false)
                          a.run()
                        }}
                      >
                        {t(a.label)}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notify-empty">{t('새 알림이 없습니다.')}</p>
          )}
        </div>
      )}
    </div>
  )
}

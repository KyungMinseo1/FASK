import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from './api'
import { Icon, type IconName } from './ToolbarIcons'
import TidyDialog from './TidyDialog'
import { dateLabel, errorText } from './common'
import { useT } from '../../../shared/i18n/react'
import type { Habit, HabitList, PeerGrantInfo, TidyAccess, TidyEstimate, TidyStatus } from '../../../preload/personal'

/** What a tidy or manager request asks the notification center to follow. No-ops without a provider. */
export interface Notifications {
  /** Follows a tidy job until it is ready, failed, applied or lost. */
  watchTidy(workspaceId: string, jobId: string, name: string): void
  /** Follows a knowledge-manager request on a linked PC's workspace until it is answered. */
  watchManager(workspaceId: string, name: string): void
  /** Adds a finished action (accepted, applied, dismissed…) to this device's notification history. */
  record(entry: Omit<NotifyRecord, 'id' | 'at'>): void
}
const NotificationsContext = createContext<Notifications>({
  watchTidy: () => {},
  watchManager: () => {},
  record: () => {}
})
export function useNotifications(): Notifications {
  return useContext(NotificationsContext)
}

/** One popover entry: a Korean source text with its values, translated when rendered. */
export interface NotifyItem {
  id: string
  icon: IconName
  text: string
  vars: Record<string, unknown>
  actions: { label: string; primary?: boolean; run: () => void | Promise<void> }[]
}
/** A handled notification, newest first in history; `outcome` and `parts` labels are Korean source text. */
export interface NotifyRecord {
  id: string
  icon: IconName
  text: string
  vars: Record<string, unknown>
  outcome: string
  /** ISO time it was handled. */
  at: string
  parts?: { label: string; n: number }[]
}
interface Center {
  items: NotifyItem[]
  seen: ReadonlySet<string>
  markSeen(ids: string[]): void
  /** The bell's window is the one that polls; overlay windows only record watches. */
  attach(): () => void
  history: NotifyRecord[]
  clearHistory(): void
}
const CenterContext = createContext<Center | null>(null)

interface Watches {
  tidy: Record<string, { jobId: string; name: string }>
  manager: Record<string, { name: string; last: TidyAccess }>
}
const WATCH_KEY = 'fask:notify-watch'
const SEEN_KEY = 'fask:notify-seen'
const SEEN_MAX = 200
const HISTORY_KEY = 'fask:notify-history'
const HISTORY_MAX = 100

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const access = (v: unknown): v is TidyAccess =>
  v === 'owner' || v === 'none' || v === 'pending' || v === 'granted' || v === 'rejected'
/** Storage is the source of truth, read fresh each time: every window of this app shares it. */
function readWatches(): Watches {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(WATCH_KEY) ?? '{}')
    if (
      isObject(raw) &&
      isObject(raw.tidy) &&
      isObject(raw.manager) &&
      Object.entries(raw.tidy).every(
        ([ws, value]) => text(ws) && isObject(value) && text(value.jobId) && text(value.name)
      ) &&
      Object.entries(raw.manager).every(
        ([ws, value]) => text(ws) && isObject(value) && text(value.name) && access(value.last)
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
function readHistory(): NotifyRecord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (Array.isArray(raw))
      return raw.filter(
        (r): r is NotifyRecord =>
          isObject(r) &&
          typeof r.id === 'string' &&
          typeof r.icon === 'string' &&
          typeof r.text === 'string' &&
          typeof r.outcome === 'string' &&
          typeof r.at === 'string' &&
          isObject(r.vars)
      )
  } catch {
    // Malformed: start empty.
  }
  return []
}
function pushHistory(entry: NotifyRecord): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...readHistory()].slice(0, HISTORY_MAX)))
}

/**
 * Notification center: follows tidy jobs and knowledge-manager requests this device started
 * (persisted in localStorage, so a job that finished while the app was closed still notifies),
 * and lists linked PCs asking to become knowledge managers of this PC's workspaces. Handled items
 * leave the list and are kept in a per-device history. Re-polls on mount and on every
 * `onChanged`; `열기` shows a ready tidy in its own dialog (a bottom sheet with `sheet`).
 */
export function NotificationsProvider({
  children,
  sheet = false
}: {
  children: React.ReactNode
  sheet?: boolean
}): React.JSX.Element {
  const api = useApi()
  const [attached, setAttached] = useState(0)
  // Items derived from watches; they outlive the watch (lost, answered) until dismissed.
  const [watched, setWatched] = useState<Map<string, NotifyItem>>(new Map())
  const [requests, setRequests] = useState<NotifyItem[]>([])
  const [habitItems, setHabitItems] = useState<NotifyItem[]>([])
  const [seen, setSeen] = useState<Set<string>>(() => new Set(readSeen()))
  const [history, setHistory] = useState<NotifyRecord[]>(readHistory)
  const [open, setOpen] = useState<{ workspaceId: string; name: string } | null>(null)
  const pollRef = useRef<() => void>(() => {})
  const watchVersion = useRef(0)

  const markSeen = useCallback((ids: string[]): void => {
    if (!ids.length) return
    const merged = [...new Set([...readSeen().filter((id) => !ids.includes(id)), ...ids])].slice(-SEEN_MAX)
    localStorage.setItem(SEEN_KEY, JSON.stringify(merged))
    setSeen(new Set(merged))
  }, [])
  const record = useCallback((entry: Omit<NotifyRecord, 'id' | 'at'>): void => {
    pushHistory({
      ...entry,
      id: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString()
    })
    setHistory(readHistory())
  }, [])
  const clearHistory = useCallback((): void => {
    localStorage.removeItem(HISTORY_KEY)
    setHistory([])
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
  /** Records a handled item in history and removes it from the list. */
  const settle = useCallback(
    (item: Pick<NotifyItem, 'id' | 'icon' | 'text' | 'vars'>, outcome: string): void => {
      record({ icon: item.icon, text: item.text, vars: item.vars, outcome })
      drop(item.id)
    },
    [record, drop]
  )

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === SEEN_KEY || event.key === null) setSeen(new Set(readSeen()))
      if (event.key === HISTORY_KEY || event.key === null) setHistory(readHistory())
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
        const proposal = job.proposal
        if (proposal && !proposal.changes.length) {
          // Nothing to review: one tap finishes it, no dialog with an empty list.
          remove(`tidy-ready:${jobId}`)
          const proposalId = proposal.id
          const item: NotifyItem = {
            id: `tidy-empty:${jobId}`,
            icon: 'modelOrganize',
            text: '{{name}} 정리안을 만들었지만 정리할 항목이 없습니다.',
            vars: { name },
            actions: [
              {
                label: '확인',
                primary: true,
                run: () =>
                  api.tidyApply(ws, proposalId, [], []).then(() => {
                    updateWatches((w) => {
                      if (w.tidy[ws]?.jobId === jobId) delete w.tidy[ws]
                    })
                    settle(item, '검토 완료')
                  })
              }
            ]
          }
          put(item)
          return
        }
        remove(`tidy-empty:${jobId}`)
        put({
          id: `tidy-ready:${jobId}`,
          icon: 'modelOrganize',
          text: '{{name}} 정리안이 준비되었습니다. 확인이 필요합니다.',
          vars: { name },
          actions: [{ label: '열기', primary: true, run: () => setOpen({ workspaceId: ws, name }) }]
        })
        return
      }
      if (job?.id === jobId && job.state === 'failed') {
        remove(`tidy-ready:${jobId}`)
        remove(`tidy-empty:${jobId}`)
        const item: NotifyItem = {
          id: `tidy-failed:${jobId}`,
          icon: 'modelOrganize',
          text: '{{name}} 정리안을 만들지 못했습니다: {{error}}',
          vars: { name, error: job.error },
          actions: [
            {
              label: '닫기',
              run: () => {
                updateWatches((w) => {
                  if (w.tidy[ws]?.jobId === jobId) delete w.tidy[ws]
                })
                settle(item, '닫음')
                remove(`tidy-ready:${jobId}`)
                void api.tidyClear(ws, jobId).catch(() => {})
              }
            }
          ]
        }
        put(item)
        return
      }
      updateWatches((w) => {
        if (w.tidy[ws]?.jobId === jobId) delete w.tidy[ws]
      })
      remove(`tidy-ready:${jobId}`)
      remove(`tidy-failed:${jobId}`)
      remove(`tidy-empty:${jobId}`)
      if (!job && status.lastApplied === jobId) return // Applied here or on another device.
      const item: NotifyItem = {
        id: `tidy-lost:${jobId}`,
        icon: 'modelOrganize',
        text: '{{name}} 정리안 작업이 중단되었습니다. 호스트 PC가 다시 시작되었을 수 있습니다. 다시 시도해 주세요.',
        vars: { name },
        actions: [{ label: '닫기', run: () => settle(item, '닫음') }]
      }
      put(item)
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
      const item: NotifyItem = {
        id: `manager:${ws}:${access}`,
        icon: 'key',
        text:
          access === 'granted'
            ? '{{name}} 워크스페이스의 지식 관리자 요청이 수락되었습니다.'
            : '{{name}} 워크스페이스의 지식 관리자 요청이 거절되었습니다.',
        vars: { name },
        actions: [{ label: '닫기', run: () => settle(item, '확인함') }]
      }
      put(item)
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
      // Rejections reach the bell, which shows the failure and keeps the item.
      const decide =
        (text: string, vars: Record<string, unknown>, id: string, decision: 'grant' | 'reject') =>
        (): Promise<void> =>
          window.fask
            .peerGrantManager(id, decision)
            .then(() =>
              record({ icon: 'devices', text, vars, outcome: decision === 'grant' ? '수락함' : '거절함' })
            )
            .finally(() => pollRef.current())
      setRequests(
        grants
          .filter((g) => g.manager === 'pending')
          .map((g) => {
            const text = '{{name}} PC가 지식 관리자 등록을 요청했습니다.'
            const vars = { name: g.name }
            return {
              id: `request:${g.id}:${g.managerAt ?? 0}`,
              icon: 'devices',
              text,
              vars,
              actions: [
                { label: '수락', primary: true, run: decide(text, vars, g.id, 'grant') },
                { label: '거절', run: decide(text, vars, g.id, 'reject') }
              ]
            }
          })
      )
    }
    const pollHabits = async (): Promise<void> => {
      let list: HabitList
      try {
        list = await api.habits()
      } catch {
        return
      }
      if (!live) return
      if (!list.enabled) {
        setHabitItems([])
        return
      }
      // Rejections reach the bell, which shows the failure and keeps the item.
      const decide =
        (text: string, vars: Record<string, unknown>, h: Habit, decision: 'active' | 'rejected', outcome: string) =>
        (): Promise<void> =>
          api
            .decideHabit(h.id, decision)
            .then(() => record({ icon: 'refine', text, vars, outcome }))
            .finally(() => pollRef.current())
      const next: NotifyItem[] = []
      for (const h of list.habits) {
        if (h.status === 'proposed') {
          const text = h.when
            ? '이 답변 방식을 기억할까요? "{{rule}}" ({{when}}, {{n}}번 요청)'
            : '이 답변 방식을 기억할까요? "{{rule}}" ({{n}}번 요청)'
          const vars = { rule: h.rule, when: h.when, n: h.count }
          next.push({
            id: `habit:${h.id}`,
            icon: 'refine',
            text,
            vars,
            actions: [
              { label: '기억', primary: true, run: decide(text, vars, h, 'active', '기억함') },
              { label: '무시', run: decide(text, vars, h, 'rejected', '무시함') }
            ]
          })
        } else if (h.status === 'active' && h.origin === 'explicit' && h.reviewedAt === null) {
          // The model turned it on from an explicit request; confirm or undo.
          const text = '앞으로 이렇게 답합니다: "{{rule}}"'
          const vars = { rule: h.rule }
          next.push({
            id: `habit-on:${h.id}`,
            icon: 'refine',
            text,
            vars,
            actions: [
              { label: '확인', primary: true, run: decide(text, vars, h, 'active', '확인함') },
              { label: '끄기', run: decide(text, vars, h, 'rejected', '끔') }
            ]
          })
        }
      }
      setHabitItems(next)
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
            `tidy-ready:${jobId}`, `tidy-failed:${jobId}`, `tidy-empty:${jobId}`
          ]))
          setWatched((items) => {
            const stale = [...items.keys()].filter((id) =>
              (id.startsWith('tidy-ready:') || id.startsWith('tidy-failed:') || id.startsWith('tidy-empty:')) &&
              !tidyIds.has(id)
            )
            if (!stale.length) return items
            const next = new Map(items)
            for (const id of stale) next.delete(id)
            return next
          })
          await Promise.all([
            ...Object.entries(w.tidy).map(([ws, v]) => pollTidy(ws, v.jobId, v.name, version)),
            ...Object.entries(w.manager).map(([ws, v]) => pollManager(ws, v.name, v.last, version)),
            pollRequests(),
            pollHabits()
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
  }, [api, attached, drop, record, settle])

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
      },
      record
    }),
    [record]
  )
  const attach = useCallback((): (() => void) => {
    setAttached((n) => n + 1)
    return () => setAttached((n) => n - 1)
  }, [])
  const items = useMemo(() => [...requests, ...habitItems, ...watched.values()], [requests, habitItems, watched])
  const center = useMemo<Center>(
    () => ({ items, seen, markSeen, attach, history, clearHistory }),
    [items, seen, markSeen, attach, history, clearHistory]
  )

  return (
    <NotificationsContext.Provider value={notifications}>
      <CenterContext.Provider value={center}>
        {children}
        {open && <WatchedTidy key={open.workspaceId} {...open} sheet={sheet} onClose={() => setOpen(null)} />}
      </CenterContext.Provider>
    </NotificationsContext.Provider>
  )
}

/** The tidy dialog for a workspace opened from a notification; loads and refreshes its own data. */
function WatchedTidy({
  workspaceId,
  name,
  sheet,
  onClose
}: {
  workspaceId: string
  name: string
  sheet: boolean
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
    <div className={`modal-backdrop${sheet ? ' tidy-sheet' : ''}`} onClick={onClose}>
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
      sheet={sheet}
      onClose={onClose}
      onApplied={() => {}}
    />
  )
}

/** How long a handled item fades out before its action runs. */
const LEAVE_MS = 180

/**
 * Notification bell with a popover of new items and this device's history. Unseen items make it
 * blink three times, then stay accent-colored until opened. `compact` is the icon-only button
 * (collapsed sidebar, phone header); on the phone the popover is a bottom sheet.
 */
export function NotificationBell({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const t = useT()
  const center = useContext(CenterContext)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'new' | 'history'>('new')
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const timers = useRef(new Set<number>())
  const items = center?.items
  const itemsRef = useRef<NotifyItem[]>([])
  itemsRef.current = items ?? []
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving
  const attach = center?.attach
  useEffect(() => attach?.(), [attach])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])
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
  // Forget fading ids once their item is gone.
  useEffect(() => {
    if (!items) return
    setLeaving((s) => {
      const ids = new Set(items.map((i) => i.id))
      const next = new Set([...s].filter((id) => ids.has(id)))
      return next.size === s.size ? s : next
    })
  }, [items])
  // Items arriving while the popover is open count as seen.
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
  const count = center.items.length
  const visible = center.items
  const toggle = (): void => {
    if (!open) {
      // Nothing new: go straight to what was handled before.
      setTab(count ? 'new' : 'history')
      setFailed(null)
    }
    setOpen(!open)
  }
  const act = (item: NotifyItem, action: NotifyItem['actions'][number]): void => {
    setFailed(null)
    if (action.label === '열기') {
      setOpen(false)
      void action.run()
      return
    }
    setLeaving((s) => new Set(s).add(item.id))
    const timer = window.setTimeout(() => {
      timers.current.delete(timer)
      Promise.resolve()
        .then(() => action.run())
        .then(
          () => {
            // The last new item was handled: close the popover.
            if (itemsRef.current.every((i) => i.id === item.id || leavingRef.current.has(i.id))) setOpen(false)
          },
          () => {
            setLeaving((s) => {
              const next = new Set(s)
              next.delete(item.id)
              return next
            })
            setFailed(item.id)
          }
        )
    }, LEAVE_MS)
    timers.current.add(timer)
  }

  return (
    <div className={`notify-wrap${compact ? ' compact' : ''}`} ref={ref}>
      {compact ? (
        <button
          type="button"
          className={`notify-bell${unseen ? ' attention' : ''}`}
          aria-label={t('알림')}
          title={t('알림')}
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon name="bell" size={20} />
          {count > 0 && <small>{count}</small>}
        </button>
      ) : (
        <button
          type="button"
          className={`sidebar-notify${unseen ? ' attention' : ''}`}
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon name="bell" />
          {t('알림')}
          {count > 0 && <small>{count}</small>}
        </button>
      )}
      {open && (
        <>
          <div className="notify-scrim" onClick={() => setOpen(false)} />
          <section className="notify-popover" role="dialog" aria-label={t('알림')}>
            <header className="notify-head">
              <h2>{t('알림')}</h2>
              <button
                type="button"
                className="notify-close"
                aria-label={t('닫기')}
                title={t('닫기')}
                onClick={() => setOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="notify-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'new'} onClick={() => setTab('new')}>
                {t('새 알림')}
                {visible.length > 0 && <small>{visible.length}</small>}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
                {t('지난 내역')}
              </button>
            </div>
            {tab === 'new' ? (
              visible.length ? (
                <ul className="notify-list">
                  {visible.map((item) => (
                    <li key={item.id} className={`notify-item${leaving.has(item.id) ? ' leaving' : ''}`}>
                      <span className="notify-icon">
                        <Icon name={item.icon} size={18} />
                      </span>
                      <div className="notify-main">
                        <p>{t(item.text, item.vars)}</p>
                        {failed === item.id && (
                          <p className="notify-error" role="alert">
                            {t('처리하지 못했습니다. 다시 시도해 주세요.')}
                          </p>
                        )}
                        <div className="notify-actions">
                          {item.actions.map((a) => (
                            <button
                              type="button"
                              key={a.label}
                              className={a.primary ? 'primary' : ''}
                              disabled={leaving.has(item.id)}
                              onClick={() => act(item, a)}
                            >
                              {t(a.label)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="notify-empty">{t('새 알림이 없습니다.')}</p>
              )
            ) : center.history.length ? (
              <>
                <ul className="notify-list history">
                  {center.history.map((r) => (
                    <li key={r.id} className="notify-item">
                      <span className="notify-icon">
                        <Icon name={r.icon} size={18} />
                      </span>
                      <div className="notify-main">
                        <p>{t(r.text, r.vars)}</p>
                        {r.parts && r.parts.length > 0 && (
                          <ul className="notify-parts">
                            {r.parts.map((p) => (
                              <li key={p.label}>{t(p.label, { n: p.n })}</li>
                            ))}
                          </ul>
                        )}
                        <div className="notify-meta">
                          <span className="notify-outcome">{t(r.outcome)}</span>
                          <time dateTime={r.at}>{dateLabel(r.at)}</time>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <footer className="notify-foot">
                  <button type="button" onClick={center.clearHistory}>
                    {t('내역 지우기')}
                  </button>
                </footer>
              </>
            ) : (
              <p className="notify-empty">{t('지난 내역이 없습니다.')}</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

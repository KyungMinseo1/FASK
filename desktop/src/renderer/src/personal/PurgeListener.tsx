import { useEffect } from 'react'
import type { PurgeBatch } from '../../../preload/personal'
import { dropWatches } from './notifications'

/**
 * Forgets local traces of linked-PC data this PC can no longer see (drafts, notification watches).
 * Each batch is acknowledged only after its deletions finish, so an interrupted run retries on the
 * next mount or change; the deletions are idempotent.
 */
export default function PurgeListener(): null {
  useEffect(() => {
    let live = true
    let running = false
    let again = false
    const run = async (): Promise<void> => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          let batches: PurgeBatch[]
          try {
            batches = await window.fask.pendingPurges()
          } catch {
            return
          }
          for (const batch of batches) {
            if (!live) return
            try {
              const drafts = Object.keys(localStorage).filter(
                (k) => k.startsWith('fask:draft:') && batch.projectIds.some((p) => k.endsWith(`:${p}`))
              )
              for (const k of drafts) localStorage.removeItem(k)
              dropWatches(batch.workspaceIds)
              await window.fask.ackPurge(batch.id)
            } catch {
              // Left unacknowledged: retried on the next trigger.
            }
          }
        } while (again && live)
      } finally {
        running = false
      }
    }
    void run()
    const off = window.fask.onChanged(() => void run())
    return () => {
      live = false
      off()
    }
  }, [])
  return null
}

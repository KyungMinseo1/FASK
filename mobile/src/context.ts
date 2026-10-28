import { createContext, useContext } from 'react'
import type { Snapshot } from '@desktop/preload/personal'
import type { HubClient, HubConn } from './hub'
import type { Pairing } from './transport'

export type PendingShare = { id: string; raw: string; files: File[] }
export interface MobileState {
  /** One snapshot subscription shared by every screen. */
  data: Snapshot
  refresh: () => Promise<void>
  client: HubClient
  pairing: Pairing
  conn: HubConn
  share: PendingShare | null
  unpair: (message: string) => Promise<void>
}
export const MobileContext = createContext<MobileState | null>(null)
export function useMobile(): MobileState {
  const value = useContext(MobileContext)
  if (!value) throw new Error('MobileContext가 없습니다.')
  return value
}

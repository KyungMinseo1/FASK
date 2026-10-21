import { useCallback, useEffect, useState } from 'react'
import type { Snapshot } from '../../../preload/personal'

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error)
}
export function useSnapshot(): {
  data: Snapshot | null
  refresh: () => Promise<void>
  error: string
} {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      setData(await window.fask.snapshot())
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [])
  useEffect(() => {
    void window.fask
      .snapshot()
      .then(setData)
      .catch((e) => setError(errorText(e)))
    return window.fask.onChanged(() => void refresh())
  }, [refresh])
  return { data, refresh, error }
}
export function dateLabel(value: string): string {
  return new Date(value).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
export const statuses = {
  saved: '저장됨',
  running: '답변 중',
  completed: '답변 완료',
  failed: '요청 실패',
  cancelled: '취소됨'
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../../../preload/personal'
import { useApi } from './api'
import { i18n, t } from '../../../shared/i18n'

export function errorText(error: unknown): string {
  return t(
    error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
      : String(error)
  )
}
export function useSnapshot(): {
  data: Snapshot | null
  refresh: () => Promise<void>
  error: string
} {
  const api = useApi()
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  // A late, older snapshot must not overwrite a newer one.
  const seq = useRef(0)
  const refresh = useCallback(async () => {
    const my = ++seq.current
    try {
      const next = await api.snapshot()
      if (my !== seq.current) return
      setData(next)
      setError('')
    } catch (e) {
      if (my === seq.current) setError(errorText(e))
    }
  }, [api])
  useEffect(() => {
    const my = ++seq.current
    void api
      .snapshot()
      .then((next) => {
        if (my === seq.current) setData(next)
      })
      .catch((e) => {
        if (my === seq.current) setError(errorText(e))
      })
    return api.onChanged(() => void refresh())
  }, [api, refresh])
  return { data, refresh, error }
}
export function dateLabel(value: string): string {
  return new Date(value).toLocaleString(i18n.language === 'en' ? 'en-US' : 'ko-KR', {
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

import { useEffect, useState } from 'react'
import { useApi } from './api'
import { errorText } from './common'
import { useNotifications } from './notifications'
import { Icon } from './ToolbarIcons'
import TidyDialog, { RESULT_PARTS } from './TidyDialog'
import { useT } from '../../../shared/i18n/react'
import type { TidyEstimate, TidyResult, TidyStatus } from '../../../preload/personal'

/**
 * The workspace tidy at a glance: with no job, '정리 제안 n건 · 태그 재판정 질문 r개 · 입력 약 k
 * 토큰' (a local estimate); while the background job runs, its progress; when its proposal is
 * ready, a highlighted '정리안 확인 필요'; when it failed, the reason with retry and dismiss. Each
 * button opens the review dialog. Hidden when there is no candidate, job or apply result.
 * `revision` should change whenever the knowledge data changes; `sheet` shows the dialog as a
 * bottom sheet (phone).
 */
export default function TidyBar({
  workspaceId,
  workspaceName,
  revision,
  disabled = false,
  sheet = false
}: {
  workspaceId: string
  workspaceName: string
  revision: unknown
  disabled?: boolean
  sheet?: boolean
}): React.JSX.Element | null {
  const t = useT()
  const api = useApi()
  const { watchTidy } = useNotifications()
  const [plan, setPlan] = useState<TidyEstimate | null>(null)
  const [status, setStatus] = useState<TidyStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<TidyResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.tidyPlan(workspaceId).then(
      (p) => live && setPlan(p),
      () => live && setPlan(null)
    )
    api.tidyStatus(workspaceId).then(
      (s) => live && setStatus(s),
      () => live && setStatus(null)
    )
    return () => {
      live = false
    }
  }, [api, workspaceId, revision])
  useEffect(() => {
    setOpen(false)
    setResult(null)
    setError('')
  }, [workspaceId])
  const job = status?.job ?? null
  const retry = async (): Promise<void> => {
    setError('')
    try {
      const next = await api.tidyStart(workspaceId)
      watchTidy(workspaceId, next.id, workspaceName)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const pending = !!plan && plan.candidates + plan.retag > 0
  if (!result && !open && !pending && !job) return null
  const applied = result ? RESULT_PARTS.filter(([key]) => result[key] > 0) : []
  const show = (): void => {
    setResult(null)
    setOpen(true)
  }
  return (
    <div className="tidy-bar" role="status">
      {!job && plan && pending && (
        <button disabled={disabled || open} onClick={show}>
          {[
            ...(plan.candidates > 0 ? [t('정리 제안 {{n}}건', { n: plan.candidates })] : []),
            ...(plan.retag > 0 ? [t('태그 재판정 질문 {{n}}개', { n: plan.retag })] : []),
            t('입력 약 {{k}} 토큰', { k: plan.estimatedTokens.toLocaleString() })
          ].join(' · ')}
        </button>
      )}
      {job?.state === 'running' && (
        <button disabled={disabled || open} onClick={show}>
          {t('정리안 만드는 중…')}
          {job.progress.total > 0 && ` ${job.progress.done}/${job.progress.total}`}
        </button>
      )}
      {job?.state === 'ready' && (
        <button className="attention" disabled={disabled || open} onClick={show}>
          {t('정리안 확인 필요')}
        </button>
      )}
      {job?.state === 'failed' && (
        <span>
          {t('정리안을 만들지 못했습니다: {{error}}', { error: error || t(job.error) })}
          <button className="tidy-retry" disabled={disabled} onClick={() => void retry()}>
            {t('다시 시도')}
          </button>
          <button
            aria-label={t('닫기')}
            onClick={() => void api.tidyClear(workspaceId, job.id).catch((e) => setError(errorText(e)))}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      {result && (applied.length > 0 || result.skipped.length > 0) && (
        <span>
          {[
            ...(applied.length
              ? [
                  t('정리 완료: {{parts}}', {
                    parts: applied.map(([key, label]) => t(label, { n: result[key] })).join(' · ')
                  })
                ]
              : []),
            ...(result.skipped.length
              ? [t('{{n}}건은 그래프가 바뀌어 건너뜀', { n: result.skipped.length })]
              : [])
          ].join(' · ')}
          <button aria-label={t('닫기')} onClick={() => setResult(null)}>
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      {open && plan && status && (
        <TidyDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          estimate={plan}
          status={status}
          sheet={sheet}
          onClose={() => setOpen(false)}
          onApplied={setResult}
        />
      )}
    </div>
  )
}

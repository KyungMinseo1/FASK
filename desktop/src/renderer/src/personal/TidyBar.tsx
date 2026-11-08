import { useEffect, useState } from 'react'
import { useApi } from './api'
import { Icon } from './ToolbarIcons'
import TidyDialog from './TidyDialog'
import { useT } from '../../../shared/i18n/react'
import type { TidyResult } from '../../../preload/personal'

/**
 * '정리 제안 n건 · 예상 약 k 토큰': a local estimate of the workspace tidy; the button opens the
 * review dialog, where the one LLM call runs only when the user asks for the proposal.
 * `revision` should change whenever the knowledge data changes; `sheet` shows the dialog as a
 * bottom sheet (phone).
 */
export default function TidyBar({
  workspaceId,
  revision,
  disabled = false,
  sheet = false
}: {
  workspaceId: string
  revision: unknown
  disabled?: boolean
  sheet?: boolean
}): React.JSX.Element | null {
  const t = useT()
  const api = useApi()
  const [plan, setPlan] = useState<{ candidates: number; estimatedTokens: number } | null>(null)
  // The estimate the dialog was opened with; null while closed.
  const [open, setOpen] = useState<{ candidates: number; estimatedTokens: number } | null>(null)
  const [result, setResult] = useState<TidyResult | null>(null)
  useEffect(() => {
    let live = true
    api.tidyPlan(workspaceId).then(
      (p) => live && setPlan(p),
      () => live && setPlan(null)
    )
    return () => {
      live = false
    }
  }, [api, workspaceId, revision])
  useEffect(() => {
    setOpen(null)
    setResult(null)
  }, [workspaceId])
  if (!result && !open && !plan?.candidates) return null
  const applied = result && result.merged + result.parents + result.moved + result.relations > 0
  return (
    <div className="tidy-bar" role="status">
      {plan && plan.candidates > 0 && (
        <button
          disabled={disabled || !!open}
          onClick={() => {
            setResult(null)
            setOpen(plan)
          }}
        >
          {t('정리 제안 {{n}}건 · 예상 약 {{k}} 토큰', {
            n: plan.candidates,
            k: plan.estimatedTokens.toLocaleString()
          })}
        </button>
      )}
      {result && (applied || result.skipped.length > 0) && (
        <span>
          {t('정리 완료: 병합 {{merged}} · 상위 개념 {{parents}} · 이동 {{moved}} · 관계 {{relations}}', {
            ...result
          })}
          {result.skipped.length > 0 &&
            ` · ${t('{{n}}건은 그래프가 바뀌어 건너뜀', { n: result.skipped.length })}`}
          <button aria-label={t('닫기')} onClick={() => setResult(null)}>
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      {open && (
        <TidyDialog
          workspaceId={workspaceId}
          estimate={open}
          sheet={sheet}
          onClose={() => setOpen(null)}
          onApplied={setResult}
        />
      )}
    </div>
  )
}

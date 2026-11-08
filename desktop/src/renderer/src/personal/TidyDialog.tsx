import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from './api'
import { errorText } from './common'
import { LEVEL_LABELS, RELATION_LABELS } from './questionTree'
import { useT } from '../../../shared/i18n/react'
import type { TidyChange, TidyPlacement, TidyProposal, TidyResult } from '../../../preload/personal'

type Kind = TidyChange['kind']
/** Review order and group headings. */
const GROUPS: [Kind, string][] = [
  ['merge', '병합'],
  ['newParent', '새 상위 개념'],
  ['move', '이동'],
  ['level', '단계 변경'],
  ['relation', '관계']
]

/**
 * Tidy review: shows the estimate, runs the one model request on demand, then lists the proposed
 * changes grouped by kind with a checkbox each (all checked). Applying sends the checked indexes;
 * unchecked and untouched candidates are recorded as reviewed by the PC, so an empty proposal is
 * applied right away. `sheet` renders it as a bottom sheet (phone).
 */
export default function TidyDialog({
  workspaceId,
  estimate,
  sheet = false,
  onClose,
  onApplied
}: {
  workspaceId: string
  estimate: { candidates: number; estimatedTokens: number }
  sheet?: boolean
  onClose: () => void
  onApplied: (result: TidyResult) => void
}): React.JSX.Element {
  const t = useT()
  const api = useApi()
  const [step, setStep] = useState<'intro' | 'loading' | 'review' | 'applying' | 'empty'>('intro')
  const [proposal, setProposal] = useState<TidyProposal | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const live = useRef(true)
  // Set on every mount: StrictMode runs mount → cleanup → mount, and the first cleanup must not stick.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const busy = step === 'loading' || step === 'applying'
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && step !== 'applying') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  const preview = async (): Promise<void> => {
    setError('')
    setStep('loading')
    try {
      const next = await api.tidyPreview(workspaceId)
      if (!live.current) return
      setProposal(next)
      setChecked(new Set(next.changes.map((_, i) => i)))
      if (next.changes.length) {
        setStep('review')
        return
      }
      setStep('empty')
      // Nothing proposed: every candidate it covered is recorded as reviewed.
      onApplied(await api.tidyApply(workspaceId, next.id, []))
    } catch (e) {
      if (!live.current) return
      setError(errorText(e))
      setStep((s) => (s === 'loading' ? 'intro' : s))
    }
  }
  const apply = async (): Promise<void> => {
    if (!proposal) return
    setError('')
    setStep('applying')
    try {
      const result = await api.tidyApply(
        workspaceId,
        proposal.id,
        [...checked].sort((a, b) => a - b)
      )
      onApplied(result)
      onClose()
    } catch (e) {
      if (!live.current) return
      setError(errorText(e))
      setStep('review')
    }
  }

  const level = (l: TidyPlacement['levelFrom']): string => t(LEVEL_LABELS[l])
  const placement = (p: TidyPlacement, to: string): string =>
    `${p.concept.name}: ${p.from ? p.from.name : t('상위 없음')} → ${to}` +
    (p.levelFrom === p.levelTo ? '' : ` (${level(p.levelFrom)}→${level(p.levelTo)})`)
  const describe = (c: TidyChange): React.ReactNode => {
    switch (c.kind) {
      case 'merge':
        return t('{{source}} → {{target}}에 합침', { source: c.source.name, target: c.target.name })
      case 'newParent':
        return (
          <>
            <strong>{c.name}</strong> ({level(c.level)}
            {c.parent &&
              ` · ${t(c.parent.id ? '{{name}} 아래' : '새 주제 {{name}} 아래', { name: c.parent.name })}`}
            )
            <ul>
              {c.children.map((p, i) => (
                <li key={i}>{placement(p, c.name)}</li>
              ))}
            </ul>
          </>
        )
      case 'move':
        return placement(c, c.to.name)
      case 'level':
        return `${c.concept.name}: ${level(c.from)} → ${level(c.to)}`
      case 'relation':
        return `${c.from.name} → ${c.to.name} (${t(RELATION_LABELS[c.type])})`
    }
  }
  const toggle = (i: number): void =>
    setChecked((s) => {
      const next = new Set(s)
      if (!next.delete(i)) next.add(i)
      return next
    })
  const changes = proposal?.changes ?? []

  return createPortal(
    <div className={`modal-backdrop${sheet ? ' tidy-sheet' : ''}`} onClick={() => !busy && onClose()}>
      <section
        className="create-modal tidy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tidy-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="tidy-dialog-title">{t('개념 정리 검토')}</h2>
          <span>
            {t('정리 후보 {{n}}건 · 예상 약 {{k}} 토큰', {
              n: estimate.candidates,
              k: estimate.estimatedTokens.toLocaleString()
            })}
          </span>
        </header>
        <div className="tidy-body" aria-busy={busy}>
          {step === 'intro' && (
            <p>
              {t(
                '모델 요청 1회로 정리안을 만듭니다. 무엇이 바뀌는지 먼저 보여 드리고, 고른 항목만 적용합니다.'
              )}
            </p>
          )}
          {step === 'loading' && (
            <p className="tidy-loading" role="status">
              <span className="tidy-spinner" aria-hidden="true" />
              {t('정리안을 만드는 중…')}
            </p>
          )}
          {step === 'empty' && <p role="status">{t('정리할 항목이 없습니다')}</p>}
          {(step === 'review' || step === 'applying') && (
            <>
              <p>{t('선택하지 않은 항목은 해당 개념이 바뀌기 전까지 다시 제안하지 않습니다.')}</p>
              {GROUPS.map(([kind, label]) => {
                const items = changes.flatMap((c, i) => (c.kind === kind ? [{ c, i }] : []))
                if (!items.length) return null
                return (
                  <section key={kind} className="tidy-group">
                    <h3>
                      {t(label)} <span>{items.length}</span>
                    </h3>
                    {items.map(({ c, i }) => (
                      <label key={i} className={`tidy-change${checked.has(i) ? '' : ' off'}`}>
                        <input
                          type="checkbox"
                          checked={checked.has(i)}
                          disabled={busy}
                          onChange={() => toggle(i)}
                        />
                        <span>{describe(c)}</span>
                      </label>
                    ))}
                  </section>
                )
              })}
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
        <footer>
          {(step === 'review' || step === 'applying') && (
            <span className="tidy-select">
              <button
                type="button"
                disabled={busy || checked.size === changes.length}
                onClick={() => setChecked(new Set(changes.map((_, i) => i)))}
              >
                {t('모두 선택')}
              </button>
              <button type="button" disabled={busy || !checked.size} onClick={() => setChecked(new Set())}>
                {t('선택 해제')}
              </button>
            </span>
          )}
          {step === 'empty' ? (
            <button type="button" className="primary" autoFocus onClick={onClose}>
              {t('닫기')}
            </button>
          ) : (
            <>
              <button type="button" disabled={step === 'applying'} onClick={onClose}>
                {t('취소')}
              </button>
              {step === 'intro' || step === 'loading' ? (
                <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void preview()}>
                  {t('정리안 만들기')}
                </button>
              ) : (
                <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
                  {step === 'applying' ? t('적용하는 중…') : t('선택 항목 적용')}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body
  )
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from './api'
import { errorText } from './common'
import { useNotifications } from './notifications'
import { LEVEL_LABELS, RELATION_LABELS } from './questionTree'
import { Icon } from './ToolbarIcons'
import { useT } from '../../../shared/i18n/react'
import type {
  ConceptRole,
  RetagItem,
  TidyCandidate,
  TidyChange,
  TidyEstimate,
  TidyJob,
  TidyPlacement,
  TidyResult,
  TidyStatus
} from '../../../preload/personal'

type Kind = TidyChange['kind']
/** Review order, group headings and the one-line explanation shown under a heading. */
const GROUPS: [Kind, string, string?][] = [
  ['merge', '병합'],
  ['fold', '흡수', '좁은 개념을 넓은 개념에 합칩니다. 이름은 동의어로 남고 질문은 관련 개념으로 연결됩니다.'],
  ['demote', '후보로 되돌림', '개념 트리에서 빼고, 이름은 연결된 질문의 후보로 남깁니다.'],
  ['newParent', '새 상위 개념'],
  ['move', '이동'],
  ['level', '단계 변경'],
  ['rename', '이름 정리', '이전 이름은 동의어로 남습니다.'],
  ['promote', '후보 승격', '여러 질문에서 나온 후보를 개념으로 만들어 그 질문들에 연결합니다.'],
  ['unrelate', '관계 정리', '같은 두 개념 사이에 겹친 관계를 지웁니다.'],
  ['retag', '태그 재판정', '질문마다 태그(질문의 핵심)와 관련 개념(답변이 참고한 것)을 다시 나눕니다.'],
  ['moveQuestion', '질문 이동', '다른 워크스페이스의 개념과 더 맞는 질문을 그쪽 프로젝트로 옮깁니다.']
]
/** Candidate groups of the intro, in the order `plan()` builds them, with their headings. */
const CANDIDATE_GROUPS: [TidyCandidate['kind'], string][] = [
  ['orphan', '상위가 없는 개념'],
  ['misplaced', '단계가 맞지 않는 위치'],
  ['crowded', '하위가 많이 늘어난 주제'],
  ['pair', '이름이 비슷한 쌍'],
  ['weak', '근거가 약한 개념'],
  ['thin', '질문 하나에서만 생긴 주제'],
  ['promotable', '여러 질문의 핵심인 세부'],
  ['recurring', '여러 질문에 나온 후보'],
  ['rename', '이름 정리 대상'],
  ['conflict', '관계가 겹친 쌍'],
  ['question', '태그를 다시 볼 질문']
]
const ROLE_LABELS: Record<ConceptRole, string> = { focus: '태그', support: '관련' }
/** Notice shown instead of starting when this PC may not tidy the workspace. */
const ACCESS_NOTICES: Partial<Record<TidyStatus['access'], string>> = {
  none: '이 PC는 이 워크스페이스의 지식 관리자가 아니라 정리할 수 없습니다.',
  pending: '지식 관리자 요청을 보냈습니다. 상대 PC에서 수락하면 정리할 수 있습니다.',
  rejected: '지식 관리자 요청이 거절되었습니다.'
}

/** Initially checked: everything except changes that ask for confirmation. */
const preset = (changes: TidyChange[], from = 0): number[] =>
  changes.flatMap((c, i) => (c.kind === 'retag' && c.confirm ? [] : [from + i]))

/**
 * Tidy review, driven by the workspace's background job (`status.job`, which the parent refreshes
 * on every change): no job or a failed one shows the intro (the local candidates and the estimate;
 * starting is refused up front when this PC is not the owner or a granted knowledge manager), a
 * running job shows its progress and may be left (a notification follows it), and a ready one lists
 * the proposed changes grouped by kind. Checked changes are applied; unchecked ones are skipped this
 * time and offered again; trashed ones are kept as they are and not offered again. Closing an empty
 * proposal records its candidates as reviewed. `sheet` renders it as a bottom sheet (phone).
 */
export default function TidyDialog({
  workspaceId,
  workspaceName,
  estimate,
  status,
  sheet = false,
  onClose,
  onApplied
}: {
  workspaceId: string
  workspaceName: string
  estimate: TidyEstimate
  status: TidyStatus
  sheet?: boolean
  onClose: () => void
  onApplied: (result: TidyResult) => void
}): React.JSX.Element {
  const t = useT()
  const api = useApi()
  const { watchTidy, watchManager } = useNotifications()
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  // The job tidyStart returned, shown until the parent passes a newer status.
  const [started, setStarted] = useState<{ job: TidyJob; base: TidyStatus } | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const live = useRef(true)
  // Set on every mount: StrictMode runs mount → cleanup → mount, and the first cleanup must not stick.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const job = started && started.base === status ? started.job : status.job
  const proposal = job?.state === 'ready' ? job.proposal : null
  const changes = proposal?.changes ?? []
  const view: 'intro' | 'progress' | 'review' | 'empty' =
    !job || job.state === 'failed' ? 'intro' : job.state === 'running' ? 'progress' : changes.length ? 'review' : 'empty'

  // Checks start from `preset` once per proposal, and extend over indexes appended later.
  const shown = useRef<{ id: string; length: number } | null>(null)
  useEffect(() => {
    if (!proposal) return
    const prev = shown.current
    if (prev?.id !== proposal.id) {
      shown.current = { id: proposal.id, length: proposal.changes.length }
      setChecked(new Set(preset(proposal.changes)))
      setDismissed(new Set())
    } else if (proposal.changes.length > prev.length) {
      const from = prev.length
      prev.length = proposal.changes.length
      setChecked((s) => new Set([...s, ...preset(proposal.changes.slice(from), from)]))
    }
  }, [proposal])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applying, onClose])

  const start = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const next = await api.tidyStart(workspaceId)
      watchTidy(workspaceId, next.id, workspaceName)
      if (live.current) setStarted({ job: next, base: status })
    } catch (e) {
      if (live.current) setError(errorText(e))
    } finally {
      if (live.current) setBusy(false)
    }
  }
  const requestManager = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      await api.tidyManagerRequest(workspaceId)
      watchManager(workspaceId, workspaceName)
    } catch (e) {
      if (live.current) setError(errorText(e))
    } finally {
      if (live.current) setBusy(false)
    }
  }
  const apply = async (accepted: Set<number>, skip: Set<number>): Promise<void> => {
    if (!proposal) return
    setError('')
    setApplying(true)
    try {
      const result = await api.tidyApply(
        workspaceId,
        proposal.id,
        [...accepted].sort((a, b) => a - b),
        [...skip].sort((a, b) => a - b)
      )
      onApplied(result)
      onClose()
    } catch (e) {
      // An expired proposal (`만료`) or any other failure: keep the dialog open with the reason.
      if (!live.current) return
      setError(errorText(e))
      setApplying(false)
    }
  }

  const level = (l: TidyPlacement['levelFrom']): string => t(LEVEL_LABELS[l])
  const placement = (p: TidyPlacement, to: string): string =>
    `${p.concept.name}: ${p.from ? p.from.name : t('상위 없음')} → ${to}` +
    (p.levelFrom === p.levelTo ? '' : ` (${level(p.levelFrom)}→${level(p.levelTo)})`)
  const under = (parent: { id: string | null; name: string } | null): string =>
    parent ? ` · ${t(parent.id ? '{{name}} 아래' : '새 주제 {{name}} 아래', { name: parent.name })}` : ''
  const verdict = (item: RetagItem): string => {
    switch (item.verdict) {
      case 'focus':
      case 'support':
        return t(ROLE_LABELS[item.verdict])
      case 'fold':
        return t('{{name}}에 흡수', { name: item.target?.name ?? '?' })
      case 'replace':
        return item.target
          ? t(item.target.id ? '{{name}}(으)로 교체' : '후보 {{name}}(으)로 교체', { name: item.target.name })
          : t('교체')
      case 'remove':
        return t('연결 제거')
    }
  }
  const describe = (c: TidyChange): React.ReactNode => {
    switch (c.kind) {
      case 'merge':
        return t('{{source}} → {{target}}에 합침', { source: c.source.name, target: c.target.name })
      case 'fold':
        return t('{{source}} → {{target}}에 흡수', { source: c.source.name, target: c.target.name })
      case 'demote':
        return c.concept.name
      case 'newParent':
        return (
          <>
            <strong>{c.name}</strong> ({level(c.level)}
            {under(c.parent)})
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
      case 'rename':
        return `${c.concept.name} → ${c.to}`
      case 'promote':
        return (
          <>
            <strong>{c.name}</strong> ({level(c.level)}
            {under(c.parent)})
            <ul>
              {c.questions.map((q) => (
                <li key={q.id}>{q.title}</li>
              ))}
            </ul>
          </>
        )
      case 'unrelate':
        return `${c.from.name} → ${c.to.name} (${t(RELATION_LABELS[c.type])})`
      case 'retag':
        return (
          <>
            <strong>{c.question.title}</strong>
            {c.confirm && <span className="tidy-confirm">{t('확인 요청')}</span>}
            <ul>
              {c.items.map((item, i) => (
                <li key={i}>
                  {item.concept.name}: {item.from ? t(ROLE_LABELS[item.from]) : t('역할 없음')} → {verdict(item)}
                  {item.suspect && <small>{t('대화에 이름이 없음')}</small>}
                </li>
              ))}
            </ul>
          </>
        )
      case 'moveQuestion':
        return `${c.question.title} → ${c.to.workspaceName} · ${c.to.projectName}`
    }
  }
  const candidate = (c: TidyCandidate): string => {
    switch (c.kind) {
      case 'pair':
      case 'conflict':
        return `${c.a.name} ↔ ${c.b.name}`
      case 'recurring':
        return t('{{name}} (질문 {{n}}개)', { name: c.name, n: c.questions })
      case 'question':
        return c.question.title
      default:
        return c.concept.name
    }
  }
  const toggle = (i: number): void =>
    setChecked((s) => {
      const next = new Set(s)
      if (!next.delete(i)) next.add(i)
      return next
    })
  // Trash: keep as it is and stop offering it; pressing again restores it, unchecked.
  const toggleDismiss = (i: number): void => {
    setChecked((s) => {
      const next = new Set(s)
      next.delete(i)
      return next
    })
    setDismissed((s) => {
      const next = new Set(s)
      if (!next.delete(i)) next.add(i)
      return next
    })
  }
  const selectable = changes.length - dismissed.size
  const canTidy = status.access === 'owner' || status.access === 'granted'
  const notice = ACCESS_NOTICES[status.access]
  const estimateText = [
    t('정리 후보 {{n}}건', { n: estimate.candidates }),
    ...(estimate.retag > 0 ? [t('태그 재판정 질문 {{n}}개', { n: estimate.retag })] : []),
    t('입력 약 {{k}} 토큰 (출력 제외)', { k: estimate.estimatedTokens.toLocaleString() })
  ].join(' · ')
  const shownError = error || job?.error || ''

  return createPortal(
    <div className={`modal-backdrop${sheet ? ' tidy-sheet' : ''}`} onClick={() => !applying && onClose()}>
      <section
        className="create-modal tidy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tidy-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="tidy-dialog-title">{t('개념 정리 검토')}</h2>
          <span>{estimateText}</span>
        </header>
        <div className="tidy-body" aria-busy={busy || applying || view === 'progress'}>
          {view === 'intro' && (
            <>
              <p>
                {t(
                  '이 후보들을 모델에 보내 정리안을 만듭니다. 무엇이 바뀌는지 먼저 보여 드리고, 고른 항목만 적용합니다.'
                )}
              </p>
              {CANDIDATE_GROUPS.map(([kind, label]) => {
                const items = estimate.items.filter((c) => c.kind === kind)
                if (!items.length) return null
                return (
                  <details key={kind} className="tidy-candidates">
                    <summary>
                      {t(label)} <span>{items.length}</span>
                    </summary>
                    <ul>
                      {items.map((c, i) => (
                        <li key={i}>{candidate(c)}</li>
                      ))}
                    </ul>
                  </details>
                )
              })}
              {estimate.retag > 0 && (
                <p>
                  {t('이어서 질문 {{n}}개의 태그를 하나씩 다시 판정합니다. 질문마다 모델 요청이 1회 더 듭니다.', {
                    n: estimate.retag
                  })}
                </p>
              )}
              {notice && (
                <p className="tidy-access" role="status">
                  {t(notice)}
                  {status.access !== 'pending' && (
                    <button type="button" disabled={busy} onClick={() => void requestManager()}>
                      {t('지식 관리자 등록 요청')}
                    </button>
                  )}
                </p>
              )}
            </>
          )}
          {view === 'progress' && job && (
            <>
              <p className="tidy-progress" role="status">
                <span className="tidy-spinner" aria-hidden="true" />
                {job.progress.total > 0
                  ? t('태그 재판정 {{n}}/{{m}}', { n: job.progress.done, m: job.progress.total })
                  : t('정리안을 만드는 중…')}
              </p>
              <p>{t('창을 닫아도 계속 진행되며, 끝나면 알림으로 알려 드립니다.')}</p>
            </>
          )}
          {view === 'empty' && <p role="status">{t('정리할 항목이 없습니다')}</p>}
          {view === 'review' && (
            <>
              <p>
                {t(
                  '체크한 항목은 적용하고, 체크하지 않은 항목은 이번에만 건너뜁니다(다음 정리에 다시 나옵니다). 휴지통을 누른 항목은 지금 상태로 두고 다시 제안하지 않습니다.'
                )}
              </p>
              {changes.some((c) => c.kind === 'retag' && c.confirm) && (
                <p>{t('확인 요청 항목은 직접 연결했을 수 있는 태그를 바꿉니다. 확인한 뒤 선택하세요.')}</p>
              )}
              {GROUPS.map(([kind, label, hint]) => {
                const items = changes.flatMap((c, i) => (c.kind === kind ? [{ c, i }] : []))
                if (!items.length) return null
                return (
                  <section key={kind} className="tidy-group">
                    <h3>
                      {t(label)} <span>{items.length}</span>
                    </h3>
                    {hint && <p>{t(hint)}</p>}
                    {items.map(({ c, i }) => (
                      <label
                        key={i}
                        className={`tidy-change${dismissed.has(i) ? ' dismissed' : checked.has(i) ? '' : ' off'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(i)}
                          disabled={applying || dismissed.has(i)}
                          onChange={() => toggle(i)}
                        />
                        <span>{describe(c)}</span>
                        {dismissed.has(i) && <small className="tidy-dismissed-tag">{t('다시 제안 안 함')}</small>}
                        {c.kind !== 'retag' && (
                          <button
                            type="button"
                            className="tidy-dismiss"
                            aria-label={t('이 상태로 두기')}
                            title={t('이 상태로 두기')}
                            aria-pressed={dismissed.has(i)}
                            disabled={applying}
                            onClick={(e) => {
                              // Inside the label: keep the click from toggling the checkbox.
                              e.preventDefault()
                              toggleDismiss(i)
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        )}
                      </label>
                    ))}
                  </section>
                )
              })}
            </>
          )}
          {shownError && <p className="error">{t(shownError)}</p>}
        </div>
        <footer>
          {view === 'review' && (
            <span className="tidy-select">
              <button
                type="button"
                disabled={applying || checked.size === selectable}
                onClick={() => setChecked(new Set(changes.flatMap((_, i) => (dismissed.has(i) ? [] : [i]))))}
              >
                {t('모두 선택')}
              </button>
              <button type="button" disabled={applying || !checked.size} onClick={() => setChecked(new Set())}>
                {t('선택 해제')}
              </button>
            </span>
          )}
          {view === 'progress' && (
            <button type="button" className="primary" autoFocus onClick={onClose}>
              {t('닫기')}
            </button>
          )}
          {view === 'empty' && (
            <button
              type="button"
              className="primary"
              autoFocus
              disabled={applying}
              onClick={() => void apply(new Set(), new Set())}
            >
              {t('닫기')}
            </button>
          )}
          {view === 'intro' && (
            <>
              <button type="button" onClick={onClose}>
                {t('취소')}
              </button>
              <button
                type="button"
                className="primary"
                autoFocus
                disabled={busy || !canTidy}
                onClick={() => void start()}
              >
                {t('정리안 만들기')}
              </button>
            </>
          )}
          {view === 'review' && (
            <>
              <button type="button" disabled={applying} onClick={onClose}>
                {t('취소')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={applying}
                onClick={() => void apply(checked, dismissed)}
              >
                {applying ? t('적용하는 중…') : t('선택 항목 적용')}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body
  )
}

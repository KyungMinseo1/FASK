import type { Project, Workspace } from '../../../preload/personal'
import { useT } from '../../../shared/i18n/react'

/** Projects grouped by workspace; shared by the desktop overlay and the Android panel. */
export default function ProjectPicker({
  workspaces,
  projects,
  currentId,
  disabledReason,
  onSelect
}: {
  workspaces: Workspace[]
  projects: Project[]
  currentId: string
  /** 설정되면 모든 항목을 비활성화하고 이 문구를 맨 위에 표시한다. */
  disabledReason?: string
  onSelect: (projectId: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="project-picker" role="listbox" aria-label={t('프로젝트 선택')}>
      {disabledReason && <small className="project-picker-note">{disabledReason}</small>}
      {projects.length === 0 && (
        <small className="project-picker-note">{t('프로젝트가 없습니다.')}</small>
      )}
      {workspaces.map((w) => {
        const list = projects.filter((p) => p.workspaceId === w.id)
        if (!list.length) return null
        const label = w.remote ? `🌐 ${w.name}` : w.name
        return (
          <div key={w.id} role="group" aria-label={label}>
            <small className="project-picker-group">{label}</small>
            {list.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === currentId}
                className={p.id === currentId ? 'current' : ''}
                disabled={!!disabledReason}
                onClick={() => onSelect(p.id)}
              >
                {p.id === currentId ? '✓ ' : ''}
                {p.name}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

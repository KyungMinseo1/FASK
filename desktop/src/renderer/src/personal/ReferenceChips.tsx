import type { Reference } from '../../../preload/personal'
import { Icon } from './ToolbarIcons'
import { useT } from '../../../shared/i18n/react'

/** "참고한 지식": the concepts and past questions injected into a turn's prompt. */
export default function ReferenceChips({
  references,
  onReference
}: {
  references?: Reference[]
  onReference: (ref: Reference) => void
}): React.JSX.Element | null {
  const t = useT()
  if (!references?.length) return null
  return (
    <div className="reference-chips">
      <small>{t('참고한 지식')}</small>
      {references.map((r) => (
        <button
          key={`${r.kind}:${r.id}`}
          className={`reference-chip ${r.kind}`}
          title={r.kind === 'concept' ? t('개념 보기') : t('질문 열기')}
          onClick={() => onReference(r)}
        >
          <Icon name={r.kind === 'concept' ? 'project' : 'note'} size={12} />
          {r.name}
        </button>
      ))}
    </div>
  )
}

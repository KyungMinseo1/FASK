import { useState } from 'react'
import type { ConceptLevel, Relation, RelationType, Snapshot } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import { Icon } from './ToolbarIcons'
import { useApi } from './api'
import { dateLabel } from './common'
import { LEVEL_LABELS, RELATION_LABELS } from './questionTree'
import { useT } from '../../../shared/i18n/react'

type Run = (fn: () => Promise<unknown>) => Promise<boolean>

/**
 * A concept opened from the graph: the project's questions linking it, its aliases, definition and
 * level, and its relations grouped by type (low-confidence ones wait for approval).
 * Mount with `key={conceptId}` so the edit draft resets per concept.
 */
export default function ConceptPanel({
  data,
  conceptId,
  projectId,
  run,
  onOpenQuestion,
  onClose
}: {
  data: Snapshot
  conceptId: string
  projectId: string
  run: Run
  onOpenQuestion: (questionId: string, conceptId: string) => void
  onClose: () => void
}): React.JSX.Element | null {
  const t = useT()
  const api = useApi()
  const concept = data.concepts.find((c) => c.id === conceptId)
  const [aliases, setAliases] = useState(concept?.aliases.join(', ') ?? '')
  const [definition, setDefinition] = useState(concept?.definition ?? '')
  const [level, setLevel] = useState<ConceptLevel>(concept?.level ?? 'concept')
  const [saved, setSaved] = useState(false)
  if (!concept) return null
  const linking = data.questions.filter((q) => q.conceptIds.includes(concept.id))
  const own = linking.filter((q) => q.projectId === projectId)
  const elsewhere = linking.length - own.length
  const parent = concept.parentId ? data.concepts.find((c) => c.id === concept.parentId) : undefined
  const nameOf = (id: string): string => data.concepts.find((c) => c.id === id)?.name ?? '?'
  const levels = Object.keys(LEVEL_LABELS) as ConceptLevel[]
  const children = data.concepts.filter((c) => c.parentId === concept.id)
  const relations = data.relations.filter(
    (r) => !r.invalidatedAt && (r.from === concept.id || r.to === concept.id)
  )
  const aliasList = aliases
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  const dirty =
    aliasList.join('\n') !== concept.aliases.join('\n') ||
    definition.trim() !== concept.definition ||
    level !== concept.level
  const save = async (): Promise<void> => {
    const ok = await run(() =>
      api.editConceptInfo(concept.id, { aliases: aliasList, definition: definition.trim(), level })
    )
    setSaved(ok)
  }
  const relationRow = (r: Relation): React.JSX.Element => (
    <li key={r.id} className={r.approved ? undefined : 'pending'}>
      <span>
        {r.from === concept.id ? (
          <>
            <Icon name="right" size={12} />
            {nameOf(r.to)}
          </>
        ) : (
          <>
            {nameOf(r.from)}
            <Icon name="right" size={12} />
          </>
        )}
      </span>
      {!r.approved && <small>{t('승인 대기')}</small>}
      {!r.approved && (
        <button onClick={() => void run(() => api.setRelation(r.id, 'approve'))}>
          {t('승인')}
        </button>
      )}
      <button className="danger" onClick={() => void run(() => api.setRelation(r.id, 'remove'))}>
        {t('제거')}
      </button>
    </li>
  )
  return (
    <aside className="question-detail concept-panel">
      <header>
        <span>{t('개념')}</span>
        <button onClick={onClose}>
          <Icon name="close" size={14} />
          {t('닫기')}
        </button>
      </header>
      <div className="detail-title">
        <h2>{concept.name}</h2>
        {elsewhere > 0 && <span className="shared-badge">{t('공유')}</span>}
      </div>
      <p className="detail-meta">
        <span>{t(LEVEL_LABELS[concept.level])}</span>
        {parent && <span>{t('상위: {{name}}', { name: parent.name })}</span>}
        {elsewhere > 0 && <span>{t('다른 프로젝트 질문 {{n}}개', { n: elsewhere })}</span>}
      </p>
      <h3>{t('연결된 질문')}</h3>
      {own.length ? (
        <ul className="concept-questions">
          {own.map((q) => (
            <li key={q.id}>
              <button onClick={() => onOpenQuestion(q.id, concept.id)}>
                <span>{questionHeading(q)}</span>
                <small>
                  {dateLabel(q.createdAt)}
                  {(q.conceptTurns?.[concept.id]?.length ?? 0) > 1 &&
                    ` · ${t('{{n}}개 턴', { n: q.conceptTurns[concept.id].length })}`}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="concept-empty">{t('이 프로젝트에는 연결된 질문이 없습니다.')}</p>
      )}
      <h3>{t('개념 정보')}</h3>
      <label>
        {t('동의어 (쉼표로 구분)')}
        <input
          value={aliases}
          onChange={(e) => {
            setAliases(e.target.value)
            setSaved(false)
          }}
        />
      </label>
      <label>
        {t('정의')}
        <textarea
          value={definition}
          onChange={(e) => {
            setDefinition(e.target.value)
            setSaved(false)
          }}
        />
      </label>
      <label>
        {t('수준')}
        <select
          value={level}
          onChange={(e) => {
            setLevel(e.target.value as ConceptLevel)
            setSaved(false)
          }}
        >
          {levels.map((l, i) => (
            <option
              key={l}
              value={l}
              // The parent must sit exactly one level above, and every child exactly one below.
              disabled={
                l !== concept.level &&
                ((!!parent && levels.indexOf(parent.level) !== i - 1) ||
                  children.some((c) => levels.indexOf(c.level) !== i + 1))
              }
            >
              {t(LEVEL_LABELS[l])}
            </option>
          ))}
        </select>
      </label>
      <button
        className={saved && !dirty ? 'memo-saved' : ''}
        disabled={!dirty}
        onClick={() => void save()}
      >
        {saved && !dirty ? (
          <>
            <Icon name="check" size={14} />
            {t('저장됨')}
          </>
        ) : (
          t('저장')
        )}
      </button>
      <h3>{t('관계')}</h3>
      {relations.length ? (
        (Object.keys(RELATION_LABELS) as RelationType[]).map((type) => {
          const group = relations.filter((r) => r.type === type)
          return (
            group.length > 0 && (
              <section key={type} className="relation-group">
                <small>{t(RELATION_LABELS[type])}</small>
                <ul>{group.map(relationRow)}</ul>
              </section>
            )
          )
        })
      ) : (
        <p className="concept-empty">{t('아직 관계가 없습니다.')}</p>
      )}
    </aside>
  )
}

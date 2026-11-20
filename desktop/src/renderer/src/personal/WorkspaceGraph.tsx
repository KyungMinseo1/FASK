import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { Snapshot, Workspace } from '../../../preload/personal'
import MindMap from '../components/MindMap/MindMap'
import { highlightIds } from '../components/MindMap/layout'
import TidyBar from './TidyBar'
import { projectConcepts, projectHighlight, relationHighlight, workspaceTree } from './questionTree'
import { canDropGraphNode, moveGraphNode } from './graphMove'
import { useT } from '../../../shared/i18n/react'

/**
 * The records-panel content of the workspace concept graph: every concept of the workspace, with
 * an optional project whose concepts stand out (or, filtered, are the only ones shown). The open
 * concept's relations take precedence over the project highlight. The detail panel is the caller's.
 */
export default function WorkspaceGraph({
  data,
  workspace,
  highlightProjectId,
  onHighlight,
  conceptId,
  onOpenConcept,
  locked,
  run,
  onContextMenu
}: {
  data: Snapshot
  workspace: Workspace
  /** '' = none; the caller guarantees it belongs to the workspace. */
  highlightProjectId: string
  onHighlight: (projectId: string) => void
  /** The open concept panel ('' = none). */
  conceptId: string
  onOpenConcept: (conceptId: string) => void
  locked: boolean
  run: (fn: () => Promise<unknown>) => Promise<boolean>
  onContextMenu: (event: MouseEvent, kind: 'workspace' | 'concept', id: string, name: string) => void
}): React.JSX.Element {
  const t = useT()
  const [only, setOnly] = useState(false)
  useEffect(() => {
    if (!highlightProjectId) setOnly(false)
  }, [highlightProjectId])
  const projects = data.projects.filter((p) => p.workspaceId === workspace.id)
  const workspaceConcepts = useMemo(
    () => data.concepts.filter((c) => c.workspaceId === workspace.id),
    [data.concepts, workspace.id]
  )
  const onlyIds = useMemo(
    () =>
      only && highlightProjectId
        ? new Set(projectConcepts(data, highlightProjectId).concepts.map((c) => c.id))
        : undefined,
    [data, only, highlightProjectId]
  )
  const root = useMemo(() => workspaceTree(data, workspace.id, onlyIds), [data, workspace.id, onlyIds])
  const highlight = useMemo(() => {
    if (conceptId && workspaceConcepts.some((c) => c.id === conceptId)) return relationHighlight(data, conceptId)
    if (highlightProjectId && !onlyIds) return projectHighlight(data, workspace.id, highlightProjectId)
    return undefined
  }, [data, conceptId, workspaceConcepts, highlightProjectId, onlyIds, workspace.id])
  const focusIds = useMemo(() => (highlight ? highlightIds(highlight) : undefined), [highlight])
  return (
    <>
      <div className="filter-row">
        <select
          aria-label={t('강조할 프로젝트')}
          value={highlightProjectId}
          onChange={(e) => onHighlight(e.target.value)}
        >
          <option value="">{t('프로젝트 강조 없음')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={only}
            disabled={!highlightProjectId}
            onChange={(e) => setOnly(e.target.checked)}
          />
          {t('이 프로젝트 개념만')}
        </label>
        <span>{t('{{n}}개 개념', { n: workspaceConcepts.length })}</span>
      </div>
      <div className="graph-stage">
        <TidyBar workspaceId={workspace.id} workspaceName={workspace.name} revision={data} disabled={locked} />
        <MindMap
          // A new filter is a different graph: remount so it opens framed.
          key={`${workspace.id}:${onlyIds ? highlightProjectId : ''}`}
          root={root}
          highlight={highlight}
          focusIds={focusIds}
          height="100%"
          allowCopy={false}
          canMove={(n) => n.kind === 'concept'}
          canDrop={canDropGraphNode}
          onMoveNode={
            locked
              ? undefined
              : (node, target) =>
                  void run(() => moveGraphNode(window.fask, workspaceConcepts, [], node, target, false))
          }
          onSelect={(node) => {
            if (node.id.startsWith('c:')) onOpenConcept(node.id.slice(2))
          }}
          onContextMenu={(node, event) => {
            if (node.id.startsWith('c:')) onContextMenu(event, 'concept', node.id.slice(2), node.label)
            else if (node.id.startsWith('workspace:')) onContextMenu(event, 'workspace', workspace.id, workspace.name)
          }}
        />
        <div className="graph-scope">
          <span>
            {root.children.length
              ? t('워크스페이스 전체 질문 기준')
              : t('아직 개념이 없습니다. 프로젝트에서 질문하면 개념이 쌓입니다.')}
          </span>
        </div>
      </div>
    </>
  )
}

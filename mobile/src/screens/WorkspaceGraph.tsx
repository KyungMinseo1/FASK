import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import MindMap from '@desktop/renderer/src/components/MindMap/MindMap'
import { highlightIds } from '@desktop/renderer/src/components/MindMap/layout'
import { useApi } from '@desktop/renderer/src/personal/api'
import { canDropGraphNode, moveGraphNode } from '@desktop/renderer/src/personal/graphMove'
import { errorText } from '@desktop/renderer/src/personal/common'
import ConceptPanel from '@desktop/renderer/src/personal/ConceptPanel'
import { NotificationBell } from '@desktop/renderer/src/personal/notifications'
import TidyBar from '@desktop/renderer/src/personal/TidyBar'
import {
  projectConcepts,
  projectHighlight,
  relationHighlight,
  workspaceTree
} from '@desktop/renderer/src/personal/questionTree'
import { useT } from '@desktop/shared/i18n/react'
import { useMobile } from '../context'
import { Icon } from '../icons'
import { useSheetGraph } from '../sheetGraph'

/**
 * Every concept of a workspace (`/w/:workspaceId`), optionally highlighting one project's concepts
 * (`?highlight=<projectId>`) or showing only those. A tapped concept opens the half sheet; its
 * questions open in their own project.
 */
export default function WorkspaceGraph(): React.JSX.Element {
  const { workspaceId = '' } = useParams()
  const { data, refresh } = useMobile()
  const api = useApi()
  const navigate = useNavigate()
  const t = useT()
  const [search, setSearch] = useSearchParams()
  const workspace = data.workspaces.find((w) => w.id === workspaceId)
  const projects = data.projects.filter((p) => p.workspaceId === workspaceId)
  const highlightParam = search.get('highlight') || ''
  const highlightProjectId = projects.some((p) => p.id === highlightParam) ? highlightParam : ''
  const locked = !!workspace?.remote && workspace.remote.status !== 'online'
  const [only, setOnly] = useState(false),
    [conceptId, setConceptId] = useState<string | null>(null),
    [graphError, setGraphError] = useState('')
  useEffect(() => {
    if (!highlightProjectId) setOnly(false)
  }, [highlightProjectId])
  const { graphRef, sheetRef, graphHeight, sheetFull, setSheetFull } = useSheetGraph(!!conceptId, conceptId)
  const workspaceConcepts = useMemo(
    () => data.concepts.filter((c) => c.workspaceId === workspaceId),
    [data.concepts, workspaceId]
  )
  const onlyIds = useMemo(
    () =>
      only && highlightProjectId
        ? new Set(projectConcepts(data, highlightProjectId).concepts.map((c) => c.id))
        : undefined,
    [data, only, highlightProjectId]
  )
  const root = useMemo(() => workspaceTree(data, workspaceId, onlyIds), [data, workspaceId, onlyIds])
  const highlight = useMemo(() => {
    if (conceptId && workspaceConcepts.some((c) => c.id === conceptId)) return relationHighlight(data, conceptId)
    if (highlightProjectId && !onlyIds) return projectHighlight(data, workspaceId, highlightProjectId)
    return undefined
  }, [data, conceptId, workspaceConcepts, highlightProjectId, onlyIds, workspaceId])
  const focusIds = useMemo(() => (highlight ? highlightIds(highlight) : undefined), [highlight])
  if (!workspace) return <Navigate to="/" replace />
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      setGraphError('')
      await fn()
      await refresh()
      return true
    } catch (e) {
      setGraphError(errorText(e))
      return false
    }
  }
  const open = workspaceConcepts.find((c) => c.id === conceptId)
  return (
    <>
      <header className="mobile-top">
        <button aria-label={t('뒤로')} onClick={() => (window.history.state?.idx ? navigate(-1) : navigate('/'))}>
          <Icon name="back" />
        </button>
        <h1>{workspace.name}</h1>
        <NotificationBell compact />
        <button onClick={() => navigate('/settings')}>{t('설정')}</button>
      </header>
      <main className="mobile-body">
        <section className={open ? 'mobile-list sheet-open' : 'mobile-list'}>
          <div className="filter-row">
            <select
              aria-label={t('강조할 프로젝트')}
              value={highlightProjectId}
              onChange={(e) => setSearch(e.target.value ? { highlight: e.target.value } : {}, { replace: true })}
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
          </div>
          <div className="mobile-graph-actions">
            <span className="mobile-graph-scope">
              {root.children.length
                ? t('워크스페이스 전체 질문 기준')
                : t('아직 개념이 없습니다. 프로젝트에서 질문하면 개념이 쌓입니다.')}
            </span>
          </div>
          {graphError && (
            <p className="notice error" role="alert">
              {graphError}
            </p>
          )}
          <div className="mobile-graph" ref={graphRef}>
            <TidyBar workspaceId={workspace.id} workspaceName={workspace.name} revision={data} disabled={locked} sheet />
            <MindMap
              // A new filter is a different graph: remount so it opens framed.
              key={onlyIds ? highlightProjectId : ''}
              root={root}
              highlight={highlight}
              focusIds={focusIds}
              height={conceptId && graphHeight ? graphHeight : '70vh'}
              allowCopy={false}
              canMove={(n) => n.kind === 'concept'}
              canDrop={canDropGraphNode}
              onMoveNode={
                locked
                  ? undefined
                  : (node, target) => {
                      setGraphError('')
                      void moveGraphNode(api, workspaceConcepts, [], node, target, false)
                        .then(refresh)
                        .catch((e) => setGraphError(errorText(e)))
                    }
              }
              onSelect={(node) => {
                if (node.id.startsWith('c:')) setConceptId(node.id.slice(2))
              }}
            />
          </div>
        </section>
      </main>
      {/* Non-modal half sheet: the graph above stays visible and tappable (another concept swaps the sheet). */}
      {open && (
        <div
          ref={sheetRef}
          className={`mobile-sheet concept-sheet${sheetFull ? ' full' : ''}`}
          role="dialog"
          aria-label={open.name}
        >
          <button
            type="button"
            className="sheet-handle"
            aria-label={sheetFull ? t('시트 줄이기') : t('시트 크게 보기')}
            aria-expanded={sheetFull}
            onClick={() => setSheetFull((f) => !f)}
          />
          {graphError && <p className="notice error">{graphError}</p>}
          <ConceptPanel
            key={open.id}
            data={data}
            conceptId={open.id}
            projectId={null}
            run={run}
            onOpenQuestion={(id, concept) => {
              const pid = data.questions.find((q) => q.id === id)?.projectId
              if (!pid) return
              setConceptId(null)
              navigate(`/p/${pid}/q/${id}?concept=${encodeURIComponent(concept)}`)
            }}
            onOpenConcept={setConceptId}
            onClose={() => setConceptId(null)}
          />
        </div>
      )}
    </>
  )
}

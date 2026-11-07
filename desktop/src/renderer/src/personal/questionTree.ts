import type {
  Concept,
  ConceptLevel,
  Question,
  RelationType,
  Snapshot
} from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import type { MindNode } from '../lib/trees'
import type { RelationEdge } from '../components/MindMap/MindMap'
import { t } from '../../../shared/i18n'

/** Korean source labels of concept levels and relation types; display through `t()`. */
export const LEVEL_LABELS: Record<ConceptLevel, string> = {
  topic: '주제',
  concept: '개념',
  detail: '세부'
}
export const RELATION_LABELS: Record<RelationType, string> = {
  prerequisite: '선행',
  part: '부분',
  uses: '사용',
  contrast: '대조',
  example: '예시'
}

/**
 * Concepts a project's graph shows: those linked by the project's questions plus their ancestors.
 * A concept the user just added in this workspace (manual, not yet linked by any question, no
 * children) is shown too so it can receive questions. `shared` holds the ones another project's
 * question also links (shown with a '공유' badge).
 */
export function projectConcepts(
  data: Snapshot,
  projectId: string
): { concepts: Concept[]; shared: Set<string> } {
  const workspaceId = data.projects.find((p) => p.id === projectId)?.workspaceId
  const byId = new Map(data.concepts.map((c) => [c.id, c]))
  const linked = new Set<string>()
  const elsewhere = new Set<string>()
  for (const q of data.questions)
    for (const id of q.conceptIds) (q.projectId === projectId ? linked : elsewhere).add(id)
  const parents = new Set(data.concepts.map((c) => c.parentId))
  for (const c of data.concepts)
    if (c.manual && c.workspaceId === workspaceId && !elsewhere.has(c.id) && !parents.has(c.id))
      linked.add(c.id)
  const shown = new Set<string>()
  for (const id of linked) {
    // Walk up the parents; `shown` doubles as the cycle guard.
    for (
      let c = byId.get(id);
      c && !shown.has(c.id);
      c = c.parentId ? byId.get(c.parentId) : undefined
    )
      shown.add(c.id)
  }
  const concepts = data.concepts.filter((c) => shown.has(c.id))
  return { concepts, shared: new Set(concepts.filter((c) => elsewhere.has(c.id)).map((c) => c.id)) }
}

/**
 * Concepts a question of the project can link: the project's graph concepts first, then the rest
 * of the workspace (alphabetical).
 */
export function linkableConcepts(data: Snapshot, projectId: string): Concept[] {
  const workspaceId = data.projects.find((p) => p.id === projectId)?.workspaceId
  const { concepts } = projectConcepts(data, projectId)
  const shown = new Set(concepts.map((c) => c.id))
  const rest = data.concepts
    .filter((c) => c.workspaceId === workspaceId && !shown.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...concepts, ...rest]
}

/**
 * The selected concept's active relations as graph overlay edges between concept nodes
 * (`c:<id>`), labelled with the relation type's Korean source label; unapproved ones are `pending`.
 */
export function relationOverlay(data: Snapshot, conceptId: string | null | undefined): RelationEdge[] {
  if (!conceptId) return []
  return data.relations
    .filter((r) => !r.invalidatedAt && (r.from === conceptId || r.to === conceptId))
    .map((r) => ({
      id: r.id,
      source: `c:${r.from}`,
      target: `c:${r.to}`,
      label: RELATION_LABELS[r.type],
      pending: !r.approved
    }))
}

/** Concept tree of a project with question leaves; leaf ids are `q:<questionId>:<parent>`. */
export function questionTree(data: Snapshot, projectId: string, questions: Question[]): MindNode {
  const { concepts, shared } = projectConcepts(data, projectId)
  const leaf = (q: Question, parent: string): MindNode => ({
    id: `q:${q.id}:${parent}`,
    label: questionHeading(q).slice(0, 34),
    kind: 'question',
    detail: questionHeading(q),
    children: []
  })
  /** Distinct questions anywhere under a node (a question filed under two sub-concepts counts once). */
  const questionIds = (n: MindNode, into: Set<string>): Set<string> => {
    if (n.kind === 'question') into.add(n.id.split(':')[1])
    for (const child of n.children) questionIds(child, into)
    return into
  }
  const node = (c: Concept, seen: Set<string>): MindNode => {
    const children = seen.has(c.id)
      ? []
      : [
          ...concepts
            .filter((s) => s.parentId === c.id)
            .map((s) => node(s, new Set([...seen, c.id]))),
          ...questions.filter((q) => q.conceptIds.includes(c.id)).map((q) => leaf(q, c.id))
        ]
    const self: MindNode = {
      id: `c:${c.id}`,
      label: c.name,
      kind: 'concept',
      children,
      ...(shared.has(c.id) ? { badge: t('공유') } : {})
    }
    return { ...self, count: questionIds(self, new Set()).size }
  }
  return {
    id: `project:${projectId}`,
    label: data.projects.find((p) => p.id === projectId)?.name || t('프로젝트'),
    kind: 'root',
    children: [
      ...concepts
        .filter((c) => !c.parentId || !concepts.some((p) => p.id === c.parentId))
        .map((c) => node(c, new Set())),
      {
        id: 'unfiled',
        label: t('미분류'),
        kind: 'group',
        count: questions.filter((q) => !q.conceptIds.length).length,
        children: questions.filter((q) => !q.conceptIds.length).map((q) => leaf(q, 'unfiled'))
      }
    ]
  }
}

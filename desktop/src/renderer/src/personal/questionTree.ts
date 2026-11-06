import type { Concept, Question, Snapshot } from '../../../preload/personal'
import { questionHeading } from '../../../shared/questions'
import type { MindNode } from '../lib/trees'
import { t } from '../../../shared/i18n'

/** Concept tree of a project with question leaves; leaf ids are `q:<questionId>:<parent>`. */
export function questionTree(data: Snapshot, projectId: string, questions: Question[]): MindNode {
  const concepts = data.concepts.filter((c) => c.projectId === projectId)
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
    const self: MindNode = { id: `c:${c.id}`, label: c.name, kind: 'concept', children }
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

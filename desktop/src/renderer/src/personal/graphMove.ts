import type { Concept, KnowledgeApi, Question } from '../../../preload/personal'
import type { MindNode } from '../lib/trees'

/** Graph node kinds that can be picked up, and where they may be dropped. */
export const canMoveGraphNode = (node: MindNode): boolean =>
  node.kind === 'question' || node.kind === 'concept'
export const canDropGraphNode = (node: MindNode, target: MindNode): boolean =>
  target.kind === 'concept' || target.kind === 'root' || (node.kind === 'question' && target.id === 'unfiled')

/**
 * Applies a long-press drop in the concept graph. A question moves its concept link (or adds one
 * when `copy`); a concept moves under the target. Concepts are workspace-wide and names are unique
 * there, so a concept is never copied.
 */
export async function moveGraphNode(
  api: Pick<KnowledgeApi, 'updateQuestion' | 'editConcept'>,
  concepts: Concept[],
  questions: Question[],
  node: MindNode,
  target: MindNode,
  copy: boolean
): Promise<void> {
  const to = target.id.startsWith('c:') ? target.id.slice(2) : null
  if (node.kind === 'question') {
    const [, id, from] = node.id.split(':')
    const q = questions.find((q) => q.id === id)
    if (!q) return
    const keep = copy ? q.conceptIds : q.conceptIds.filter((c) => c !== from)
    const conceptIds = [...new Set(to ? [...keep, to] : keep)]
    if (conceptIds.join() !== q.conceptIds.join()) await api.updateQuestion(id, { conceptIds })
    return
  }
  const concept = concepts.find((c) => `c:${c.id}` === node.id)
  if (!concept || concept.id === to) return
  if ((concept.parentId || null) !== to) await api.editConcept(concept.id, concept.name, to)
}

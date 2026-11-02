import type {
  GraphOut,
  NodeOut,
  PathItem,
  QuestionType,
  SessionOut,
  StudentQuestionOut,
  TeacherQuestionOut,
  WeekOut,
  WeekRef
} from '../api/types'
import { QUESTION_TYPE_CODES, QUESTION_TYPE_LABEL } from './questionTypes'
import { t } from '../../../shared/i18n'

export type MindNodeKind = 'root' | 'week' | 'topic' | 'concept' | 'type' | 'group' | 'question'

export interface MindNode {
  id: string
  label: string
  kind: MindNodeKind
  count?: number
  detail?: string
  badge?: string
  /** Questions attached directly to this concept per the server (known even when leaves are hidden). */
  ownQuestions?: number
  /** True when this node's subtree holds at least one student question. */
  hasQuestions?: boolean
  children: MindNode[]
}

/** Parses stable ids like `node-12` / `week-3` / `q-7`; returns null if the prefix does not match. */
export function idOf(mindId: string, prefix: 'course' | 'week' | 'node' | 'q'): number | null {
  const head = `${prefix}-`
  if (!mindId.startsWith(head)) return null
  const n = Number(mindId.slice(head.length))
  return Number.isInteger(n) ? n : null
}

/**
 * Sets `count` (question leaves in the subtree, or the server-side counts when leaves are hidden)
 * and `hasQuestions` on every non-question node.
 */
function withCounts(node: MindNode): { leaves: number; own: number } {
  if (node.kind === 'question') return { leaves: 1, own: 0 }
  let leaves = 0
  let own = node.ownQuestions ?? 0
  for (const child of node.children) {
    const sub = withCounts(child)
    leaves += sub.leaves
    own += sub.own
  }
  node.count = leaves || own
  node.hasQuestions = node.count > 0
  return { leaves, own }
}

const weekLabel = (w: { week_no: number; title: string }): string =>
  t('{{n}}주차 · {{title}}', { n: w.week_no, title: w.title })

function sortedNodes(nodes: NodeOut[]): NodeOut[] {
  return [...nodes].sort((a, b) => a.position - b.position || a.id - b.id)
}

function teacherLeaf(q: TeacherQuestionOut, badge?: string): MindNode {
  return {
    id: `q-${q.id}`,
    label: q.keyword,
    detail: q.refined_text,
    kind: 'question',
    badge,
    children: []
  }
}

function buildWeekNode(week: WeekOut, questions: TeacherQuestionOut[] | undefined): MindNode {
  const weekNode: MindNode = {
    id: `week-${week.id}`,
    label: weekLabel(week),
    kind: 'week',
    badge: week.is_lecture ? undefined : t('수업 없음'),
    children: []
  }
  const byId = new Map<number, MindNode>()
  for (const n of week.nodes) {
    byId.set(n.id, {
      id: `node-${n.id}`,
      label: n.title,
      detail: n.summary || undefined,
      kind: 'concept',
      ownQuestions: questions ? 0 : n.question_count,
      children: []
    })
  }
  for (const n of sortedNodes(week.nodes)) {
    const mind = byId.get(n.id)!
    const parent = n.parent_id != null ? byId.get(n.parent_id) : undefined
    if (parent) {
      parent.children.push(mind)
    } else {
      mind.kind = 'topic'
      weekNode.children.push(mind)
    }
  }
  if (questions) {
    for (const q of questions) {
      if (q.assigned_week.id !== week.id) continue
      const leaf = teacherLeaf(
        q,
        q.off_week ? t('{{n}}주차 수업에서', { n: q.session_week_no }) : undefined
      )
      const last = q.concept_path[q.concept_path.length - 1]
      const target = (last && byId.get(last.id)) || weekNode
      target.children.push(leaf)
    }
  }
  return weekNode
}

export function buildCourseTree(graph: GraphOut, questions?: TeacherQuestionOut[]): MindNode {
  const root: MindNode = {
    id: `course-${graph.course.id}`,
    label: graph.course.name,
    kind: 'root',
    children: [...graph.weeks]
      .sort((a, b) => a.week_no - b.week_no)
      .map((w) => buildWeekNode(w, questions))
  }
  withCounts(root)
  return root
}

export function buildWeekTree(
  graph: GraphOut,
  weekId: number,
  questions?: TeacherQuestionOut[]
): MindNode | null {
  const week = graph.weeks.find((w) => w.id === weekId)
  if (!week) return null
  const root = buildWeekNode(week, questions)
  root.kind = 'root'
  withCounts(root)
  return root
}

/** Returns (creating if needed) the child with `id` under `parent`. */
function childOf(
  parent: MindNode,
  id: string,
  make: () => Omit<MindNode, 'id' | 'children'>
): MindNode {
  let child = parent.children.find((c) => c.id === id)
  if (!child) {
    child = { id, children: [], ...make() }
    parent.children.push(child)
  }
  return child
}

/** Walks/creates `node-{id}` nodes along a concept path; depth 0 = topic. */
function alongPath(start: MindNode, path: PathItem[]): MindNode {
  let cur = start
  path.forEach((p, i) => {
    cur = childOf(cur, `node-${p.id}`, () => ({
      label: p.title,
      kind: i === 0 ? 'topic' : 'concept'
    }))
  })
  return cur
}

function weekChild(parent: MindNode, week: WeekRef): MindNode {
  return childOf(parent, `week-${week.id}`, () => ({ label: weekLabel(week), kind: 'week' }))
}

function sortWeekChildren(node: MindNode, weekNoById: Map<string, number>): void {
  node.children.sort((a, b) => {
    const wa = weekNoById.get(a.id)
    const wb = weekNoById.get(b.id)
    if (wa != null && wb != null) return wa - wb
    if (wa != null) return -1
    if (wb != null) return 1
    return 0
  })
}

export function buildLiveConceptTree(
  session: SessionOut,
  questions: TeacherQuestionOut[]
): MindNode {
  const root: MindNode = {
    id: `week-${session.week_id}`,
    label: weekLabel({ week_no: session.week_no, title: session.week_title }),
    kind: 'root',
    children: []
  }
  const weekNoById = new Map<string, number>()
  for (const q of questions) {
    if (q.assigned_week.id === session.week_id) {
      const target =
        q.concept_path.length > 0
          ? alongPath(root, q.concept_path)
          : childOf(root, 'group-unclassified', () => ({ label: t('미분류'), kind: 'group' }))
      target.children.push(teacherLeaf(q))
    } else {
      const others = childOf(root, 'group-other-weeks', () => ({
        label: t('다른 주차'),
        kind: 'group'
      }))
      const week = weekChild(others, q.assigned_week)
      weekNoById.set(week.id, q.assigned_week.week_no)
      alongPath(week, q.concept_path).children.push(
        teacherLeaf(q, t('→ {{n}}주차', { n: q.assigned_week.week_no }))
      )
    }
  }
  const others = root.children.find((c) => c.id === 'group-other-weeks')
  if (others) sortWeekChildren(others, weekNoById)
  withCounts(root)
  return root
}

interface TypeLeaf {
  type: QuestionType | null
  pending: boolean
  node: MindNode
}

function typeTree(rootId: string, rootLabel: string, leaves: TypeLeaf[]): MindNode {
  const root: MindNode = {
    id: rootId,
    label: rootLabel,
    kind: 'root',
    children: QUESTION_TYPE_CODES.map((code) => ({
      id: `type-${code}`,
      label: t(QUESTION_TYPE_LABEL[code]),
      kind: 'type' as const,
      children: []
    }))
  }
  for (const leaf of leaves) {
    let target: MindNode
    if (leaf.pending) {
      target = childOf(root, 'group-pending', () => ({ label: t('분류 중'), kind: 'group' }))
    } else if (leaf.type) {
      target = root.children.find((c) => c.id === `type-${leaf.type}`)!
    } else {
      target = childOf(root, 'group-unclassified', () => ({ label: t('미분류'), kind: 'group' }))
    }
    target.children.push(leaf.node)
  }
  withCounts(root)
  return root
}

export function buildTypeTree(rootLabel: string, questions: TeacherQuestionOut[]): MindNode {
  return typeTree(
    'type-root',
    rootLabel,
    questions.map((q) => ({
      type: q.question_type,
      pending: false,
      node: teacherLeaf(q, q.off_week ? t('→ {{n}}주차', { n: q.assigned_week.week_no }) : undefined)
    }))
  )
}

function studentLeaf(q: StudentQuestionOut): MindNode {
  const label =
    q.keyword || (q.refined_text.length > 14 ? `${q.refined_text.slice(0, 14)}…` : q.refined_text)
  return {
    id: `q-${q.id}`,
    label,
    detail: q.refined_text,
    kind: 'question',
    badge: q.off_week ? t('{{n}}주차 수업에서', { n: q.session_week.week_no }) : undefined,
    children: []
  }
}

export function buildStudentTree(
  course: { id: number; name: string },
  questions: StudentQuestionOut[],
  mode: 'concept' | 'type'
): MindNode {
  const rootId = `course-${course.id}`
  if (mode === 'type') {
    return typeTree(
      rootId,
      course.name,
      questions.map((q) => ({
        type: q.question_type,
        pending: q.status === 'pending',
        node: studentLeaf(q)
      }))
    )
  }
  const root: MindNode = { id: rootId, label: course.name, kind: 'root', children: [] }
  const weekNoById = new Map<string, number>()
  for (const q of questions) {
    if (q.status === 'pending') {
      childOf(root, 'group-pending', () => ({ label: t('분류 중'), kind: 'group' })).children.push(
        studentLeaf(q)
      )
      continue
    }
    const assigned = q.assigned_week ?? q.session_week
    const week = weekChild(root, assigned)
    weekNoById.set(week.id, assigned.week_no)
    alongPath(week, q.concept_path).children.push(studentLeaf(q))
  }
  sortWeekChildren(root, weekNoById)
  withCounts(root)
  return root
}

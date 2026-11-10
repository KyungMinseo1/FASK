import type {
  Concept,
  ConceptLevel,
  LocalSettings,
  Project,
  Question,
  RelationType,
  Snapshot,
  TextAttachment
} from '../preload/personal'
import { mergeLegacyQuestions, type LegacyQuestion } from '../shared/questions'
import { normalizeName } from './knowledge-search'

export interface Backup {
  version: 3
  snapshot: Snapshot
  images: Record<string, string>
}
const STATUSES = ['saved', 'running', 'completed', 'failed', 'cancelled']
const COMPLEXITIES = ['simple', 'complex', 'unknown']
export const CONCEPT_LEVELS: readonly ConceptLevel[] = ['topic', 'concept', 'detail']
/** The only level a concept's parent may have; topics have no parent. */
export const PARENT_LEVEL: Record<ConceptLevel, ConceptLevel | null> = {
  topic: null,
  concept: 'topic',
  detail: 'concept'
}
/** The only level a concept's children may have; details have no children. */
export const CHILD_LEVEL: Record<ConceptLevel, ConceptLevel | null> = {
  topic: 'concept',
  concept: 'detail',
  detail: null
}
/**
 * Maps the legacy 'domain' level to 'topic', then restores the 3-level invariant (a parent is
 * exactly one level up). Each tree is walked from its root, roots in input order, so a parent's
 * level is final before its children are checked. A child at the wrong level takes the level
 * below its parent when every one of its own children would still be exactly one level below it
 * (always true for a leaf); otherwise, or under a detail, it is detached and becomes a root.
 * Concepts with a missing parent or on a cycle are detached too. Mutates `concepts` in place and
 * returns the ones that changed.
 */
export function repairHierarchy(concepts: Concept[]): Concept[] {
  const changed = new Set<Concept>()
  for (const c of concepts)
    // Schema 3 and older backups had a fourth level, 'domain', above topic.
    if ((c.level as string) === 'domain') {
      c.level = 'topic'
      changed.add(c)
    }
  const byId = new Map(concepts.map((c) => [c.id, c]))
  const children = new Map<string, Concept[]>()
  for (const c of concepts)
    if (c.parentId && byId.has(c.parentId)) {
      const siblings = children.get(c.parentId)
      if (siblings) siblings.push(c)
      else children.set(c.parentId, [c])
    }
  const visited = new Set<string>()
  const walk = (root: Concept): void => {
    visited.add(root.id)
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i]
      for (const child of children.get(parent.id) ?? []) {
        if (visited.has(child.id) || child.parentId !== parent.id) continue
        visited.add(child.id)
        const need = CHILD_LEVEL[parent.level]
        if (child.level !== need) {
          const grand = need ? CHILD_LEVEL[need] : null
          if (need && (children.get(child.id) ?? []).every((k) => k.level === grand))
            child.level = need
          else child.parentId = null
          changed.add(child)
        }
        queue.push(child)
      }
    }
  }
  const detach = (c: Concept): void => {
    c.parentId = null
    changed.add(c)
  }
  for (const c of concepts)
    if (!c.parentId || !byId.has(c.parentId)) {
      if (c.parentId) detach(c)
      walk(c)
    }
  for (const c of concepts)
    if (!visited.has(c.id)) {
      detach(c)
      walk(c)
    }
  return [...changed]
}
export const RELATION_TYPES: readonly RelationType[] = [
  'prerequisite',
  'part',
  'uses',
  'contrast',
  'example'
]
const MEMORY_SCOPES: readonly LocalSettings['memoryScope'][] = ['off', 'project', 'workspace']

/** A concept as stored before schema 3 / backup v3: owned by a project, without aliases or level. */
export interface LegacyConcept {
  id: string
  projectId: string
  name: string
  parentId: string | null
  manual?: boolean
}

/**
 * Moves project concepts into their project's workspace. Exact-name duplicates within a workspace
 * merge into the first one; question links follow the merge. Existing questions count as already
 * extracted, so upgrading never triggers extraction of old data.
 */
export function upgradeConcepts(
  projects: Pick<Project, 'id' | 'workspaceId'>[],
  legacy: LegacyConcept[],
  questions: Question[]
): { concepts: Concept[]; questions: Question[] } {
  const workspaceOf = new Map(projects.map((p) => [p.id, p.workspaceId]))
  const byName = new Map<string, Concept>()
  const target = new Map<string, string>()
  const concepts: Concept[] = []
  for (const c of legacy) {
    const workspaceId = workspaceOf.get(c.projectId)
    if (!workspaceId) continue
    const key = `${workspaceId}\u0000${normalizeName(c.name)}`
    const keeper = byName.get(key)
    if (keeper) {
      target.set(c.id, keeper.id)
      keeper.manual ||= c.manual === true
      keeper.parentId ??= c.parentId
      continue
    }
    const next: Concept = {
      id: c.id,
      workspaceId,
      name: c.name,
      parentId: c.parentId ?? null,
      manual: c.manual === true,
      aliases: [],
      definition: '',
      level: 'concept'
    }
    byName.set(key, next)
    target.set(c.id, c.id)
    concepts.push(next)
  }
  const byId = new Map(concepts.map((c) => [c.id, c]))
  for (const c of concepts) {
    const parent = c.parentId ? target.get(c.parentId) : undefined
    c.parentId =
      parent && parent !== c.id && byId.get(parent)?.workspaceId === c.workspaceId ? parent : null
  }
  // Merging can join two trees into a cycle; the concept that closes it loses its parent.
  for (const c of concepts) {
    const seen = new Set([c.id])
    let next = c.parentId
    while (next) {
      if (next === c.id) {
        c.parentId = null
        break
      }
      if (seen.has(next)) break
      seen.add(next)
      next = byId.get(next)?.parentId ?? null
    }
  }
  return {
    concepts,
    questions: questions.map((q) => {
      const workspaceId = workspaceOf.get(q.projectId)
      const conceptIds = [
        ...new Set(
          q.conceptIds
            .map((id) => target.get(id))
            .filter((id): id is string => !!id && byId.get(id)?.workspaceId === workspaceId)
        )
      ]
      // Legacy links are re-keyed above: their roles/sources (and a tidy stay mark) are not kept.
      const next: Question = { ...q, conceptIds, conceptTurns: {}, extractedTurns: q.turns.length }
      delete next.conceptRoles
      delete next.conceptSources
      delete next.tidyStay
      return next
    })
  }
}

/**
 * Validates a v1, v2 or v3 backup and always returns v3 (v1 conversations merge into one question).
 * Concept levels and parents are repaired to the 3-level hierarchy (see repairHierarchy).
 */
export function validateBackup(input: unknown): Backup {
  const fail = (): never => {
    throw new Error('백업 형식이나 프로젝트 참조가 잘못되었습니다.')
  }
  if (!input || typeof input !== 'object') fail()
  const value = input as { version: unknown; snapshot: Snapshot; images: Record<string, string> }
  if (
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !value.snapshot ||
    typeof value.snapshot !== 'object' ||
    !value.images ||
    typeof value.images !== 'object'
  )
    fail()
  const { snapshot: s } = value
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')
  const badDocuments = (documents: unknown): boolean =>
    !Array.isArray(documents) ||
    documents.length > 5 ||
    documents.some(
      (d: TextAttachment) =>
        !d ||
        typeof d.name !== 'string' ||
        typeof d.text !== 'string' ||
        d.name.length > 255 ||
        d.text.length > 50000
    )
  const badImage = (attachment: unknown): boolean =>
    attachment !== null &&
    (typeof attachment !== 'string' ||
      typeof value.images[attachment] !== 'string' ||
      !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value.images[attachment]))
  // conceptRoles/conceptSources: optional plain object keyed by linked concept ids.
  const badLinkMap = (map: unknown, conceptIds: string[], values: readonly string[]): boolean =>
    map !== undefined &&
    (!map ||
      typeof map !== 'object' ||
      Array.isArray(map) ||
      Object.entries(map).some(([id, v]) => !conceptIds.includes(id) || !values.includes(v as string)))
  if (value.version === 1) {
    if (!Array.isArray(s.questions)) fail()
    const legacy = s.questions as unknown as LegacyQuestion[]
    for (const q of legacy) {
      if (!q || typeof q !== 'object') fail()
      if (q.documents !== undefined && badDocuments(q.documents)) fail()
      for (const key of [
        'id',
        'projectId',
        'conversationId',
        'createdAt',
        'raw',
        'refined',
        'sent',
        'answer',
        'model',
        'actualModel',
        'memo',
        'error',
        'routingReason'
      ] as const)
        if (typeof q[key] !== 'string') fail()
      if (
        !Number.isFinite(Date.parse(q.createdAt)) ||
        typeof q.important !== 'boolean' ||
        !STATUSES.includes(q.status) ||
        !COMPLEXITIES.includes(q.complexity) ||
        badImage(q.attachment) ||
        !strings(q.conceptIds) ||
        !strings(q.suggestions)
      )
        fail()
    }
    s.questions = mergeLegacyQuestions(legacy)
  }
  for (const array of [s.workspaces, s.projects, s.concepts, s.questions])
    if (!Array.isArray(array)) fail()
  const ids = new Set<string>()
  for (const item of [...s.workspaces, ...s.projects, ...s.concepts, ...s.questions]) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail()
    ids.add(item.id)
  }
  for (const w of s.workspaces)
    if (typeof w.name !== 'string' || (w.tidyCandidates !== undefined && !strings(w.tidyCandidates))) fail()
  for (const p of s.projects)
    if (typeof p.name !== 'string' || !s.workspaces.some((w) => w.id === p.workspaceId)) fail()
  const projectWorkspace = new Map(s.projects.map((p) => [p.id, p.workspaceId]))
  for (const q of s.questions)
    if (!q || !projectWorkspace.has(q.projectId) || !strings(q.conceptIds) || !Array.isArray(q.turns))
      fail()
  if (value.version !== 3) {
    // v1/v2 concepts belong to a project; checked as such, then moved into the workspace.
    const legacy = s.concepts as unknown as LegacyConcept[]
    const byLegacy = new Map(legacy.map((c) => [c.id, c]))
    for (const c of legacy) {
      if (typeof c.name !== 'string' || !projectWorkspace.has(c.projectId)) fail()
      const seen = new Set([c.id])
      let next = c.parentId
      while (next) {
        const parent = byLegacy.get(next)
        if (!parent) return fail()
        if (parent.projectId !== c.projectId || seen.has(next)) fail()
        seen.add(next)
        next = parent.parentId
      }
    }
    for (const q of s.questions)
      for (const id of q.conceptIds) if (byLegacy.get(id)?.projectId !== q.projectId) fail()
    const upgraded = upgradeConcepts(s.projects, legacy, s.questions)
    s.concepts = upgraded.concepts
    s.questions = upgraded.questions
    s.relations = []
    if (s.settings && typeof s.settings === 'object') {
      const { memory, ...settings } = s.settings as LocalSettings & { memory?: unknown }
      s.settings = { ...settings, memoryScope: memory === false ? 'off' : 'project' }
    }
  }
  if (!Array.isArray(s.relations)) fail()
  const byConcept = new Map(s.concepts.map((c) => [c.id, c]))
  for (const c of s.concepts) {
    if (
      typeof c.name !== 'string' ||
      !s.workspaces.some((w) => w.id === c.workspaceId) ||
      typeof c.manual !== 'boolean' ||
      !strings(c.aliases) ||
      typeof c.definition !== 'string' ||
      (!CONCEPT_LEVELS.includes(c.level) && (c.level as string) !== 'domain') ||
      (c.tidiedCount !== undefined && (!Number.isInteger(c.tidiedCount) || c.tidiedCount < 0)) ||
      (c.tidyReviewed !== undefined && typeof c.tidyReviewed !== 'string') ||
      (c.tidyPairs !== undefined && !strings(c.tidyPairs)) ||
      (c.tidyKept !== undefined && typeof c.tidyKept !== 'string') ||
      (c.tidyNamed !== undefined && typeof c.tidyNamed !== 'string')
    )
      fail()
    const seen = new Set([c.id])
    let next = c.parentId
    while (next) {
      const parent = byConcept.get(next)
      if (!parent) return fail()
      if (parent.workspaceId !== c.workspaceId || seen.has(next)) fail()
      seen.add(next)
      next = parent.parentId
    }
  }
  repairHierarchy(s.concepts)
  const byQuestion = new Map<string, Question>()
  for (const q of s.questions) {
    byQuestion.set(q.id, q)
    if (
      q.title !== undefined &&
      (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 200)
    )
      fail()
    if (
      !strings(q.suggestions) ||
      typeof q.memo !== 'string' ||
      typeof q.important !== 'boolean' ||
      typeof q.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(q.createdAt)) ||
      !q.turns.length ||
      !Number.isInteger(q.extractedTurns) ||
      q.extractedTurns < 0 ||
      q.extractedTurns > q.turns.length ||
      !q.conceptTurns ||
      typeof q.conceptTurns !== 'object' ||
      Array.isArray(q.conceptTurns) ||
      badLinkMap(q.conceptRoles, q.conceptIds, ['focus', 'support']) ||
      badLinkMap(q.conceptSources, q.conceptIds, ['user', 'model']) ||
      (q.tidyStay !== undefined && typeof q.tidyStay !== 'string')
    )
      fail()
    const workspaceId = projectWorkspace.get(q.projectId)
    for (const id of q.conceptIds) if (byConcept.get(id)?.workspaceId !== workspaceId) fail()
    const turnIds = new Set<string>()
    for (const t of q.turns) {
      if (!t || typeof t.id !== 'string' || turnIds.has(t.id)) fail()
      turnIds.add(t.id)
      for (const key of [
        'createdAt',
        'raw',
        'refined',
        'sent',
        'answer',
        'model',
        'actualModel',
        'error',
        'routingReason'
      ] as const)
        if (typeof t[key] !== 'string') fail()
      if (
        !Number.isInteger(t.revision) ||
        t.revision < 0 ||
        !STATUSES.includes(t.status) ||
        !COMPLEXITIES.includes(t.complexity) ||
        badDocuments(t.documents) ||
        badImage(t.attachment)
      )
        fail()
      if (
        t.references !== undefined &&
        (!Array.isArray(t.references) ||
          t.references.some(
            (r) =>
              !r ||
              (r.kind !== 'concept' && r.kind !== 'question') ||
              typeof r.id !== 'string' ||
              typeof r.name !== 'string'
          ))
      )
        fail()
    }
    for (const [id, turns] of Object.entries(q.conceptTurns))
      if (!q.conceptIds.includes(id) || !strings(turns) || turns.some((t) => !turnIds.has(t)))
        fail()
  }
  const relationIds = new Set<string>()
  for (const r of s.relations) {
    if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id) || relationIds.has(r.id)) fail()
    relationIds.add(r.id)
    const from = byConcept.get(r.from)
    const to = byConcept.get(r.to)
    const source = r.questionId === null ? undefined : byQuestion.get(r.questionId)
    if (
      !from ||
      !to ||
      r.from === r.to ||
      from.workspaceId !== r.workspaceId ||
      to.workspaceId !== r.workspaceId ||
      !RELATION_TYPES.includes(r.type) ||
      (r.questionId !== null && !source) ||
      !strings(r.turnIds) ||
      r.turnIds.some((t) => !source?.turns.some((turn) => turn.id === t)) ||
      typeof r.confidence !== 'number' ||
      !(r.confidence >= 0 && r.confidence <= 1) ||
      typeof r.approved !== 'boolean' ||
      typeof r.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(r.createdAt)) ||
      (r.invalidatedAt !== null &&
        (typeof r.invalidatedAt !== 'string' || !Number.isFinite(Date.parse(r.invalidatedAt)))) ||
      (r.evidence !== undefined && typeof r.evidence !== 'string') ||
      (r.tidyKept !== undefined && typeof r.tidyKept !== 'boolean')
    )
      fail()
  }
  if (
    !s.settings ||
    typeof s.settings.endpoint !== 'string' ||
    !Array.isArray(s.settings.models) ||
    !Array.isArray(s.settings.regions)
  )
    fail()
  for (const key of ['model', 'fastModel', 'deepModel'] as const)
    if (typeof s.settings[key] !== 'string') fail()
  if (
    s.settings.models.some((m) => typeof m !== 'string') ||
    !['manual', 'recommend', 'auto'].includes(s.settings.routing) ||
    !['minimal', 'balanced', 'preserve'].includes(s.settings.retention) ||
    !MEMORY_SCOPES.includes(s.settings.memoryScope)
  )
    fail()
  if (s.settings.autoTitle !== undefined && typeof s.settings.autoTitle !== 'boolean') fail()
  for (const key of ['memoryTokens', 'extractDelaySec'] as const)
    if (
      s.settings[key] !== undefined &&
      (!Number.isFinite(s.settings[key]) || s.settings[key] < 0)
    )
      fail()
  if (s.settings.organizeModel !== undefined && typeof s.settings.organizeModel !== 'string')
    fail()
  if (s.settings.promptLanguage !== undefined && !['ko', 'en'].includes(s.settings.promptLanguage)) fail()
  for (const region of s.settings.regions) {
    if (
      !region ||
      !region.rect ||
      !Number.isFinite(region.displayId) ||
      !Number.isFinite(region.screenWidth) ||
      !Number.isFinite(region.screenHeight)
    )
      fail()
    const { x, y, width, height } = region.rect
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1.000001 ||
      y + height > 1.000001
    )
      fail()
  }
  return { version: 3, snapshot: s, images: value.images }
}

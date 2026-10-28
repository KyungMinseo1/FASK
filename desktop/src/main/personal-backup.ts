import type { Snapshot, TextAttachment } from '../preload/personal'
import { mergeLegacyQuestions, type LegacyQuestion } from '../shared/questions'

export interface Backup {
  version: 2
  snapshot: Snapshot
  images: Record<string, string>
}
const STATUSES = ['saved', 'running', 'completed', 'failed', 'cancelled']
const COMPLEXITIES = ['simple', 'complex', 'unknown']
/** Validates a v1 or v2 backup and always returns v2 (v1 conversations merge into one question). */
export function validateBackup(input: unknown): Backup {
  const fail = (): never => {
    throw new Error('백업 형식이나 프로젝트 참조가 잘못되었습니다.')
  }
  if (!input || typeof input !== 'object') fail()
  const value = input as { version: unknown; snapshot: Snapshot; images: Record<string, string> }
  if (
    (value.version !== 1 && value.version !== 2) ||
    !value.snapshot ||
    !value.images ||
    typeof value.images !== 'object'
  )
    fail()
  const { snapshot: s } = value
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
        !Array.isArray(q.conceptIds) ||
        !Array.isArray(q.suggestions) ||
        q.conceptIds.some((v) => typeof v !== 'string') ||
        q.suggestions.some((v) => typeof v !== 'string')
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
  for (const w of s.workspaces) if (typeof w.name !== 'string') fail()
  for (const p of s.projects)
    if (typeof p.name !== 'string' || !s.workspaces.some((w) => w.id === p.workspaceId)) fail()
  const byConcept = new Map(s.concepts.map((c) => [c.id, c]))
  for (const c of s.concepts) {
    if (typeof c.name !== 'string' || !s.projects.some((p) => p.id === c.projectId)) fail()
    const seen = new Set([c.id])
    let next = c.parentId
    while (next) {
      const parent = byConcept.get(next)
      if (!parent) return fail()
      if (parent.projectId !== c.projectId || seen.has(next)) fail()
      seen.add(next)
      next = parent.parentId
    }
  }
  for (const q of s.questions) {
    if (
      q.title !== undefined &&
      (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 200)
    )
      fail()
    if (
      !s.projects.some((p) => p.id === q.projectId) ||
      !Array.isArray(q.conceptIds) ||
      !Array.isArray(q.suggestions) ||
      typeof q.memo !== 'string' ||
      typeof q.important !== 'boolean' ||
      typeof q.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(q.createdAt)) ||
      !Array.isArray(q.turns) ||
      !q.turns.length
    )
      fail()
    for (const id of q.conceptIds) if (byConcept.get(id)?.projectId !== q.projectId) fail()
    if (q.suggestions.some((v) => typeof v !== 'string')) fail()
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
    }
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
    !['minimal', 'balanced', 'preserve'].includes(s.settings.retention)
  )
    fail()
  if (s.settings.autoTitle !== undefined && typeof s.settings.autoTitle !== 'boolean') fail()
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
  return { version: 2, snapshot: s, images: value.images }
}

import type { Snapshot } from '../preload/personal'

export interface Backup {
  version: 1
  snapshot: Snapshot
  images: Record<string, string>
}
export function validateBackup(input: unknown): Backup {
  const fail = (): never => {
    throw new Error('백업 형식이나 프로젝트 참조가 잘못되었습니다.')
  }
  if (!input || typeof input !== 'object') fail()
  const value = input as Backup
  if (value.version !== 1 || !value.snapshot || !value.images || typeof value.images !== 'object')
    fail()
  const { snapshot: s } = value
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
      q.documents !== undefined &&
      (!Array.isArray(q.documents) ||
        q.documents.length > 5 ||
        q.documents.some(
          (d) =>
            !d ||
            typeof d.name !== 'string' ||
            typeof d.text !== 'string' ||
            d.name.length > 255 ||
            d.text.length > 50000
        ))
    )
      fail()
    if (
      !s.projects.some((p) => p.id === q.projectId) ||
      !Array.isArray(q.conceptIds) ||
      !Array.isArray(q.suggestions)
    )
      fail()
    for (const key of [
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
      !['saved', 'running', 'completed', 'failed', 'cancelled'].includes(q.status) ||
      !['simple', 'complex', 'unknown'].includes(q.complexity)
    )
      fail()
    for (const id of q.conceptIds) if (byConcept.get(id)?.projectId !== q.projectId) fail()
    if (q.suggestions.some((v) => typeof v !== 'string')) fail()
    if (
      q.attachment !== null &&
      (typeof q.attachment !== 'string' ||
        typeof value.images[q.attachment] !== 'string' ||
        !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value.images[q.attachment]))
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
    !['minimal', 'balanced', 'preserve'].includes(s.settings.retention)
  )
    fail()
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
  return value
}

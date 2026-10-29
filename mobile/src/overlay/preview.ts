// Test-build overlay preview: an in-memory hub so the native panel can be exercised without a PC.
// Project IDs match OverlayPlugin.PREVIEW_PROJECTS.
import type { Question, Snapshot, StreamEvent, Turn, TurnState } from '@desktop/preload/personal'
import type { HubClient } from '../hub'
import type { Bootstrap } from './bridge'

const ANSWER =
  '미리보기 답변입니다. 실제 연결에서는 PC의 FASK가 선택한 영역과 필기를 함께 보고 답변합니다.\n\n' +
  '- 질문을 보내면 이렇게 답변이 스트리밍됩니다.\n- 이어서 질문하면 같은 대화에 기록됩니다.'

export function createPreviewClient(boot: Bootstrap): HubClient {
  const data: Snapshot = {
    profiles: [{ id: boot.profileId, name: '미리보기' }],
    activeProfileId: boot.profileId,
    workspaces: [
      { id: 'preview-w1', profileId: boot.profileId, name: '2학기' },
      { id: 'preview-w2', profileId: boot.profileId, name: '개인' }
    ],
    projects: [
      { id: 'preview-1', workspaceId: 'preview-w1', name: '자료구조', description: '' },
      { id: 'preview-2', workspaceId: 'preview-w1', name: '운영체제', description: '' },
      { id: 'preview-3', workspaceId: 'preview-w2', name: '선형대수 스터디', description: '' }
    ],
    concepts: [],
    questions: [],
    settings: {
      endpoint: 'preview',
      hasKey: true,
      model: 'preview-model',
      fastModel: 'preview-model',
      deepModel: 'preview-model',
      models: ['preview-model'],
      routing: 'manual',
      refine: false,
      organize: false,
      memory: false,
      retention: 'balanced',
      autoTitle: false,
      regions: []
    },
    storageBytes: 0
  }
  const streams = new Set<(e: StreamEvent) => void>()
  const changes = new Set<() => void>()
  const changed = (): void => changes.forEach((cb) => cb())
  let seq = 0
  const id = (prefix: string): string => `${prefix}-${++seq}-${Date.now().toString(36)}`

  return {
    snapshot: async () => structuredClone(data),
    create: async (_kind, name, parentId) => {
      const conceptId = id('concept')
      data.concepts.push({ id: conceptId, projectId: parentId ?? '', name, parentId: null, manual: true })
      changed()
      return conceptId
    },
    rename: async () => {},
    remove: async () => {},
    moveQuestion: async (questionId, projectId) => {
      const q = data.questions.find((x) => x.id === questionId)
      if (q) Object.assign(q, { projectId, conceptIds: [], suggestions: [] })
      changed()
    },
    updateQuestion: async (questionId, patch) => {
      const q = data.questions.find((x) => x.id === questionId)
      if (q) Object.assign(q, patch)
      changed()
    },
    editConcept: async () => {},
    mergeConcept: async () => {},
    ask: async (input) => {
      let q: Question | undefined = input.questionId
        ? data.questions.find((x) => x.id === input.questionId)
        : undefined
      if (!q) {
        q = {
          id: id('question'),
          projectId: input.projectId,
          createdAt: new Date().toISOString(),
          title: input.raw.slice(0, 40),
          turns: [],
          conceptIds: [],
          suggestions: [],
          memo: '',
          important: false
        }
        data.questions.unshift(q)
      }
      const turn: Turn = {
        id: id('turn'),
        createdAt: new Date().toISOString(),
        raw: input.raw,
        refined: input.refined ?? '',
        sent: input.refined || input.raw,
        answer: '',
        model: input.model,
        actualModel: input.model,
        status: input.saveOnly ? 'saved' : 'running',
        complexity: 'unknown',
        routingReason: '',
        attachment: null,
        documents: input.documents ?? [],
        error: '',
        revision: 0
      }
      q.turns.push(turn)
      const questionId = q.id
      if (!input.saveOnly) {
        const chunks = ANSWER.match(/[^]{1,12}/g) ?? []
        chunks.forEach((delta, i) =>
          setTimeout(() => {
            turn.answer += delta
            turn.revision++
            const base = { requestId: input.requestId, questionId, turnId: turn.id }
            streams.forEach((cb) => cb({ ...base, revision: turn.revision, delta }))
            if (i === chunks.length - 1) {
              turn.status = 'completed'
              turn.revision++
              streams.forEach((cb) => cb({ ...base, revision: turn.revision, done: true }))
              changed()
            }
          }, 300 + i * 60)
        )
      }
      changed()
      return { questionId, turnId: turn.id }
    },
    cancel: async () => {},
    turnState: async (questionId, turnId): Promise<TurnState> => {
      const t = data.questions.find((q) => q.id === questionId)?.turns.find((x) => x.id === turnId)
      if (!t) throw new Error('질문을 찾을 수 없습니다.')
      return { answer: t.answer, revision: t.revision, status: t.status, error: t.error, actualModel: t.actualModel }
    },
    refine: async (raw) => `${raw.trim()} (미리보기에서 다듬은 질문)`,
    attachment: async () => null,
    clearAttachment: async () => {},
    onStream: (cb) => {
      streams.add(cb)
      return () => streams.delete(cb)
    },
    onChanged: (cb) => {
      changes.add(cb)
      return () => changes.delete(cb)
    },
    address: () => 'preview',
    reconnect: () => {},
    close: () => {
      streams.clear()
      changes.clear()
    }
  }
}

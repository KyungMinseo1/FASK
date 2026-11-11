// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Question, Reference, Snapshot, Turn } from '@desktop/preload/personal'
import { ApiContext } from '@desktop/renderer/src/personal/api'
import OverlayPanel from '../src/overlay/OverlayPanel'
import type { Bootstrap } from '../src/overlay/bridge'

const settings = { model: 'm', models: ['m'], routing: 'manual', refine: false, fastModel: '', deepModel: '' } as never
const REFS: Reference[] = [
  { kind: 'question', id: 'qa', name: 'A' },
  { kind: 'question', id: 'qx', name: 'X' },
  { kind: 'concept', id: 'c1', name: 'C' }
]

const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  raw: `raw ${id}`,
  refined: '',
  sent: `sent ${id}`,
  answer: `answer ${id}`,
  model: 'm',
  actualModel: 'm',
  status: 'completed',
  complexity: 'unknown',
  routingReason: '',
  attachment: null,
  documents: [],
  error: '',
  revision: 1,
  ...extra
})
const question = (id: string, projectId: string, title: string, turns: Turn[]): Question => ({
  id,
  projectId,
  createdAt: turns[0].createdAt,
  title,
  turns,
  conceptIds: [],
  conceptTurns: {},
  extractedTurns: 0,
  suggestions: [],
  memo: '',
  important: false
})

/** qb (the conversation) in p1 refers to qa (p1), qx (p2) and concept c1; `running` leaves its last turn answering. */
function snapshot(running = false): Snapshot {
  const turns = running
    ? [turn('t1', { references: REFS }), turn('t2', { status: 'running', answer: '' })]
    : [turn('t1'), turn('t2', { references: REFS })]
  return {
    profiles: [{ id: 'u', name: 'U' }],
    activeProfileId: 'u',
    workspaces: [{ id: 'w1', profileId: 'u', name: 'W' }],
    projects: [
      { id: 'p1', workspaceId: 'w1', name: 'P1', description: '' },
      { id: 'p2', workspaceId: 'w1', name: 'P2', description: '' }
    ],
    concepts: [],
    relations: [],
    questions: [
      question('qb', 'p1', 'B', turns),
      question('qa', 'p1', 'A', [turn('ta')]),
      question('qx', 'p2', 'X', [turn('tx')])
    ],
    settings,
    storageBytes: 0
  }
}

function mount(running = false) {
  const data = snapshot(running)
  const turnState = async (_q: string, turnId: string) => {
    const t = data.questions.flatMap((q) => q.turns).find((x) => x.id === turnId)
    if (!t) throw new Error('대화 항목을 찾을 수 없습니다.')
    return { answer: t.answer, revision: t.revision, status: t.status, error: t.error, actualModel: t.actualModel }
  }
  const api = {
    snapshot: async () => data,
    onChanged: () => () => {},
    onStream: () => () => {},
    focusQuestion: async () => {},
    turnState,
    create: async () => 'new',
    updateQuestion: async () => {},
    reconnect: () => {},
    address: () => 'https://hub',
    cancel: async () => {}
  } as never
  const call = vi.fn(async (..._args: unknown[]) => ({}))
  const bridge = { call, onPush: () => () => {} } as never
  const boot: Bootstrap = {
    identity: {} as never,
    profileId: 'u',
    projectId: 'p1',
    questionId: 'qb',
    sessionId: 's',
    hasInk: false,
    captureRevision: 0,
    inkRevision: 0,
    mode: 'idle',
    theme: 'light'
  }
  const view = render(
    <ApiContext.Provider value={api}>
      <OverlayPanel bridge={bridge} boot={boot} initial={data} conn={{ state: 'online' } as never} unpaired="" />
    </ApiContext.Provider>
  )
  /** Context-changing bridge calls, in order. */
  const switches = () => call.mock.calls.filter(([op]) => op === 'setProject' || op === 'setQuestion')
  return { ...view, call, switches }
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const $ = (selector: string) => document.querySelector(selector)
const openChip = async (name: string) => {
  const chip = [...document.querySelectorAll<HTMLButtonElement>('.reference-chip')].find((b) => b.textContent === name)
  expect(chip, `chip ${name}`).toBeTruthy()
  await act(async () => fireEvent.click(chip!))
}
const continueShown = async () => {
  await act(async () => fireEvent.click($('.screen-q-ref .reply-button')!))
  await flush()
}

afterEach(cleanup)

describe('OverlayPanel referenced questions', () => {
  it('opens a referenced question read-only over the still-mounted conversation and goes back', async () => {
    mount()
    await flush()
    await openChip('A')
    expect($('.screen-q-ref .question-detail h2')?.textContent).toBe('A')
    expect($('.screen-q-conversation')?.hasAttribute('hidden')).toBe(true)
    expect($('.composer textarea')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('대화로 돌아가기')))
    expect($('.screen-q-conversation')?.hasAttribute('hidden')).toBe(false)
    expect($('.screen-q-ref')).toBeNull()
  })

  it('continues a referenced question of the same project', async () => {
    const { switches } = mount()
    await flush()
    await openChip('A')
    await continueShown()
    expect(switches()).toEqual([['setQuestion', { questionId: 'qa' }]])
    expect($('.screen-q-followup b')?.textContent).toBe('A')
    expect($('.screen-q-ref')).toBeNull()
  })

  it('switches the project first when the referenced question lives in another one', async () => {
    const { switches, call } = mount()
    await flush()
    await openChip('X')
    await continueShown()
    expect(switches()).toEqual([
      ['setProject', { projectId: 'p2' }],
      ['setQuestion', { questionId: 'qx' }]
    ])
    expect($('.screen-q-followup b')?.textContent).toBe('X')
    // contextProblem never saw qx paired with p1.
    expect($('.notice.error')).toBeNull()
    expect(call.mock.calls.some(([op]) => op === 'stop')).toBe(false)
  })

  it('refuses to switch while the conversation is answering', async () => {
    const { switches } = mount(true)
    await flush()
    await openChip('A')
    await continueShown()
    expect($('.screen-q-ref .notice.error')?.textContent).toBe('질문을 보내는 중에는 대화를 바꿀 수 없습니다.')
    expect(switches()).toEqual([])
  })

  it('points concept chips to the phone app', async () => {
    mount()
    await flush()
    await openChip('C')
    expect($('.notice.error')?.textContent).toBe('개념은 폰 앱의 개념 그래프에서 볼 수 있습니다.')
    expect($('.screen-q-ref')).toBeNull()
  })
})

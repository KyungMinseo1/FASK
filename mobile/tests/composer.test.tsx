// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskInput, KnowledgeApi, StreamEvent, TurnState } from '@desktop/preload/personal'
import { ApiContext } from '@desktop/renderer/src/personal/api'
import Composer from '@desktop/renderer/src/personal/Composer'

// Mirrors personal.ts: requestId replays return the same turn only for identical content.
const hashOf = (i: AskInput): string =>
  JSON.stringify([i.projectId, i.questionId ?? '', i.raw, i.refined ?? '', i.model, i.image ?? '', i.documents ?? [], !!i.saveOnly])

function fakeHub() {
  const runs = new Map<string, { hash: string; questionId: string; turnId: string }>()
  const states = new Map<string, TurnState>()
  const streams = new Set<(e: StreamEvent) => void>()
  const asks: AskInput[] = []
  let next = 0
  const hub = {
    asks,
    runs,
    states,
    /** Per-call behaviour: 'ok' replies; 'lost' records then fails; 'reject:msg' fails before recording. */
    plan: [] as string[],
    turnStateFails: false,
    beforeReply: undefined as undefined | ((r: { questionId: string; turnId: string; requestId: string }) => void),
    emit: (e: StreamEvent) => streams.forEach((cb) => cb(e)),
    api: {
      ask: async (input: AskInput) => {
        asks.push(structuredClone(input))
        const mode = hub.plan.shift() ?? 'ok'
        if (mode.startsWith('reject:')) throw new Error(mode.slice(7))
        let run = runs.get(input.requestId)
        if (run && run.hash !== hashOf(input)) throw new Error('같은 요청 ID로 다른 내용을 보낼 수 없습니다.')
        if (!run) {
          next++
          run = { hash: hashOf(input), questionId: input.questionId ?? `q${next}`, turnId: `t${next}` }
          runs.set(input.requestId, run)
          states.set(run.turnId, { answer: '', revision: 0, status: input.saveOnly ? 'saved' : 'running', error: '', actualModel: '' })
        }
        hub.beforeReply?.({ ...run, requestId: input.requestId })
        if (mode === 'lost') throw new Error('PC의 FASK에 연결할 수 없습니다.')
        return { questionId: run.questionId, turnId: run.turnId }
      },
      turnState: async (_q: string, turnId: string) => {
        if (hub.turnStateFails) throw new Error('PC의 FASK에 연결할 수 없습니다.')
        const s = states.get(turnId)
        if (!s) throw new Error('대화 항목을 찾을 수 없습니다.')
        return { ...s }
      },
      onStream: (cb: (e: StreamEvent) => void) => {
        streams.add(cb)
        return () => void streams.delete(cb)
      },
      onChanged: () => () => {},
      cancel: async () => {},
      refine: async (raw: string) => raw
    } as unknown as KnowledgeApi
  }
  return hub
}

const settings = { model: 'm', models: ['m'], routing: 'manual', refine: false, fastModel: '', deepModel: '' } as never

function mount(hub: ReturnType<typeof fakeHub>, props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const view = (p: typeof props) => (
    <ApiContext.Provider value={hub.api}>
      <Composer projectId="p" profileId="u" settings={settings} persistDraft={false} {...p} />
    </ApiContext.Provider>
  )
  const r = render(view(props))
  return { ...r, update: (p: typeof props) => r.rerender(view({ ...props, ...p })) }
}
const type = (text: string) => fireEvent.change(screen.getByLabelText('질문'), { target: { value: text } })
const send = async () => {
  await act(async () => fireEvent.click(screen.getByText('질문하기')))
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const complete = async (hub: ReturnType<typeof fakeHub>, turnId: string, answer: string) => {
  hub.states.set(turnId, { answer, revision: 2, status: 'completed', error: '', actualModel: 'm' })
  const run = [...hub.runs.entries()].find(([, r]) => r.turnId === turnId)!
  await act(async () => hub.emit({ requestId: run[0], questionId: run[1].questionId, turnId, revision: 2, done: true }))
  await flush()
}

afterEach(cleanup)

describe('Composer submission', () => {
  it('keeps capture selected after recovery clears ink without marking the new capture annotated', async () => {
    const hub = fakeHub()
    const onCapture = vi.fn(async () => 'data:image/png;base64,recovered-region')
    const view = mount(hub, { onCapture, hasInk: true })
    view.update({ hasInk: false })
    expect((screen.getByLabelText('화면 캡처 포함') as HTMLInputElement).checked).toBe(true)
    await send()
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(hub.asks[0].image).toBe('data:image/png;base64,recovered-region')
    expect(!!hub.asks[0].annotated).toBe(false)
  })

  it('keeps a stream-adopted turn and its answer when the HTTP reply fails afterwards', async () => {
    const hub = fakeHub()
    hub.plan = ['lost']
    hub.beforeReply = (r) =>
      hub.emit({ requestId: r.requestId, questionId: r.questionId, turnId: r.turnId, revision: 1, delta: '부분 답변' })
    const onCompleted = vi.fn()
    mount(hub, { onCompleted })
    type('질문')
    await send()
    await flush()
    expect(screen.getByText('부분 답변')).toBeTruthy()
    // turnState proved acceptance: no "unknown result" lock remains.
    expect(screen.queryByText('같은 요청 다시 확인')).toBeNull()
    await complete(hub, 't1', '최종 답변')
    expect(screen.getByText('최종 답변')).toBeTruthy()
    expect(onCompleted).toHaveBeenCalledWith('q1', { turnId: 't1', status: 'completed' })
    expect(hub.runs.size).toBe(1)
  })

  it('replays the identical frozen payload after a lost reply and gets the same turn', async () => {
    const hub = fakeHub()
    hub.plan = ['lost', 'ok']
    let captures = 0
    const onCapture = async () => `data:image/jpeg;base64,${++captures}`
    mount(hub, { onCapture, hasInk: true })
    type('원문')
    await send()
    expect(screen.getByText('같은 요청 다시 확인')).toBeTruthy()
    // Locked while unresolved: the draft cannot change the frozen request.
    expect((screen.getByLabelText('질문') as HTMLTextAreaElement).disabled).toBe(true)
    await act(async () => fireEvent.click(screen.getByText('같은 요청 다시 확인')))
    await flush()
    expect(hub.asks).toHaveLength(2)
    expect(hub.asks[1]).toEqual(hub.asks[0])
    expect(captures).toBe(1)
    expect(hub.runs.size).toBe(1)
    expect(screen.queryByText('같은 요청 다시 확인')).toBeNull()
  })

  it('keeps an originally omitted questionId omitted on replay even after the stream named one', async () => {
    const hub = fakeHub()
    hub.plan = ['lost', 'ok']
    hub.turnStateFails = true
    hub.beforeReply = (r) =>
      hub.emit({ requestId: r.requestId, questionId: r.questionId, turnId: r.turnId, revision: 1, delta: '조각' })
    const onTurnIdentified = vi.fn()
    mount(hub, { onTurnIdentified })
    type('새 질문')
    await send()
    await flush()
    expect(screen.getByText('같은 요청 다시 확인')).toBeTruthy()
    hub.turnStateFails = false
    await act(async () => fireEvent.click(screen.getByText('같은 요청 다시 확인')))
    await flush()
    expect(hub.asks[1].questionId).toBeUndefined()
    expect(hub.asks[1]).toEqual(hub.asks[0])
    expect(onTurnIdentified).toHaveBeenCalledTimes(1)
    expect(onTurnIdentified).toHaveBeenCalledWith({ questionId: 'q1', turnId: 't1' })
  })

  it('treats a pre-acceptance validation error as final and keeps the draft editable', async () => {
    const hub = fakeHub()
    hub.plan = ['reject:프로필이 변경되었습니다. 다시 열어 주세요.']
    mount(hub)
    type('초안')
    await send()
    expect(screen.queryByText('같은 요청 다시 확인')).toBeNull()
    const box = screen.getByLabelText('질문') as HTMLTextAreaElement
    expect(box.disabled).toBe(false)
    expect(box.value).toBe('초안')
  })

  it('calls the latest completion handler and reports saved separately from completed', async () => {
    const hub = fakeHub()
    const first = vi.fn(),
      latest = vi.fn()
    const { update } = mount(hub, { onCompleted: first })
    update({ onCompleted: latest })
    type('저장할 질문')
    await act(async () => fireEvent.click(screen.getByText('저장만')))
    await flush()
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledWith('q1', { turnId: 't1', status: 'saved' })
  })

  it('does not misreport an accepted ask when a consumer callback throws', async () => {
    const hub = fakeHub()
    mount(hub, {
      onSaved: () => {
        throw new Error('consumer bug')
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    type('질문')
    await send()
    await flush()
    expect(screen.queryByText('같은 요청 다시 확인')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(hub.asks).toHaveLength(1)
  })
})

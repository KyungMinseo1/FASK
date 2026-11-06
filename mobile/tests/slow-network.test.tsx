// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeApi, Question, Turn } from '@desktop/preload/personal'
import { ApiContext } from '@desktop/renderer/src/personal/api'
import { loadAttachment } from '@desktop/renderer/src/personal/attachment-cache'
import QuestionDetail from '@desktop/renderer/src/personal/QuestionDetail'

// A slow relay: every image takes 3 s and is ~1.5 MB of base64.
const DELAY = 3000
const IMAGE = `data:image/webp;base64,${'A'.repeat(1_500_000)}`
const CHIP = '캡처 이미지 펼쳐 보기'

function slowApi(fail = 0) {
  const calls: string[] = []
  let failures = fail
  const api = {
    attachment: (id: string) => {
      calls.push(id)
      const shouldFail = failures-- > 0
      return new Promise<string | null>((resolve, reject) =>
        setTimeout(() => (shouldFail ? reject(new Error('timeout')) : resolve(IMAGE)), DELAY)
      )
    },
    updateQuestion: async () => {},
    clearAttachment: async () => {},
    cancel: async () => {}
  } as unknown as KnowledgeApi
  return { api, calls }
}

function turn(id: string, attachment: string | null): Turn {
  return {
    id,
    createdAt: '2026-11-04T00:00:00.000Z',
    raw: `질문 ${id}`,
    refined: '',
    sent: `질문 ${id}`,
    answer: `답변 ${id}`,
    model: '',
    actualModel: '',
    status: 'completed',
    complexity: 'simple',
    routingReason: '',
    attachment,
    documents: [],
    error: '',
    revision: 0
  }
}
const question: Question = {
  id: 'q',
  projectId: 'p',
  createdAt: '2026-11-04T00:00:00.000Z',
  turns: [turn('t1', `${'a'.repeat(64)}.jpg`), turn('t2', `${'b'.repeat(64)}.jpg`)],
  conceptIds: [],
  suggestions: [],
  memo: '',
  important: false
}

function mount(api: KnowledgeApi) {
  return render(
    <ApiContext.Provider value={api}>
      <QuestionDetail
        question={question}
        concepts={[]}
        run={async (fn) => {
          await fn()
          return true
        }}
        onClose={() => {}}
        onCreateConcept={async () => {}}
      />
    </ApiContext.Provider>
  )
}
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const images = () => screen.queryAllByAltText('질문에 사용한 캡처') as HTMLImageElement[]

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('captures on a slow network', () => {
  it('loads an image only when its question is expanded, once', async () => {
    const { api, calls } = slowApi()
    mount(api)
    await advance(DELAY * 2)
    expect(calls).toHaveLength(0)
    expect(images()).toHaveLength(0)
    const chips = screen.getAllByText(CHIP)
    expect(chips).toHaveLength(2)

    await act(async () => fireEvent.click(chips[0]))
    expect(screen.getByText('이미지 불러오는 중…')).toBeTruthy()
    expect(calls).toEqual([question.turns[0].attachment])
    await advance(DELAY)
    expect(screen.queryByText('이미지 불러오는 중…')).toBeNull()
    expect(images()).toHaveLength(1)
    expect(images()[0].src).toBe(IMAGE)

    // Folding and reopening reuses the loaded image.
    await act(async () => fireEvent.click(screen.getByText('질문 접기')))
    expect(images()).toHaveLength(0)
    await act(async () => fireEvent.click(screen.getAllByText(CHIP)[0]))
    expect(images()).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('shares concurrent loads and refetches after a failure', async () => {
    const { api, calls } = slowApi(1)
    const first = loadAttachment(api, 'x.jpg')
    const second = loadAttachment(api, 'x.jpg')
    expect(second).toBe(first)
    const settled = first.catch((e: Error) => e.message)
    await advance(DELAY)
    expect(await settled).toBe('timeout')
    expect(calls).toHaveLength(1)

    const retry = loadAttachment(api, 'x.jpg')
    await advance(DELAY)
    expect(await retry).toBe(IMAGE)
    expect(calls).toHaveLength(2)
    expect(await loadAttachment(api, 'x.jpg')).toBe(IMAGE)
    expect(calls).toHaveLength(2)
  })

  it('offers a retry when the image times out', async () => {
    const { api, calls } = slowApi(1)
    mount(api)
    await act(async () => fireEvent.click(screen.getAllByText(CHIP)[1]))
    await advance(DELAY)
    expect(screen.getByText('이미지를 불러오지 못했습니다.')).toBeTruthy()
    expect(images()).toHaveLength(0)

    await act(async () => fireEvent.click(screen.getByText('다시 시도')))
    expect(screen.getByText('이미지 불러오는 중…')).toBeTruthy()
    await advance(DELAY)
    expect(images()).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })
})

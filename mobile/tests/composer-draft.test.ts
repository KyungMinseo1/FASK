// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComposerFiles, ComposerFilesState } from '@desktop/preload/personal'
import {
  clearMemoryDrafts,
  composerDraft,
  whenDraftsSaved,
  type DraftChange
} from '@desktop/renderer/src/personal/composer-draft'

type Write = {
  files: ComposerFiles | null
  expect: ComposerFiles | null | undefined
  answer: (r: { applied: boolean; revision: number }) => void
  answered: boolean
}
type Load = { answer: (s: ComposerFilesState) => void; answered: boolean }

let writes: Write[] = []
let loads: Load[] = []
let notify: ((p: string, proj: string, s: ComposerFilesState) => void) | null = null
let n = 0
let id = ''

const A: ComposerFiles = { image: '', documents: [{ name: 'a.txt', text: 'A' }] }
const B: ComposerFiles = { image: '', documents: [{ name: 'b.txt', text: 'B' }] }
const C: ComposerFiles = { image: '', documents: [{ name: 'c.txt', text: 'C' }] }

const settle = () => new Promise((r) => setTimeout(r, 0))
const push = (state: ComposerFilesState) => notify?.('u', id, state)

beforeEach(() => {
  writes = []
  loads = []
  // Channels live for the page, so every test uses its own project.
  id = `p${++n}`
  window.fask = {
    composerFiles: () => {
      let resolve!: (s: ComposerFilesState) => void
      const promise = new Promise<ComposerFilesState>((r) => (resolve = r))
      const load: Load = {
        answered: false,
        answer: (s) => {
          load.answered = true
          resolve(s)
        }
      }
      loads.push(load)
      return promise
    },
    setComposerFiles: (_p: string, _proj: string, files: ComposerFiles | null, expect?: ComposerFiles | null) => {
      let resolve!: (r: { applied: boolean; revision: number }) => void
      const promise = new Promise<{ applied: boolean; revision: number }>((r) => (resolve = r))
      const write: Write = {
        files,
        expect,
        answered: false,
        answer: (r) => {
          write.answered = true
          resolve(r)
        }
      }
      writes.push(write)
      return promise
    },
    onComposerFiles: (cb: typeof notify) => {
      notify = cb
      return () => {
        notify = null
      }
    }
  } as never
})

afterEach(async () => {
  // Answering one request sends the next queued one, so drain until nothing is left.
  for (;;) {
    const open = [...writes.filter((w) => !w.answered), ...loads.filter((l) => !l.answered)]
    if (!open.length) break
    for (const w of writes) if (!w.answered) w.answer({ applied: true, revision: 999 })
    for (const l of loads) if (!l.answered) l.answer({ files: null, revision: 0 })
    await settle()
  }
  localStorage.clear()
  clearMemoryDrafts()
})

const subscribe = () => {
  const d = composerDraft('persist', 'u', id)
  const changes: DraftChange[] = []
  const off = d.subscribe((c) => changes.push(c))
  return { d, changes, off }
}

describe('composer draft (persist)', () => {
  it('sends one save at a time and folds waiting saves into the newest', async () => {
    const { d } = subscribe()
    d.setFiles(A)
    d.setFiles(B)
    d.setFiles(C)
    expect(writes).toHaveLength(1)
    expect(writes[0].files).toEqual(A)
    writes[0].answer({ applied: true, revision: 1 })
    await settle()
    expect(writes).toHaveLength(2)
    expect(writes[1].files).toEqual(C)
    writes[1].answer({ applied: true, revision: 2 })
    await settle()
    expect(writes).toHaveLength(2)
  })

  it('reads for a remounted composer only after the previous one saved', async () => {
    const { d } = subscribe()
    d.setFiles(A)
    const d2 = composerDraft('persist', 'u', id)
    const changes2: DraftChange[] = []
    d2.subscribe((c) => changes2.push(c))
    d2.refresh()
    expect(loads).toHaveLength(0)
    writes[0].answer({ applied: true, revision: 1 })
    await settle()
    expect(loads).toHaveLength(1)
    loads[0].answer({ files: A, revision: 1 })
    await settle()
    expect(changes2).toEqual([{ files: A }])
  })

  it('skips another window during its own save and reads once the save is answered', async () => {
    const { d, changes } = subscribe()
    d.setFiles(A)
    push({ files: B, revision: 1 })
    expect(changes).toEqual([])
    writes[0].answer({ applied: true, revision: 2 })
    await settle()
    expect(loads).toHaveLength(1)
    loads[0].answer({ files: A, revision: 2 })
    await settle()
    expect(changes).toEqual([{ files: A }])
  })

  it('drops a notice older than the revision already seen', async () => {
    const { d, changes } = subscribe()
    d.setFiles(A)
    writes[0].answer({ applied: true, revision: 5 })
    await settle()
    push({ files: B, revision: 4 })
    expect(changes).toEqual([])
    push({ files: C, revision: 6 })
    expect(changes).toEqual([{ files: C }])
  })

  it('drops a read that a later save overtook', async () => {
    const { d, changes } = subscribe()
    d.refresh()
    d.setFiles(A)
    expect(writes).toHaveLength(0)
    loads[0].answer({ files: B, revision: 1 })
    await settle()
    expect(changes).toEqual([])
    expect(writes).toHaveLength(1)
  })

  it('delivers a read even at the revision already seen', async () => {
    const { d, changes } = subscribe()
    push({ files: B, revision: 3 })
    d.refresh()
    loads[0].answer({ files: B, revision: 3 })
    await settle()
    expect(changes).toEqual([{ files: B }, { files: B }])
  })

  it('whenDraftsSaved waits for every queued save', async () => {
    const { d } = subscribe()
    d.setFiles(A)
    d.setFiles(B)
    let done = false
    void whenDraftsSaved().then(() => {
      done = true
    })
    writes[0].answer({ applied: true, revision: 1 })
    await settle()
    expect(done).toBe(false)
    writes[1].answer({ applied: true, revision: 2 })
    await settle()
    expect(done).toBe(true)
  })

  it('clears text only while unchanged and restores it only while empty', () => {
    const { d } = subscribe()
    const key = `fask:draft:u:${id}`
    const sent = { raw: '보낸 질문', image: '', documents: [] }
    localStorage.setItem(key, '보낸 질문')
    d.clearIfSent(sent)
    expect(localStorage.getItem(key)).toBeNull()
    d.restoreIfEmpty(sent)
    expect(localStorage.getItem(key)).toBe('보낸 질문')
    localStorage.setItem(key, '새 초안')
    d.clearIfSent(sent)
    d.restoreIfEmpty(sent)
    expect(localStorage.getItem(key)).toBe('새 초안')
  })

  it('hands another window’s text change over as the current value', () => {
    const { changes } = subscribe()
    const key = `fask:draft:u:${id}`
    localStorage.setItem(key, '다른 창')
    window.dispatchEvent(Object.assign(new Event('storage'), { key }))
    expect(changes).toEqual([{ raw: '다른 창' }])
  })
})

describe('composer draft (memory)', () => {
  it('stops a handle made before clearMemoryDrafts from writing', () => {
    const m = composerDraft('memory', 'u', id)
    clearMemoryDrafts()
    m.setRaw('늦은 쓰기')
    expect(composerDraft('memory', 'u', id).raw()).toBeNull()
  })
})

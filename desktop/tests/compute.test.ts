import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  COMPUTE_BUSY,
  COMPUTE_DENIED,
  COMPUTE_TOO_LARGE,
  COMPUTE_UNREACHABLE,
  ComputeBroker,
  ComputeRunner,
  MAX_TEXT_CHARS,
  TICKET,
  sanitizeJevRequest,
  sanitizeMessages,
  type ComputeOp,
  type ComputeReply
} from '../src/main/compute'
import { validResponse, type JevRequest } from '../src/main/jev-api'
import type { WireMessage } from '../src/main/local-api'

/** Lets queued replies (promise chains and zero-delay timers) settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function runnerHarness(options: { hang?: boolean } = {}) {
  let clock = 1_000_000
  const calls = { chat: 0, stream: 0, jev: 0 }
  const streamModels: string[] = []
  const jevRequests: JevRequest[] = []
  const replies: ComputeReply[] = []
  const hang = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  const runner = new ComputeRunner(
    {
      chat: async (_role, _messages, signal) => {
        calls.chat++
        if (options.hang) return hang(signal)
        return 'ok'
      },
      stream: async (model, _messages, _effort, signal, delta) => {
        calls.stream++
        streamModels.push(model)
        if (options.hang) return hang(signal)
        delta('x')
      },
      jev: () => async (request) => {
        calls.jev++
        jevRequests.push(request)
        return { model: 'jev', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }
      },
      reply: async (_peerId, reply) => {
        replies.push(reply)
      }
    },
    () => clock
  )
  const total = (): number => calls.chat + calls.stream + calls.jev
  return {
    runner,
    calls,
    streamModels,
    jevRequests,
    replies,
    total,
    tick: (ms: number) => {
      clock += ms
    },
    /** Sends one request and waits for its immediate replies; returns the request id. */
    async send(peerId: string, ticket: string, op: unknown, id = randomUUID()): Promise<string> {
      runner.handle(peerId, { id, ticket, op })
      await settle()
      return id
    },
    repliesFor: (id: string) => replies.filter((r) => r.id === id),
    /** Asserts the request was refused without running anything. */
    denied(id: string, before: number, error = COMPUTE_DENIED): void {
      assert.equal(total(), before, 'no model or Jev call')
      assert.deepEqual(
        replies.filter((r) => r.id === id),
        [{ id, seq: 1, error }]
      )
    }
  }
}

const user = (text: string): WireMessage[] => [{ role: 'user', content: text }]
const fast = (text: string): ComputeOp => ({ kind: 'chat', role: 'fast', messages: user(text) })
const organize = (text: string): ComputeOp => ({ kind: 'chat', role: 'organize', messages: user(text) })
const jevOp = (query: string): ComputeOp => ({
  kind: 'jev',
  request: { state: { query }, questions: { a: { type: 'noul', instructions: 'x' } } }
})

test('compute runner: tickets are bound to their peer and expire', async () => {
  const h = runnerHarness()
  const ticket = h.runner.issue('pa', 'extract')
  assert.match(ticket, TICKET)
  let id = await h.send('pb', ticket, organize('q'))
  h.denied(id, 0)
  id = await h.send('pa', 'A'.repeat(24), organize('q'))
  h.denied(id, 0)

  const expiring = h.runner.issue('pa', 'extract')
  h.tick(10 * 60_000)
  id = await h.send('pa', expiring, organize('q'))
  h.denied(id, 0)

  const revoked = h.runner.issue('pa', 'tidy')
  h.runner.revoke(revoked)
  id = await h.send('pa', revoked, organize('q'))
  h.denied(id, 0)

  const dropped = h.runner.issue('pa', 'tidy')
  h.runner.dropPeer('pa')
  id = await h.send('pa', dropped, organize('q'))
  h.denied(id, 0)

  const soon = h.runner.issue('pa', 'tidy')
  h.runner.expireSoon(soon, 60_000)
  h.tick(61_000)
  id = await h.send('pa', soon, organize('q'))
  h.denied(id, 0)
})

test('compute runner: a repeated request id runs once', async () => {
  const h = runnerHarness()
  const ticket = h.runner.issue('pa', 'tidy')
  const id = randomUUID()
  await h.send('pa', ticket, organize('q'), id)
  await h.send('pa', ticket, organize('q'), id)
  assert.equal(h.calls.chat, 1)
  assert.deepEqual(h.repliesFor(id), [
    { id, seq: 1, ack: true },
    { id, seq: 2, done: true, text: 'ok' }
  ])
})

test('compute runner: ask tickets limit op counts, pin the model and bind the question', async () => {
  const h = runnerHarness()
  const q = '고유값이 뭐야?'
  const ticket = h.runner.issue('pa', 'ask', { model: 'm1', question: q })

  let id = await h.send('pa', ticket, { kind: 'stream', model: 'm1', messages: user('다른 질문') })
  h.denied(id, 0)
  id = await h.send('pa', ticket, jevOp('다른 질문'))
  h.denied(id, 0)
  id = await h.send('pa', ticket, { kind: 'stream', model: 'm2', messages: user(q) })
  h.denied(id, 0)
  id = await h.send('pa', ticket, organize(q))
  h.denied(id, 0)

  const streamed = await h.send('pa', ticket, { kind: 'stream', model: 'm1', messages: user(`${q} 자세히`) })
  assert.deepEqual(h.streamModels, ['m1'])
  assert.deepEqual(h.repliesFor(streamed), [
    { id: streamed, seq: 1, ack: true },
    { id: streamed, seq: 2, delta: 'x' },
    { id: streamed, seq: 3, done: true }
  ])
  id = await h.send('pa', ticket, { kind: 'stream', model: 'm1', messages: user(q) })
  h.denied(id, 1)

  await h.send('pa', ticket, fast(q))
  await h.send('pa', ticket, fast(q))
  assert.equal(h.calls.chat, 2)
  id = await h.send('pa', ticket, fast(q))
  h.denied(id, 3)

  for (let i = 0; i < 64; i++) await h.send('pa', ticket, jevOp(`${q} 단서`))
  assert.equal(h.calls.jev, 64)
  id = await h.send('pa', ticket, jevOp(q))
  h.denied(id, 67)
})

test('compute runner: input budget, image and Jev request shapes', async () => {
  const h = runnerHarness()
  const ticket = h.runner.issue('pa', 'ask', { model: 'm', question: '' })
  await h.send('pa', ticket, { kind: 'stream', model: 'm', messages: user('a'.repeat(MAX_TEXT_CHARS)) })
  await h.send('pa', ticket, fast('b'.repeat(MAX_TEXT_CHARS)))
  assert.equal(h.total(), 2)
  let id = await h.send('pa', ticket, fast('c'))
  h.denied(id, 2)

  const images = h.runner.issue('pa', 'ask', { model: 'm', question: '' })
  const image = (url: string) => ({ type: 'image_url', image_url: { url } })
  id = await h.send('pa', images, {
    kind: 'chat',
    role: 'fast',
    messages: [{ role: 'user', content: [image('https://example.com/a.png')] }]
  })
  h.denied(id, 2)
  const png = 'data:image/png;base64,AAAA'
  id = await h.send('pa', images, {
    kind: 'chat',
    role: 'fast',
    messages: [{ role: 'user', content: [image(png), image(png)] }]
  })
  h.denied(id, 2)

  await h.send('pa', images, {
    kind: 'jev',
    request: { state: { query: 'x' }, questions: { a: { type: 'noul', instructions: 'x' } }, model: 'other', url: 'http://evil' }
  })
  assert.equal(h.jevRequests.length, 1)
  assert.deepEqual(Object.keys(h.jevRequests[0]).sort(), ['questions', 'state'])
})

test('compute runner: at most six requests run per peer, and aborts free them', async () => {
  const h = runnerHarness({ hang: true })
  const ticket = h.runner.issue('pa', 'tidy')
  const ids: string[] = []
  for (let i = 0; i < 6; i++) ids.push(await h.send('pa', ticket, organize('q')))
  assert.equal(h.calls.chat, 6)
  const busy = await h.send('pa', ticket, organize('q'))
  h.denied(busy, 6, COMPUTE_BUSY)

  // Another peer is not affected by pa's load.
  const other = h.runner.issue('pb', 'tidy')
  await h.send('pb', other, organize('q'))
  assert.equal(h.calls.chat, 7)

  h.runner.cancel('pb', { id: ids[0] })
  await settle()
  assert.equal(h.repliesFor(ids[0]).length, 1, "another peer cannot cancel pa's request")
  h.runner.cancel('pa', { id: ids[0] })
  await settle()
  assert.deepEqual(h.repliesFor(ids[0]).at(-1), { id: ids[0], seq: 2, error: '요청을 취소했습니다.' })
  await h.send('pa', ticket, organize('q'))
  assert.equal(h.calls.chat, 8)

  h.runner.abortAll()
  await settle()
  for (const id of ids) assert.ok('error' in h.repliesFor(id).at(-1)!)

  const extract = h.runner.issue('pa', 'extract')
  await h.send('pa', extract, organize('q'))
  const second = await h.send('pa', extract, organize('q'))
  h.denied(second, 9)
  h.runner.abortAll()
})

test('compute runner: a missing Jev key is reported without a call', async () => {
  const replies: ComputeReply[] = []
  const runner = new ComputeRunner({
    chat: async () => '',
    stream: async () => {},
    jev: () => undefined,
    reply: async (_p, r) => {
      replies.push(r)
    }
  })
  const ticket = runner.issue('pa', 'ask', { model: 'm', question: 'q' })
  const id = randomUUID()
  runner.handle('pa', { id, ticket, op: jevOp('q') })
  await settle()
  assert.deepEqual(replies.at(-1), { id, seq: 2, error: 'Jev API 키를 설정해 주세요.' })
})

function brokerHarness(connected = true) {
  const sent: { peerId: string; event: string; data: { id: string } }[] = []
  const broker = new ComputeBroker((peerId, event, data) => {
    sent.push({ peerId, event, data: data as { id: string } })
    return connected
  }, validResponse)
  return { broker, sent }
}
const executor = { kind: 'peer' as const, peerId: 'pa', ticket: 'A'.repeat(24) }

test('compute broker: replies from other peers, replays and finished ids change nothing', async () => {
  const { broker, sent } = brokerHarness()
  const deltas: string[] = []
  const result = broker.run(executor, fast('q'), new AbortController().signal, (d) => deltas.push(d))
  const id = sent[0].data.id
  assert.equal(sent[0].event, 'compute')
  broker.reply('pz', { id, seq: 1, done: true, text: 'forged' })
  broker.reply('pa', { id, seq: 1, delta: 'a' })
  broker.reply('pa', { id, seq: 1, delta: 'replayed' })
  broker.reply('pa', { id, seq: 0, delta: 'older' })
  broker.reply('pa', { id, seq: 2, done: true })
  broker.reply('pa', { id, seq: 3, delta: 'late' })
  assert.deepEqual(await result, { text: 'a' })
  assert.deepEqual(deltas, ['a'])
})

test('compute broker: oversized replies, bad Jev responses, errors, unreachable peers and aborts', async () => {
  const { broker, sent } = brokerHarness()
  const large = broker.run(executor, fast('q'), new AbortController().signal)
  const id = sent[0].data.id
  broker.reply('pa', { id, seq: 1, delta: 'x'.repeat(MAX_TEXT_CHARS + 1) })
  await assert.rejects(large, new RegExp(COMPUTE_TOO_LARGE))
  assert.deepEqual(sent.at(-1), { peerId: 'pa', event: 'compute-cancel', data: { id } })

  const jev = broker.run(executor, jevOp('q'), new AbortController().signal)
  broker.reply('pa', { id: sent.at(-1)!.data.id, seq: 1, done: true, response: { answers: {} } })
  await assert.rejects(jev, /Jev 응답 형식이 잘못되었습니다/)

  const failing = broker.run(executor, fast('q'), new AbortController().signal)
  broker.reply('pa', { id: sent.at(-1)!.data.id, seq: 1, error: 'e'.repeat(1000) })
  await assert.rejects(failing, (e: Error) => e.message === 'e'.repeat(300))

  const controller = new AbortController()
  const aborted = broker.run(executor, fast('q'), controller.signal)
  const abortedId = sent.at(-1)!.data.id
  controller.abort()
  await assert.rejects(aborted, /요청을 취소했습니다/)
  assert.deepEqual(sent.at(-1), { peerId: 'pa', event: 'compute-cancel', data: { id: abortedId } })

  const dropped = broker.run(executor, fast('q'), new AbortController().signal)
  broker.dropPeer('pa')
  await assert.rejects(dropped, new RegExp(COMPUTE_UNREACHABLE))

  const offline = brokerHarness(false)
  await assert.rejects(offline.broker.run(executor, fast('q'), new AbortController().signal), new RegExp(COMPUTE_UNREACHABLE))
})

test('sanitizers rebuild messages and Jev requests and reject anything else', () => {
  assert.deepEqual(sanitizeMessages([{ role: 'user', content: 'hi', name: 'x' }]), [{ role: 'user', content: 'hi' }])
  assert.equal(sanitizeMessages([]), null)
  assert.equal(sanitizeMessages([{ role: 'tool', content: 'x' }]), null)
  assert.equal(sanitizeMessages([{ role: 'user', content: [{ type: 'file', file: {} }] }]), null)
  assert.equal(sanitizeMessages(Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' }))), null)
  assert.equal(sanitizeJevRequest({ state: {}, questions: {} }), null)
  assert.equal(sanitizeJevRequest({ state: {}, questions: { a: { type: 'choice', instructions: 'x', criteria: {} } } }), null)
  assert.deepEqual(
    sanitizeJevRequest({ state: 1, questions: { a: { type: 'noul', instructions: 'x', extra: 1 } }, model: 'y' }),
    { state: 1, questions: { a: { type: 'noul', instructions: 'x' } } }
  )
})

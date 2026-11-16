import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { jevClient, type JevAnswer, type JevCall, type JevRequest } from '../src/main/jev-api'
import { jevRoute, RouteCache } from '../src/main/jev-routing'
import { BATCH_CHARS, BATCH_MAX, jevRecall } from '../src/main/jev-recall'
import type { Project, RouteResult } from '../src/preload/personal'
import { addQuestion, MOVIE_QUERY, movieFixture, withStore } from './jev-fixture'

test('jevClient posts the TypeSafe shape with a Bearer key and maps failures', async () => {
  let mode: 'ok' | '401' | '529' | 'missing' = 'ok'
  let requests = 0
  let seen: {
    method?: string
    url?: string
    auth?: string
    body?: JevRequest & { model: string }
  } = {}
  const server = createServer((req, res) => {
    requests++
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      seen = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(raw)
      }
      if (mode === '401' || mode === '529') return res.writeHead(Number(mode)).end()
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: mode === 'missing' ? {} : { ok: { type: 'noul', noul: 0.7 } },
          usage: { input_tokens: 12, output_tokens: 0 }
        })
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const request: JevRequest = {
    state: 'check',
    questions: { ok: { type: 'noul', instructions: 'ok?' } }
  }
  try {
    const call = jevClient(base, 'test-key')
    const res = await call(request, AbortSignal.timeout(5000))
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/v1/systemone')
    assert.equal(seen.auth, 'Bearer test-key')
    assert.equal(seen.body?.model, 'jev-latest')
    assert.equal(seen.body?.questions.ok.type, 'noul')
    assert.deepEqual(res.answers.ok, { type: 'noul', noul: 0.7 })
    mode = '401'
    await assert.rejects(call(request, AbortSignal.timeout(5000)), /키가 올바르지/)
    mode = '529'
    await assert.rejects(call(request, AbortSignal.timeout(5000)), /한도/)
    mode = 'missing'
    await assert.rejects(call(request, AbortSignal.timeout(5000)), /형식/)
    const before = requests
    await assert.rejects(jevClient(base, '  ')(request, AbortSignal.timeout(5000)), /키를 설정/)
    assert.equal(requests, before)
    await assert.rejects(call(request, AbortSignal.abort()), /취소/)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

const choiceCall =
  (complex: number): JevCall =>
  async () => ({
    model: 'jev-test',
    answers: {
      complexity: {
        type: 'choice',
        choice: '',
        confidence: 1,
        probabilities: { complex, simple: 1 - complex }
      }
    },
    usage: { input_tokens: 0, output_tokens: 0 }
  })

test('jevRoute maps the complex probability to a Jev verdict', async () => {
  const signal = AbortSignal.timeout(1000)
  assert.deepEqual(
    { ...(await jevRoute(choiceCall(0.8), 'q', false, signal)), reason: '' },
    { complexity: 'complex', reason: '', source: 'jev' }
  )
  assert.equal((await jevRoute(choiceCall(0.2), 'q', false, signal)).complexity, 'simple')
})

test('RouteCache shares a draft, retries failures, and evicts the oldest key', async () => {
  const cache = new RouteCache(2)
  const verdict: RouteResult = { complexity: 'simple', reason: 'r', source: 'jev' }
  let runs = 0
  const pending = Promise.withResolvers<RouteResult>()
  const first = cache.route('a', () => {
    runs++
    return pending.promise
  })
  const second = cache.route('a', async () => {
    runs++
    return verdict
  })
  assert.equal(cache.settled('a'), undefined)
  pending.resolve(verdict)
  assert.equal(await first, verdict)
  assert.equal(await second, verdict)
  assert.equal(runs, 1)
  assert.equal(cache.settled('a'), verdict)

  await assert.rejects(cache.route('b', () => Promise.reject(new Error('x'))))
  let retried = 0
  await cache.route('b', async () => (retried++, verdict))
  assert.equal(retried, 1)

  await cache.route('c', async () => verdict) // a, b, c: `a` (least recent) goes
  assert.equal(cache.settled('a'), undefined)
  assert.equal(cache.settled('b'), verdict)
  assert.equal(cache.settled('c'), verdict)
})

interface Rules {
  branch: (b: { name: string }) => number
  leaf: (r: { title?: unknown; branch?: unknown }) => number
  choice: (titles: Record<string, string>) => string
}
/** A fake Jev that records every request and answers by the given rules. */
function fakeJev(rules: Rules): { call: JevCall; calls: JevRequest[] } {
  const calls: JevRequest[] = []
  const call: JevCall = async (req) => {
    calls.push(req)
    const state = req.state as {
      branches?: { label: string; name: string }[]
      records?: { label: string }[]
    }
    const answers: Record<string, JevAnswer> = {}
    for (const [name, q] of Object.entries(req.questions)) {
      if (q.type === 'choice') {
        const best = rules.choice(q.criteria)
        answers[name] = {
          type: 'choice',
          choice: best,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === best ? 1 : 0])
          )
        }
      } else if (state.branches)
        answers[name] = {
          type: 'noul',
          noul: rules.branch(state.branches.find((b) => b.label === name)!)
        }
      else
        answers[name] = {
          type: 'noul',
          noul: rules.leaf(state.records!.find((r) => r.label === name)!)
        }
    }
    return { model: 'jev-test', answers, usage: { input_tokens: 0, output_tokens: 0 } }
  }
  return { call, calls }
}
const records = (req: JevRequest): { label: string; branch: string; title: string }[] =>
  (req.state as { records?: { label: string; branch: string; title: string }[] }).records ?? []
const movieParams = (store: { active: string }, ws: string, budgetChars = 4500) => ({
  profile: store.active,
  scope: 'workspace' as const,
  projectId: 'PM',
  workspaceId: ws,
  questionId: 'Q',
  text: MOVIE_QUERY,
  budgetChars
})

test('jevRecall: stage 1 prunes branches, BM25 joins as keyword search, stage 3 reorders', async () => {
  await withStore(async (store, ws) => {
    movieFixture(store, ws)
    const { call, calls } = fakeJev({
      branch: (b) => (b.name === '영화 노트' ? 0.9 : 0.05),
      leaf: (r) => (String(r.title).includes('메멘토') ? 0.9 : 0.05),
      // M2 is newer, so it leads the leaves; the final comparison prefers M.
      choice: (c) => Object.keys(c).find((k) => c[k].includes('구조')) ?? Object.keys(c)[0]
    })
    const params = movieParams(store, ws)
    const result = await jevRecall(store, params, call, AbortSignal.timeout(5000))
    const first = calls[0].state as Record<string, unknown>
    assert.ok(first.branches && !('records' in first))
    const leafCalls = calls.filter(
      (c) => records(c).length && Object.values(c.questions).every((q) => q.type === 'noul')
    )
    assert.ok(leafCalls.length)
    for (const r of leafCalls.flatMap(records)) {
      assert.notEqual(r.branch, '역사')
      if (r.title.includes('글래디에이터')) assert.equal(r.branch, 'keyword search')
    }
    assert.ok(calls.some((c) => c.questions.best?.type === 'choice'))
    assert.equal(result.references[0].id, 'M')
    assert.ok(!JSON.stringify(calls).includes('현재 질문 고유문구'))
    assert.ok(JSON.stringify(result.context).length <= params.budgetChars)
  })
})

test('jevRecall: nothing above the floors means no context and no final choice', async () => {
  await withStore(async (store, ws) => {
    movieFixture(store, ws)
    const { call, calls } = fakeJev({
      branch: () => 0.05,
      leaf: () => 0.05,
      choice: (c) => Object.keys(c)[0]
    })
    const result = await jevRecall(store, movieParams(store, ws), call, AbortSignal.timeout(5000))
    assert.deepEqual(result.context, [])
    assert.ok(!calls.some((c) => c.questions.best))
  })
})

test('jevRecall: a failing Jev call rejects so the caller falls back', async () => {
  await withStore(async (store, ws) => {
    movieFixture(store, ws)
    await assert.rejects(
      jevRecall(
        store,
        movieParams(store, ws),
        () => Promise.reject(new Error('down')),
        AbortSignal.timeout(5000)
      ),
      /down/
    )
  })
})

test('jevRecall: a small tree skips stage 1 and leaf batches respect count and size caps', async () => {
  await withStore(async (store, ws) => {
    const projectId = store.list<Project>('project')[0].id
    for (let i = 0; i < 120; i++)
      addQuestion(
        store,
        `L${i}`,
        projectId,
        `행렬 분해 질문 ${i} `.repeat(15),
        `LU 분해와 QR 분해 비교 ${i} `.repeat(25)
      )
    const { call, calls } = fakeJev({
      branch: () => 1,
      leaf: () => 0.05,
      choice: (c) => Object.keys(c)[0]
    })
    await jevRecall(
      store,
      {
        profile: store.active,
        scope: 'project',
        projectId,
        workspaceId: ws,
        questionId: 'none',
        text: '행렬 분해',
        budgetChars: 4500
      },
      call,
      AbortSignal.timeout(5000)
    )
    assert.ok(!calls.some((c) => (c.state as Record<string, unknown>).branches))
    const leafCalls = calls.filter((c) => records(c).length)
    assert.ok(leafCalls.length >= 2)
    for (const c of leafCalls) {
      const rs = records(c)
      assert.ok(rs.length <= BATCH_MAX)
      assert.ok(rs.reduce((sum, r) => sum + JSON.stringify(r).length, 0) <= BATCH_CHARS)
    }
  })
})

// Real TypeSafe Jev calls: `TYPESAFE_API_KEY=… npm run test:jev`. The key comes from the shell
// environment only; without it every test is skipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { JEV_BASE_URL, jevClient, type JevCall } from '../src/main/jev-api'
import { jevRoute } from '../src/main/jev-routing'
import { jevRecall } from '../src/main/jev-recall'
import { recallMemory } from '../src/main/knowledge-extract'
import { MOVIE_QUERY, movieFixture, withStore } from './jev-fixture'

const key = process.env.TYPESAFE_API_KEY ?? ''
const skip = key ? false : 'TYPESAFE_API_KEY not set'

/** Counts input tokens across the calls a test makes (output is free). */
function metered(): { call: JevCall; tokens: () => number } {
  const client = jevClient(JEV_BASE_URL.typesafe, key)
  let tokens = 0
  return {
    call: async (request, signal) => {
      const res = await client(request, signal)
      tokens += res.usage.input_tokens
      return res
    },
    tokens: () => tokens
  }
}

test('live: connection check', { skip }, async () => {
  const { call, tokens } = metered()
  const res = await call(
    {
      state: 'FASK connection check',
      questions: { ok: { type: 'noul', instructions: 'This text is a connection check.' } }
    },
    AbortSignal.timeout(15000)
  )
  const ok = res.answers.ok
  assert.equal(ok.type, 'noul')
  assert.ok(ok.type === 'noul' && ok.noul >= 0 && ok.noul <= 1)
  assert.match(res.model, /jev/)
  console.log(`connection: model ${res.model}, ${tokens()} input tokens`)
})

test('live: routing tells a definition from a proof', { skip }, async () => {
  const { call, tokens } = metered()
  const simple = await jevRoute(call, 'ephemeral 뜻이 뭐야?', false, AbortSignal.timeout(15000))
  const complex = await jevRoute(
    call,
    '다익스트라 알고리즘이 음수 가중치에서 실패하는 이유를 증명하고 벨만-포드와 시간복잡도를 비교해줘',
    false,
    AbortSignal.timeout(15000)
  )
  console.log(`routing: ${simple.complexity} / ${complex.complexity}, ${tokens()} input tokens`)
  assert.equal(simple.complexity, 'simple')
  assert.equal(complex.complexity, 'complex')
})

test('live: DecisionRAG finds Memento without a shared keyword', { skip }, async () => {
  await withStore(async (store, ws) => {
    movieFixture(store, ws)
    const params = {
      profile: store.active,
      scope: 'workspace' as const,
      projectId: 'PM',
      workspaceId: ws,
      questionId: 'Q',
      text: MOVIE_QUERY,
      budgetChars: 4500
    }
    const { call, tokens } = metered()
    const result = await jevRecall(store, params, call, AbortSignal.timeout(20000))
    console.log(
      `recall: ${result.references.map((r) => r.name).join(' | ')}; BM25 first: ${
        recallMemory(store, params).references[0]?.name ?? '(none)'
      }; ${tokens()} input tokens`
    )
    assert.match(result.references[0]?.name ?? '', /메멘토/)
  })
})

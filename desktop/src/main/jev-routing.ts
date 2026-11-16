import { createHash } from 'node:crypto'
import type { RouteResult } from '../preload/personal'
import type { JevCall } from './jev-api'

/** Past this the send goes on with the local rule. */
export const JEV_ROUTE_TIMEOUT_MS = 3000
export const JEV_REASON_COMPLEX = 'Jev가 여러 단계의 추론이 필요한 질문으로 판단했습니다.'
export const JEV_REASON_SIMPLE = 'Jev가 짧은 설명·확인으로 충분한 질문으로 판단했습니다.'

export function routeKey(profile: string, text: string, hasImage: boolean): string {
  return createHash('sha256')
    .update(`${profile}\n${hasImage ? 1 : 0}\n${text}`)
    .digest('hex')
}

export async function jevRoute(
  call: JevCall,
  text: string,
  hasImage: boolean,
  signal: AbortSignal
): Promise<RouteResult> {
  const res = await call(
    {
      state: { question: text.slice(0, 4000), imageAttached: hasImage },
      questions: {
        complexity: {
          type: 'choice',
          instructions:
            'A learner asks this question about something on their screen. How much reasoning does a good answer need?',
          criteria: {
            simple:
              'A short explanation, definition, translation, summary, or fact check; a fast model answers it well.',
            complex:
              'A proof, derivation, design, debugging, multi-step analysis, comparison, or optimization; it needs careful multi-step reasoning.'
          }
        }
      }
    },
    signal
  )
  const answer = res.answers.complexity
  const complex = answer?.type === 'choice' ? answer.probabilities.complex : undefined
  if (typeof complex !== 'number' || !Number.isFinite(complex))
    throw new Error('Jev 응답 형식이 잘못되었습니다.')
  return complex >= 0.5
    ? { complexity: 'complex', reason: JEV_REASON_COMPLEX, source: 'jev' }
    : { complexity: 'simple', reason: JEV_REASON_SIMPLE, source: 'jev' }
}

/**
 * Jev verdicts by draft: the debounced preview fills it and the send reuses it, so one draft costs
 * one call. In-flight requests are shared; failures are dropped so the next call retries.
 */
export class RouteCache {
  private readonly entries = new Map<
    string,
    { promise: Promise<RouteResult>; value?: RouteResult }
  >()
  constructor(private readonly max = 100) {}
  route(key: string, run: () => Promise<RouteResult>): Promise<RouteResult> {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.promise
    }
    const entry: { promise: Promise<RouteResult>; value?: RouteResult } = {
      promise: run().then(
        (value) => {
          entry.value = value
          return value
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key)
          throw error
        }
      )
    }
    this.entries.set(key, entry)
    if (this.entries.size > this.max)
      this.entries.delete(this.entries.keys().next().value as string)
    return entry.promise
  }
  settled(key: string): RouteResult | undefined {
    return this.entries.get(key)?.value
  }
}

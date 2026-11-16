import type { JevProvider } from '../preload/personal'
import { t } from '../shared/i18n'

// Fixed hosts: the user only picks a provider, never types a URL. Both serve the TypeSafe
// /v1/systemone request and response shape with a Bearer key.
export const JEV_BASE_URL: Record<JevProvider, string> = {
  typesafe: 'https://api.typesafe.ai',
  openrouter: 'https://openrouter.ai/api'
}
export const JEV_MODEL = 'jev-latest'
export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevRequest {
  state: unknown
  questions: Record<string, JevQuestion>
}
export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number; cost?: number }
}
export type JevCall = (request: JevRequest, signal: AbortSignal) => Promise<JevResponse>

/** No retries: every caller falls back to a local path on failure. */
export function jevClient(baseUrl: string, key: string): JevCall {
  const token = key.trim()
  return async (request, signal) => {
    if (!token) throw new Error('Jev API 키를 설정해 주세요.')
    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/systemone`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: JEV_MODEL, ...request })
      })
    } catch (e) {
      if (signal.aborted) throw new Error('요청을 취소했습니다.')
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
        throw new Error('Jev 응답 시간이 초과되었습니다.')
      throw new Error('Jev API에 연결할 수 없습니다. 네트워크를 확인해 주세요.')
    }
    if (res.status === 401 || res.status === 403) throw new Error('Jev API 키가 올바르지 않습니다.')
    if (res.status === 429 || res.status === 529)
      throw new Error('Jev 요청 한도를 넘었거나 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.')
    if (!res.ok) throw new Error(t('Jev API 오류 ({{status}}).', { status: res.status }))
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new Error('Jev 응답 형식이 잘못되었습니다.')
    }
    if (!validResponse(body, request)) throw new Error('Jev 응답 형식이 잘못되었습니다.')
    return body
  }
}

function validResponse(body: unknown, request: JevRequest): body is JevResponse {
  if (!isObject(body) || !isObject(body.answers)) return false
  const answers = body.answers
  return Object.entries(request.questions).every(([name, question]) => {
    const answer = answers[name]
    if (!isObject(answer) || answer.type !== question.type) return false
    return question.type === 'noul'
      ? typeof answer.noul === 'number' && Number.isFinite(answer.noul)
      : isObject(answer.probabilities)
  })
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

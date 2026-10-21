export function normalizeEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('올바른 로컬 API endpoint를 입력해 주세요.')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('endpoint에는 http(s) 주소와 경로만 입력해 주세요.')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('현재 버전은 localhost, 127.0.0.1, ::1 로컬 endpoint를 지원합니다.')
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|models)$/, '')
  path = path.replace(/(?:\/v1)+$/, '/v1')
  if (!path) path = '/v1'
  url.pathname = path
  return url.toString().replace(/\/$/, '')
}
export type WireMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | { type: string; text?: string; image_url?: { url: string } }[]
}
export async function localModels(endpoint: string, key: string): Promise<string[]> {
  const res = await fetch(`${normalizeEndpoint(endpoint)}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15000),
    redirect: 'error'
  })
  if (!res.ok) throw statusError(res.status)
  const body = (await res.json()) as {
    data?: { id?: string }[]
    models?: { id?: string; slug?: string }[]
  }
  const ids = (body.data ?? body.models ?? [])
    .map((m) => m.id ?? ('slug' in m ? m.slug : ''))
    .filter((id): id is string => typeof id === 'string' && !!id)
  return [...new Set(ids)].sort()
}
function statusError(status: number): Error {
  const hint =
    status === 401 || status === 403
      ? '로컬 접속 키를 확인해 주세요.'
      : status === 404
        ? 'endpoint 또는 모델을 확인해 주세요.'
        : status === 429
          ? '한도에 도달했습니다. 프록시에서 상태를 확인해 주세요.'
          : 'EasyCLIProxyAPI의 실행 상태와 모델 연결을 확인해 주세요.'
  return new Error(`로컬 API 오류 (${status}). ${hint}`)
}
export async function streamChat(
  endpoint: string,
  key: string,
  model: string,
  messages: WireMessage[],
  signal: AbortSignal,
  delta: (text: string, actualModel?: string) => void
): Promise<void> {
  if (!model.trim()) throw new Error('설정에서 사용할 모델을 선택해 주세요.')
  let res: Response
  try {
    res = await fetch(`${normalizeEndpoint(endpoint)}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({ model, messages, stream: true })
    })
  } catch (e) {
    if (signal.aborted) throw new Error('요청을 취소했습니다.')
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      throw new Error('응답 시간이 초과되었습니다. 다시 시도해 주세요.')
    throw new Error(
      '로컬 API에 연결할 수 없습니다. EasyCLIProxyAPI 실행과 endpoint를 확인해 주세요.'
    )
  }
  if (!res.ok) throw statusError(res.status)
  if (!res.body) throw new Error('응답 스트림이 없습니다.')
  const reader = res.body.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    completed = false
  const event = (block: string): void => {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) return
    if (data.trim() === '[DONE]') {
      completed = true
      return
    }
    let item: {
      error?: unknown
      model?: string
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
    }
    try {
      item = JSON.parse(data)
    } catch {
      throw new Error('프록시의 스트림 형식을 읽을 수 없습니다.')
    }
    if (item.error)
      throw new Error(
        '프록시가 추론 오류를 반환했습니다. EasyCLIProxyAPI에서 연결 상태를 확인해 주세요.'
      )
    const choice = item.choices?.[0]
    if (typeof choice?.delta?.content === 'string') delta(choice.delta.content, item.model)
    if (choice?.finish_reason) {
      if (choice.finish_reason === 'length')
        throw new Error('모델의 출력 한도에 도달했습니다. 부분 답변을 저장했습니다.')
      if (!['stop', 'tool_calls'].includes(choice.finish_reason))
        throw new Error('모델이 답변을 완료하지 못했습니다.')
      completed = true
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        event(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
      }
      if (done) {
        if (buffer.trim()) event(buffer)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!completed) throw new Error('완료 신호 없이 연결이 끊겼습니다. 부분 답변을 저장했습니다.')
}
export function recommend(
  raw: string,
  hasImage: boolean
): { complexity: 'simple' | 'complex' | 'unknown'; reason: string } {
  if (!raw.trim())
    return {
      complexity: 'unknown',
      reason: '이미지의 내용을 확인하기 전에는 복잡도를 판단하기 어렵습니다.'
    }
  if (
    /증명|설계|디버깅|분석|비교|최적화|구현|derive|debug|design|analy[sz]e/i.test(raw) ||
    raw.length > 500
  )
    return {
      complexity: 'complex',
      reason: '분석·설계 또는 여러 단계의 설명이 필요한 요청입니다. (로컬 규칙)'
    }
  return {
    complexity: hasImage ? 'unknown' : 'simple',
    reason: hasImage
      ? '이미지 난이도는 로컬 규칙으로 판단하지 않습니다.'
      : '짧은 설명·확인 요청으로 추정했습니다. (로컬 규칙)'
  }
}

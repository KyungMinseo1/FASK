import type { KnowledgeApi } from '../../../preload/personal'

const LIMIT = 40
// Attachment IDs are content hashes, so a cached image never goes stale; only failures are dropped.
const caches = new WeakMap<KnowledgeApi, Map<string, Promise<string | null>>>()

/** Loads an attachment once per API instance; concurrent callers share the request. */
export function loadAttachment(api: KnowledgeApi, id: string): Promise<string | null> {
  let cache = caches.get(api)
  if (!cache) {
    cache = new Map()
    caches.set(api, cache)
  }
  const hit = cache.get(id)
  if (hit) return hit
  const request = api.attachment(id)
  cache.set(id, request)
  const owner = cache
  request.catch(() => {
    if (owner.get(id) === request) owner.delete(id)
  })
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value as string)
  return request
}

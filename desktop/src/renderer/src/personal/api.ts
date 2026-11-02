import { createContext, useContext } from 'react'
import type { KnowledgeApi } from '../../../preload/personal'
import { t } from '../../../shared/i18n'

/** Desktop provides `window.fask`; mobile provides a hub client. */
export const ApiContext = createContext<KnowledgeApi | null>(null)
export function useApi(): KnowledgeApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error(t('ApiContext가 없습니다.'))
  return api
}

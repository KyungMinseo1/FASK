import { useTranslation } from 'react-i18next'
import { i18n, t } from './index'

/** Re-renders on language change; returns the same fallback-to-Korean `t` as the plain module. */
export function useT(): typeof t {
  useTranslation(undefined, { i18n })
  return t
}

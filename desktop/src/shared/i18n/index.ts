// UI language: Korean source strings are the keys; English resources map them to translations.
// A missing English entry falls back to the Korean text, so untranslated strings never break.
import i18next from 'i18next'
import desktop from './en/desktop.json'
import overlay from './en/overlay.json'
import mobile from './en/mobile.json'
import errors from './en/errors.json'
import native from './en/native.json'

export type Language = 'ko' | 'en'
export type LanguagePref = 'system' | Language
export const LANGUAGE_OPTIONS: { value: LanguagePref; label: string }[] = [
  { value: 'system', label: '시스템 설정 따르기' },
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' }
]

const KEY = 'fask:language'
const english: Record<string, string> = { ...desktop, ...overlay, ...mobile, ...errors, ...native }

export const i18n = i18next.createInstance()
void i18n.init({
  lng: 'ko',
  fallbackLng: false,
  resources: { en: { translation: english }, ko: { translation: {} } },
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  initAsync: false
})

/**
 * Translates a Korean source string; `{{name}}` placeholders take values from `vars`.
 * When `n` or `count` is 1, an English `<key>#one` entry (if present) supplies the singular.
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  const n = vars?.count ?? vars?.n
  const singular = `${key}#one`
  const use = n === 1 && i18n.exists(singular) ? singular : key
  return i18n.t(use, { ...vars, defaultValue: key })
}

/** Unset means Korean: the app's source language, and what existing installs already show. */
export function readLanguage(): LanguagePref {
  const value = globalThis.localStorage?.getItem(KEY)
  return value === 'system' || value === 'en' ? value : 'ko'
}

export function resolveLanguage(pref: LanguagePref = readLanguage()): Language {
  if (pref !== 'system') return pref
  return (globalThis.navigator?.language ?? 'ko').toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

function apply(): void {
  const lang = resolveLanguage()
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
  if (globalThis.document) document.documentElement.lang = lang
}

export function setLanguage(pref: LanguagePref): void {
  localStorage.setItem(KEY, pref)
  apply()
}

/** Applies the saved language and follows changes made in other same-origin windows. */
export function initLanguage(): void {
  apply()
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply()
  })
  window.addEventListener('focus', apply)
}

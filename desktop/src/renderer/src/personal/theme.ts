export type ThemePref = 'system' | 'light' | 'dark' | 'sepia' | 'forest' | 'rose'

/** Light-based palettes: `data-theme` stays `light`, `data-palette` swaps the colors on top. */
const PALETTES: readonly ThemePref[] = ['sepia', 'forest', 'rose']
const PREFS: readonly ThemePref[] = ['system', 'light', 'dark', ...PALETTES]
export const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: '시스템 설정 따르기' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
  { value: 'sepia', label: '세피아 (종이)' },
  { value: 'forest', label: '포레스트 (그린)' },
  { value: 'rose', label: '로즈 (핑크)' }
]

const KEY = 'fask:theme'
const dark = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)')

export function readTheme(): ThemePref {
  const value = localStorage.getItem(KEY) as ThemePref | null
  return value && PREFS.includes(value) ? value : 'system'
}

/** The light/dark base of a preference; native surfaces that only know light/dark use this. */
export function themeBase(pref: ThemePref): 'system' | 'light' | 'dark' {
  return PALETTES.includes(pref) ? 'light' : (pref as 'system' | 'light' | 'dark')
}

function apply(): void {
  const pref = readTheme()
  const base = themeBase(pref)
  const root = document.documentElement
  root.dataset.theme = base === 'system' ? (dark().matches ? 'dark' : 'light') : base
  if (PALETTES.includes(pref)) root.dataset.palette = pref
  else delete root.dataset.palette
}

export function setTheme(pref: ThemePref): void {
  localStorage.setItem(KEY, pref)
  apply()
}

/** Applies the saved theme and keeps it in sync with the OS and other same-origin windows. */
export function initTheme(): void {
  apply()
  dark().addEventListener('change', apply)
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply()
  })
  window.addEventListener('focus', apply)
}

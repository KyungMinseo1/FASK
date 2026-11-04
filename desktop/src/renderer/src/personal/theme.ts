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

/** The light/dark base of a preference. */
function themeBase(pref: ThemePref): 'system' | 'light' | 'dark' {
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
  applyFontScale()
  dark().addEventListener('change', apply)
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply()
    if (e.key === FONT_KEY) applyFontScale()
  })
  window.addEventListener('focus', apply)
  window.addEventListener('focus', applyFontScale)
}

export type FontScale = 'small' | 'normal' | 'large' | 'xlarge'
export const FONT_SCALE_OPTIONS: { value: FontScale; label: string; zoom: number }[] = [
  { value: 'small', label: '작게', zoom: 0.9 },
  { value: 'normal', label: '기본', zoom: 1 },
  { value: 'large', label: '크게', zoom: 1.12 },
  { value: 'xlarge', label: '아주 크게', zoom: 1.25 }
]
const FONT_KEY = 'fask:font-scale'

export function readFontScale(): FontScale {
  const value = localStorage.getItem(FONT_KEY)
  return FONT_SCALE_OPTIONS.some((o) => o.value === value) ? (value as FontScale) : 'normal'
}

/** Scales the app UI (not the overlay) through the `--ui-zoom` CSS variable. */
function applyFontScale(): void {
  const zoom = FONT_SCALE_OPTIONS.find((o) => o.value === readFontScale())?.zoom ?? 1
  document.documentElement.style.setProperty('--ui-zoom', String(zoom))
}

export function setFontScale(scale: FontScale): void {
  localStorage.setItem(FONT_KEY, scale)
  applyFontScale()
}

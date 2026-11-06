export type ThemePref = 'system' | 'navy' | 'white' | 'ivory' | 'lavender' | 'night'
type Palette = Exclude<ThemePref, 'system'>

const PREFS: readonly ThemePref[] = ['system', 'navy', 'white', 'ivory', 'lavender', 'night']
export const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: '시스템 설정 따르기' },
  { value: 'navy', label: '네이비' },
  { value: 'white', label: '화이트' },
  { value: 'ivory', label: '아이보리' },
  { value: 'lavender', label: '라벤더' },
  { value: 'night', label: '제트 블랙' }
]

/** Values saved by earlier versions, mapped onto the current themes. */
const LEGACY: Record<string, ThemePref> = {
  light: 'white',
  sepia: 'ivory',
  forest: 'ivory',
  dark: 'night',
  rose: 'lavender'
}

const KEY = 'fask:theme'
const dark = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)')

/** The saved theme; legacy or unknown values are migrated (unknown → navy) and saved back. */
export function readTheme(): ThemePref {
  const value = localStorage.getItem(KEY)
  if (value === null) return 'navy'
  if ((PREFS as readonly string[]).includes(value)) return value as ThemePref
  const migrated = LEGACY[value] ?? 'navy'
  localStorage.setItem(KEY, migrated)
  return migrated
}

/** The palette a preference resolves to; `system` follows the OS between white and night. */
export function resolvePalette(pref: ThemePref): Palette {
  if (pref !== 'system') return pref
  return dark().matches ? 'night' : 'white'
}

function apply(): void {
  const palette = resolvePalette(readTheme())
  const root = document.documentElement
  root.dataset.theme = palette === 'night' ? 'dark' : 'light'
  root.dataset.palette = palette
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

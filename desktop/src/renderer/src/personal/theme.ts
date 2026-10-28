export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'fask:theme'
const dark = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)')

export function readTheme(): ThemePref {
  const value = localStorage.getItem(KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

function apply(): void {
  const pref = readTheme()
  document.documentElement.dataset.theme =
    pref === 'system' ? (dark().matches ? 'dark' : 'light') : pref
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

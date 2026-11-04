import { useEffect, useState } from 'react'

/** Per-device: whether the toggle logo blinks when an answer completes unseen. */
const KEY = 'fask:answer-blink'

export function readAnswerBlink(): boolean {
  return localStorage.getItem(KEY) !== '0'
}

export function setAnswerBlink(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
}

/** Re-reads on `storage` (other windows) and `focus` so the overlay follows Settings. */
export function useAnswerBlink(): boolean {
  const [on, setOn] = useState(readAnswerBlink)
  useEffect(() => {
    const sync = (): void => setOn(readAnswerBlink())
    window.addEventListener('storage', sync)
    window.addEventListener('focus', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('focus', sync)
    }
  }, [])
  return on
}

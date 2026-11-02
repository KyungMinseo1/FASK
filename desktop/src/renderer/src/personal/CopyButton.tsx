import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../shared/i18n/react'

export default function CopyButton({
  text,
  label
}: {
  text: () => string
  label: string
}): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const settle = (next: 'copied' | 'failed'): void => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1500)
  }
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={label}
      onClick={() => {
        navigator.clipboard.writeText(text()).then(
          () => settle('copied'),
          () => settle('failed')
        )
      }}
    >
      {state === 'copied' ? t('복사됨 ✓') : state === 'failed' ? t('복사 실패') : label}
    </button>
  )
}

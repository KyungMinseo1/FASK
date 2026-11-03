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
      className={`copy-button ${state}`}
      aria-label={label}
      title={label}
      onClick={() => {
        navigator.clipboard.writeText(text()).then(
          () => settle('copied'),
          () => settle('failed')
        )
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {state === 'copied' ? (
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        ) : state === 'failed' ? (
          <path d="M7 7l10 10M17 7L7 17" />
        ) : (
          <>
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
          </>
        )}
      </svg>
      <span className="copy-status" role="status">
        {state === 'copied' ? t('복사됨') : state === 'failed' ? t('복사 실패') : ''}
      </span>
    </button>
  )
}

/** The `fask.` logo: lowercase wordmark, only the period takes the theme's `--logo-acc`. */
export function Wordmark({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <span className={`wordmark ${className}`.trim()} aria-label="FASK">
      fask<span className="wordmark-dot">.</span>
    </span>
  )
}

/** The short `f.` mark (overlay toggle, app icon); `dot` overrides the period color (e.g. current pen). */
export function MarkF({ dot, className = '' }: { dot?: string; className?: string }): React.JSX.Element {
  return (
    <span className={`mark-f ${className}`.trim()} aria-hidden="true">
      f<span className="wordmark-dot" style={dot ? { color: dot } : undefined}>.</span>
    </span>
  )
}

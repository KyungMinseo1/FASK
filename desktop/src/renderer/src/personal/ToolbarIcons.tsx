// Overlay toolbar icons. Parts carry classes the stylesheet animates on button hover (.tool-icon-*).
type Kind = 'pen' | 'eraser' | 'clear' | 'question' | 'dashboard' | 'region' | 'project'

const common = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

export function ToolIcon({ kind, ink }: { kind: Kind; ink?: string }): React.JSX.Element {
  switch (kind) {
    case 'pen':
      return (
        <svg {...common} className="tool-icon tool-icon-pen">
          <path className="ink" d="M3.5 20.5c2.2-1.6 3.6-.2 5.4-1.2 1.4-.8 2.2-.3 3.6.4" stroke={ink} />
          <g className="body">
            <path d="M14.8 4.7l4.5 4.5L10 18.5l-5.3.8.8-5.3z" />
            <path d="M12.9 6.6l4.5 4.5" />
          </g>
        </svg>
      )
    case 'eraser':
      return (
        <svg {...common} className="tool-icon tool-icon-eraser">
          <g className="crumbs">
            <path d="M4 21h3" />
            <path d="M9 21h2" />
          </g>
          <g className="body">
            <path d="M8.6 18.5L3.9 13.8a1.6 1.6 0 010-2.3l7.4-7.4a1.6 1.6 0 012.3 0l5.7 5.7a1.6 1.6 0 010 2.3l-6.9 6.9z" />
            <path d="M7.5 7.8l8.7 8.7" />
          </g>
        </svg>
      )
    case 'clear':
      return (
        <svg {...common} className="tool-icon tool-icon-clear">
          <g className="lid">
            <path d="M4 6.5h16" />
            <path d="M9.5 6.5V4.8c0-.7.5-1.3 1.2-1.3h2.6c.7 0 1.2.6 1.2 1.3v1.7" />
          </g>
          <path d="M6 6.5l.9 12.4c.1 1 .9 1.6 1.8 1.6h6.6c.9 0 1.7-.6 1.8-1.6L18 6.5" />
          <path className="line" d="M10 10.5v6" />
          <path className="line" d="M14 10.5v6" />
        </svg>
      )
    case 'question':
      return (
        <svg {...common} className="tool-icon tool-icon-question">
          <path
            className="bubble"
            d="M12 3.5c4.7 0 8.5 3.2 8.5 7.3S16.7 18 12 18c-1 0-1.9-.1-2.8-.4L4.5 20l1.2-3.6C4.3 15 3.5 13 3.5 10.8 3.5 6.7 7.3 3.5 12 3.5z"
          />
          <path className="mark" d="M10 9.2a2 2 0 113 1.7c-.6.4-1 .8-1 1.5" />
          <circle className="dot" cx="12" cy="14.9" r=".4" fill="currentColor" />
        </svg>
      )
    case 'dashboard':
      return (
        <svg {...common} className="tool-icon tool-icon-dashboard">
          <rect className="tile t1" x="3.5" y="3.5" width="7" height="7" rx="1.8" />
          <rect className="tile t2" x="13.5" y="3.5" width="7" height="7" rx="1.8" />
          <rect className="tile t3" x="3.5" y="13.5" width="7" height="7" rx="1.8" />
          <rect className="tile t4" x="13.5" y="13.5" width="7" height="7" rx="1.8" />
        </svg>
      )
    case 'region':
      return (
        <svg {...common} className="tool-icon tool-icon-region">
          <path className="corner c1" d="M3.5 8.5v-3a2 2 0 012-2h3" />
          <path className="corner c2" d="M15.5 3.5h3a2 2 0 012 2v3" />
          <path className="corner c3" d="M20.5 15.5v3a2 2 0 01-2 2h-3" />
          <path className="corner c4" d="M8.5 20.5h-3a2 2 0 01-2-2v-3" />
          <circle className="focus" cx="12" cy="12" r="2.2" />
        </svg>
      )
    case 'project':
      return (
        <svg {...common} className="tool-icon tool-icon-project">
          <path className="layer bottom" d="M3.5 15.5L12 20l8.5-4.5" />
          <path className="layer middle" d="M3.5 12L12 16.5l8.5-4.5" />
          <path className="layer top" d="M12 3.5L20.5 8 12 12.5 3.5 8z" />
        </svg>
      )
  }
}

// The app's single SVG icon set (desktop and mobile). Stroke icons on a 24px grid, colored by currentColor.
const PATHS = {
  pen: <path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" />,
  eraser: <path d="M8 20h12M5 15l8-8 5 5-6 6H9z" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />,
  ask: (
    <>
      <path d="M5 5h14v10H10l-5 4z" />
      <path d="M10 9.5a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.3" />
    </>
  ),
  dashboard: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  capture: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />,
  project: (
    <>
      <path d="M12 4l8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 16l8 4 8-4" />
    </>
  ),
  workspace: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M10 10v10" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  up: <path d="M6 15l6-6 6 6" />,
  right: <path d="M9 6l6 6-6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  bell: <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  star: <path d="M12 4l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  move: (
    <>
      <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M10 13h6M13.5 10.5L16 13l-2.5 2.5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clip: <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" />,
  reply: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h10a6 6 0 0 1 6 6v1" />
    </>
  ),
  box: <rect x="5" y="5" width="14" height="14" rx="2" />,
  boxChecked: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  arrowUp: <path d="M12 19V6M6 12l6-6 6 6" />,
  arrowDown: <path d="M12 5v13M6 12l6 6 6-6" />,
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r=".8" />
      <circle cx="4.5" cy="12" r=".8" />
      <circle cx="4.5" cy="18" r=".8" />
    </>
  ),
  foldIn: <path d="M7 20l5-5 5 5M7 4l5 5 5-5" />,
  foldOut: <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />,
  more: (
    <>
      <circle cx="12" cy="5.5" r=".8" />
      <circle cx="12" cy="12" r=".8" />
      <circle cx="12" cy="18.5" r=".8" />
    </>
  ),
  note: (
    <>
      <path d="M6 4h9l4 4v12H6z" />
      <path d="M14 4v5h5M9 13h7M9 16.5h5" />
    </>
  ),
  export: (
    <>
      <path d="M12 4v11M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 14v5h14v-5" />
    </>
  ),
  resize: <path d="M20 10L10 20M20 15l-5 5" />,
  refine: (
    <path d="M4 20l9-9M14 4v3M14 11v3M10.5 7.5h-3M20.5 7.5h-3M17 4.5l-1.5 1.5M17 10.5L15.5 9" />
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l2 2" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M20 16l-5-5-7 8" />
    </>
  ),
  file: (
    <>
      <path d="M6 4h9l4 4v12H6z" />
      <path d="M14 4v5h5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8c-2.2-2.3-3.2-5-3.2-8s1-5.7 3.2-8z" />
    </>
  ),
  device: (
    <>
      <rect x="5" y="5" width="14" height="10" rx="1.5" />
      <path d="M3 19h18" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5V7M15 3.5V7" />
      <path d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16v4.5" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5C10.3 5.2 8 4.5 4 4.5v13c4 0 6.3.7 8 2 1.7-1.3 4-2 8-2v-13c-4 0-6.3.7-8 2z" />
      <path d="M12 6.5v13" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" />
    </>
  ),
  contrast: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  devices: (
    <>
      <rect x="2.5" y="5" width="13" height="9.5" rx="1.5" />
      <path d="M6 19h6M9 14.5V19" />
      <rect x="17" y="9" width="4.5" height="10" rx="1.2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  /* Model roles: answering, light work, deliberate reasoning, organizing into a tree. */
  modelBase: (
    <>
      <path d="M6.5 4.5h11a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2h-7l-4 3.5V16a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z" />
      <path d="M8.5 9h7M8.5 12h4.5" />
    </>
  ),
  modelFast: <path d="M13 3 5.5 13H11l-1 8 7.5-10H12z" />,
  modelDeep: (
    <>
      <circle cx="12" cy="4.5" r="2" />
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="12" cy="19.5" r="2" />
      <path d="M10.7 6 7.3 10.5M13.3 6l3.4 4.5M7.3 13.5l3.4 4.5M16.7 13.5 13.3 18" />
    </>
  ),
  modelOrganize: (
    <>
      <rect x="9" y="3.5" width="6" height="4.5" rx="1.2" />
      <path d="M12 8v3.5M6 11.5h12M6 11.5V15M12 11.5V15M18 11.5V15" />
      <rect x="3.5" y="15" width="5" height="4.5" rx="1.2" />
      <rect x="9.5" y="15" width="5" height="4.5" rx="1.2" />
      <rect x="15.5" y="15" width="5" height="4.5" rx="1.2" />
    </>
  )
} as const

export type IconName = keyof typeof PATHS

/** One icon from the set; size defaults to 16px, `fill` is used for the filled star. */
export function Icon({
  name,
  size = 16,
  fill = 'none',
  className
}: {
  name: IconName
  size?: number
  fill?: string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

/** 12px select/disclosure chevron (stroke 1.5, 0.7 opacity via CSS). */
export function Chevron({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className ? `chev ${className}` : 'chev'} width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M3 4.5 6 7.5 9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

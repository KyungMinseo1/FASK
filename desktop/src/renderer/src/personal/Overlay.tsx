import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useSearchParams } from 'react-router'
import { eraseAt, PEN_COLORS, redraw, type Stroke } from './strokes'
import Composer from './Composer'
import ProjectPicker from './ProjectPicker'
import { ToolIcon } from './ToolbarIcons'
import { errorText, useSnapshot } from './common'
import './personal.css'

const ANCHOR_W = 64,
  ANCHOR_H = 58
/** Matches `.overlay-project-picker` max-height. */
const PICKER_MAX_H = 360
/** Elements that must receive clicks instead of passing them to the background app. */
const HIT_SELECTOR = '.overlay-toolbar,.toolbar-tools,.overlay-panel,.overlay-project-picker'

export default function Overlay(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const projectId = params.get('project') || '',
    profileId = params.get('profile') || ''
  const { data, error, refresh } = useSnapshot()
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'idle' | 'pen' | 'eraser'>('idle'),
    [panel, setPanel] = useState(params.get('panel') === '1')
  const [picker, setPicker] = useState<{ top: number; left?: number; right?: number } | null>(
    null
  )
  const [composerLock, setComposerLock] = useState(false)
  const switchBlocked = panel && composerLock
  const [strokes, setStrokes] = useState<Stroke[]>([]),
    [size, setSize] = useState({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
  const canvas = useRef<HTMLCanvasElement>(null),
    drawing = useRef<Stroke | null>(null)
  const geometryKey = `fask:geometry:${profileId}:${innerWidth}x${innerHeight}`
  const savedPosition = (
    key: string,
    fallback: { x: number; y: number }
  ): { x: number; y: number } => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null')
      if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) return value
    } catch {
      /* Restore defaults when storage is invalid. */
    }
    return fallback
  }
  const [position, setPosition] = useState(() =>
    savedPosition(`${geometryKey}:panel`, { x: Math.max(10, innerWidth - 520), y: 64 })
  )
  const [toolbar, setToolbar] = useState(() =>
    savedPosition(`${geometryKey}:toolbar`, {
      x: innerWidth - 82,
      y: Math.max(8, innerHeight / 2 - 240)
    })
  )
  const edgeOf = (y: number): 'top' | 'bottom' =>
    y + ANCHOR_H / 2 > innerHeight / 2 ? 'bottom' : 'top'
  const [edge, setEdge] = useState<'top' | 'bottom'>(() => edgeOf(toolbar.y))
  const toolbarMoving = useRef<{
    x: number
    y: number
    left: number
    top: number
    moved: boolean
    lastY: number
  } | null>(null)
  const collapsedKey = `fask:toolbar-collapsed:${profileId}`
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapsedKey) === '1')
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef<number>(0)
  useEffect(() => {
    localStorage.setItem(collapsedKey, collapsed ? '1' : '0')
  }, [collapsedKey, collapsed])
  const penColorKey = `fask:pen-color:${profileId}`
  const [penColor, setPenColor] = useState<string>(() => {
    const saved = localStorage.getItem(penColorKey)
    return saved && (PEN_COLORS as readonly string[]).includes(saved) ? saved : PEN_COLORS[0]
  })
  useEffect(() => {
    localStorage.setItem(penColorKey, penColor)
  }, [penColorKey, penColor])
  const [resetCount, setResetCount] = useState(0)
  const recent = data?.questions.find((q) => q.id === data.recentQuestions?.[projectId])
  const questionId = recent?.id
  const scrollKey = `fask:panel-scroll:${profileId}`
  const conversationKey = `${projectId}:${questionId ?? ''}`
  const panelContent = useRef<HTMLDivElement>(null)
  const restored = useRef(false)
  // The panel unmounts while closed; restore its last scroll once content (Composer) exists.
  useLayoutEffect(() => {
    if (!panel) {
      restored.current = false
      return
    }
    if (!data || restored.current || !panelContent.current) return
    restored.current = true
    try {
      const saved = JSON.parse(localStorage.getItem(scrollKey) ?? 'null') as {
        key?: string
        top?: number
      } | null
      if (saved?.key === conversationKey && Number.isFinite(saved.top))
        panelContent.current.scrollTop = saved.top as number
    } catch {
      // Corrupt entry: start at the top.
    }
  }, [panel, data, conversationKey, scrollKey])
  const west = toolbar.x + 32 >= innerWidth / 2
  const north = edge === 'bottom'
  const corner = `${north ? 'n' : 's'}${west ? 'w' : 'e'}`
  useEffect(() => {
    localStorage.setItem(`${geometryKey}:panel`, JSON.stringify(position))
  }, [geometryKey, position])
  useEffect(() => {
    localStorage.setItem(`${geometryKey}:toolbar`, JSON.stringify(toolbar))
  }, [geometryKey, toolbar])
  const panelSizeKey = `fask:panel-size:${profileId}`
  const [panelSize, setPanelSize] = useState(() => {
    let saved: { width?: number; height?: number } = {}
    try {
      saved = JSON.parse(localStorage.getItem(panelSizeKey) || '{}')
    } catch {
      /* Use the default geometry. */
    }
    return {
      width: Math.min(innerWidth - 16, Math.max(320, Number(saved.width) || 440)),
      height: Math.min(innerHeight - 16, Math.max(260, Number(saved.height) || 600))
    }
  })
  const [panelInteraction, setPanelInteraction] = useState(false)
  const visiblePosition = {
    x: Math.max(8, Math.min(position.x, innerWidth - panelSize.width - 8)),
    y: Math.max(8, Math.min(position.y, innerHeight - panelSize.height - 8))
  }
  const resizing = useRef<{
    x: number
    y: number
    width: number
    height: number
    left: number
    top: number
    west: boolean
    north: boolean
  } | null>(null)
  const moving = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => {
    localStorage.setItem(panelSizeKey, JSON.stringify(panelSize))
  }, [panelSizeKey, panelSize])
  useLayoutEffect(() => {
    setToolbar((p) => {
      const next = {
        x: Math.max(8, Math.min(p.x, innerWidth - ANCHOR_W - 8)),
        y: Math.max(8, Math.min(p.y, innerHeight - ANCHOR_H - 8))
      }
      setEdge(edgeOf(next.y))
      return next
    })
  }, [size])
  useEffect(() => {
    const targets = [document.body, document.documentElement, document.getElementById('root')]
    for (const element of targets) if (element) element.style.background = 'transparent'
    const reset = (): void => {
      setMode('idle')
      drawing.current = null
      setPanelInteraction(false)
      resizing.current = null
      moving.current = null
      toolbarMoving.current = null
      setPeek(false)
      setPicker(null)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') reset()
    }
    const resize = (): void => {
      setSize({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
      setPicker(null)
    }
    window.addEventListener('keydown', key)
    window.addEventListener('resize', resize)
    const off = window.fask.onEscape(reset)
    const offOutside = window.fask.onOutsideClick(() => {
      reset()
      setPanel(false)
    })
    const offToggle = window.fask.onTogglePanel(() => {
      setMode('idle')
      setPanel((p) => !p)
      drawing.current = null
    })
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', resize)
      off()
      offToggle()
      offOutside()
      clearTimeout(peekTimer.current)
    }
  }, [])
  useLayoutEffect(() => {
    const update = (): void => {
      const regions = [...document.querySelectorAll(HIT_SELECTOR)].map(
        (el) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
      )
      // The popover holds focus like the panel, so a background click blurs and closes it.
      void window.fask
        .overlayRegions(mode !== 'idle' || panelInteraction, regions, panel || !!picker)
        .catch(() => {})
    }
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    })
    document.querySelectorAll(HIT_SELECTOR).forEach((el) => observer.observe(el))
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [mode, panel, position, toolbar, size, panelSize, panelInteraction, collapsed, peek, edge, picker])
  useEffect(() => {
    if (!picker) return
    const close = (e: Event): void => {
      if (!(e.target as Element).closest('.overlay-project-picker,.toolbar-project')) setPicker(null)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [picker])
  const paint = (list: Stroke[]): void => {
    const ctx = canvas.current?.getContext('2d')
    if (ctx) redraw(ctx, list, size.width, size.height)
  }
  useEffect(() => {
    if (!canvas.current) return
    canvas.current.width = Math.round(size.width * size.dpr)
    canvas.current.height = Math.round(size.height * size.dpr)
    canvas.current.getContext('2d')?.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
    const ctx = canvas.current.getContext('2d')
    if (ctx) redraw(ctx, strokes, size.width, size.height)
  }, [size, strokes])
  const down = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (mode === 'idle') return
    if (e.button === 2) {
      exitDrawing()
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (mode === 'pen') {
      drawing.current = { points: [{ x: e.clientX, y: e.clientY }], color: penColor }
      paint([...strokes, drawing.current])
    } else setStrokes((s) => eraseAt(s, { x: e.clientX, y: e.clientY }))
  }
  const move = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (mode !== 'idle' && e.button === 2) {
      exitDrawing()
      return
    }
    if (mode === 'pen' && drawing.current) {
      drawing.current.points.push({ x: e.clientX, y: e.clientY })
      paint([...strokes, drawing.current])
    }
    if (mode === 'eraser' && e.buttons & 1)
      setStrokes((s) => eraseAt(s, { x: e.clientX, y: e.clientY }))
  }
  const up = (): void => {
    if (drawing.current) {
      const stroke = drawing.current
      setStrokes((s) => [...s, stroke])
      drawing.current = null
    }
  }
  /** Commits any stroke in progress, then hands clicks back to the background app. */
  const exitDrawing = (): void => {
    up()
    setMode('idle')
  }
  const project = data?.projects.find((p) => p.id === projectId)
  const region = data?.settings.regions.find((r) => r.displayId === data.settings.displayId)
  const switchProject = (id: string): void => {
    setPicker(null)
    if (id === projectId || switchBlocked) return
    setNotice('')
    void window.fask
      .activateProject(id)
      .then(() => {
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev)
            next.set('project', id)
            return next
          },
          { replace: true }
        )
        setMode('idle')
        setPanel(true)
      })
      .catch((e) => {
        setNotice(errorText(e))
        setPanel(true)
      })
  }
  return (
    <div className="personal-overlay" onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvas}
        style={{
          position: 'absolute',
          inset: 0,
          width: size.width,
          height: size.height,
          cursor: mode === 'idle' ? 'default' : 'crosshair',
          touchAction: 'none'
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      {mode !== 'idle' && region && (
        <div
          className="overlay-region"
          style={{
            left: `${region.rect.x * 100}%`,
            top: `${region.rect.y * 100}%`,
            width: `${region.rect.width * 100}%`,
            height: `${region.rect.height * 100}%`
          }}
        >
          <span>이 영역 안쪽만 캡처 · 우클릭/Esc로 배경 앱 사용</span>
        </div>
      )}
      <div
        className={`overlay-toolbar edge-${edge} ${west ? 'label-left' : 'label-right'} ${collapsed ? 'collapsed' : ''} ${collapsed && (peek || picker) ? `peek ${north ? 'up' : 'down'}` : ''}`}
        style={{
          left: toolbar.x,
          top: edge === 'top' ? toolbar.y : 'auto',
          bottom: edge === 'bottom' ? innerHeight - toolbar.y - ANCHOR_H : 'auto',
          right: 'auto',
          transform: 'none',
          ['--tools-max' as string]: `${edge === 'top' ? innerHeight - toolbar.y - ANCHOR_H - 12 : toolbar.y - 12}px`
        }}
        onPointerEnter={() => {
          clearTimeout(peekTimer.current)
          if (collapsed && !toolbarMoving.current) setPeek(true)
        }}
        onPointerLeave={() => {
          clearTimeout(peekTimer.current)
          peekTimer.current = window.setTimeout(() => setPeek(false), 150)
        }}
      >
        <button
          className="toolbar-drag-handle"
          aria-label="토글 접기/펼치기"
          aria-expanded={!collapsed}
          title="클릭: 접기/펼치기 · 드래그: 이동"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            toolbarMoving.current = {
              x: e.clientX,
              y: e.clientY,
              left: toolbar.x,
              top: toolbar.y,
              moved: false,
              lastY: toolbar.y
            }
            setPeek(false)
            setPanelInteraction(true)
          }}
          onPointerMove={(e) => {
            const start = toolbarMoving.current
            if (!start) return
            const dx = e.clientX - start.x,
              dy = e.clientY - start.y
            if (!start.moved && Math.hypot(dx, dy) < 4) return
            start.moved = true
            const nx = Math.max(8, Math.min(innerWidth - ANCHOR_W - 8, start.left + dx)),
              ny = Math.max(8, Math.min(innerHeight - ANCHOR_H - 8, start.top + dy))
            start.lastY = ny
            setToolbar({ x: nx, y: ny })
          }}
          onPointerUp={() => {
            const start = toolbarMoving.current
            if (start && !start.moved) {
              setCollapsed((c) => !c)
              setPeek(false)
            } else if (start) setEdge(edgeOf(start.lastY))
            toolbarMoving.current = null
            setPanelInteraction(false)
          }}
          onPointerCancel={() => {
            const start = toolbarMoving.current
            if (start?.moved) setEdge(edgeOf(start.lastY))
            toolbarMoving.current = null
            setPanelInteraction(false)
          }}
        >
          <b>
            f<span>{project?.name || 'FASK'}</span>
          </b>
        </button>
        <div className="toolbar-tools">
        <button
          className={mode === 'pen' ? 'active' : ''}
          title="펜 · 우클릭/Esc로 배경 앱 조작"
          onClick={() => {
            setMode('pen')
            setPanel(false)
          }}
        >
          <ToolIcon kind="pen" ink={penColor} />
          <small>펜</small>
        </button>
        {mode === 'pen' && (
          <div className="pen-colors" role="radiogroup" aria-label="펜 색상">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={c === penColor}
                aria-label={c}
                className={c === penColor ? 'selected' : ''}
                style={{ background: c }}
                onClick={() => setPenColor(c)}
              />
            ))}
          </div>
        )}
        <button
          className={mode === 'eraser' ? 'active' : ''}
          title="지우개 · 우클릭/Esc로 배경 앱 조작"
          onClick={() => {
            setMode('eraser')
            setPanel(false)
          }}
        >
          <ToolIcon kind="eraser" />
          <small>지우개</small>
        </button>
        <button onClick={() => setStrokes([])}>
          <ToolIcon kind="clear" />
          <small>모두 지우기</small>
        </button>
        <hr />
        <button
          className={`question-trigger ${panel ? 'active' : ''}`}
          aria-expanded={panel}
          onClick={() => {
            setPanel((s) => !s)
            setMode('idle')
          }}
        >
          <ToolIcon kind="question" />
          <small>질문</small>
        </button>
        <button onClick={() => void window.fask.showDashboard()}>
          <ToolIcon kind="dashboard" />
          <small>대시보드</small>
        </button>
        <button
          onClick={() => {
            setNotice('')
            void window.fask.editOverlayRegion().catch((e) => {
              setNotice(errorText(e))
              setPanel(true)
            })
          }}
        >
          <ToolIcon kind="region" />
          <small>캡처 영역</small>
        </button>
        <hr />
        <button
          className={`toolbar-project ${picker ? 'active' : ''}`}
          aria-expanded={!!picker}
          title={`프로젝트 바꾸기 · 현재: ${project?.name ?? ''}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setPicker((p) =>
              p
                ? null
                : {
                    top: Math.max(8, Math.min(r.top, innerHeight - 8 - PICKER_MAX_H)),
                    ...(west ? { right: innerWidth - r.left + 8 } : { left: r.right + 8 })
                  }
            )
          }}
        >
          <ToolIcon kind="project" />
          <small>프로젝트</small>
        </button>
        </div>
      </div>
      {picker && data && (
        <div
          className="overlay-project-picker"
          style={{ top: picker.top, left: picker.left ?? 'auto', right: picker.right ?? 'auto' }}
        >
          <ProjectPicker
            workspaces={data.workspaces}
            projects={data.projects}
            currentId={projectId}
            disabledReason={
              switchBlocked ? '질문을 보내는 중에는 프로젝트를 바꿀 수 없습니다.' : undefined
            }
            onSelect={switchProject}
          />
        </div>
      )}
      {panel && (
        <section
          className="overlay-panel"
          aria-label="질문 창"
          style={{
            left: visiblePosition.x,
            top: visiblePosition.y,
            width: panelSize.width,
            height: panelSize.height
          }}
        >
          <header
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              e.currentTarget.setPointerCapture(e.pointerId)
              setPanelInteraction(true)
              moving.current = {
                x: e.clientX,
                y: e.clientY,
                left: visiblePosition.x,
                top: visiblePosition.y
              }
            }}
            onPointerMove={(e) => {
              const d = moving.current
              if (d)
                setPosition({
                  x: Math.max(
                    0,
                    Math.min(innerWidth - panelSize.width - 8, d.left + e.clientX - d.x)
                  ),
                  y: Math.max(
                    0,
                    Math.min(innerHeight - panelSize.height - 8, d.top + e.clientY - d.y)
                  )
                })
            }}
            onPointerUp={() => {
              moving.current = null
              setPanelInteraction(false)
            }}
            onPointerCancel={() => {
              moving.current = null
              setPanelInteraction(false)
            }}
          >
            <div>
              <span className="eyebrow">ASK IN CONTEXT</span>
              <b>{project?.name || '화면 질문'}</b>
            </div>
            <button onClick={() => setPanel(false)}>접기 ×</button>
          </header>
          <div
            className="overlay-panel-content"
            ref={panelContent}
            onScroll={(e) =>
              localStorage.setItem(
                scrollKey,
                JSON.stringify({ key: conversationKey, top: e.currentTarget.scrollTop })
              )
            }
          >
            <small className="overlay-capture-note">
              {region ? '설정한 영역만 캡처' : '영역 미설정 · 전체 모니터 캡처'} · 캡처 포함을
              선택하면 질문 전송 시 촬영합니다.
            </small>
            {data && (
              <Composer
                key={`${projectId}:${resetCount}`}
                projectId={projectId}
                profileId={profileId}
                settings={data.settings}
                questionId={questionId}
                recentQuestion={recent}
                hasInk={strokes.length > 0}
                onCapture={() =>
                  window.fask.captureQuestion(
                    strokes.length ? canvas.current?.toDataURL('image/png') : undefined
                  )
                }
                onCompleted={() => {
                  setStrokes([])
                }}
                onInteractionState={(s) => setComposerLock(s.busy || s.unresolved)}
              />
            )}
            {questionId && (
              <button
                className="overlay-new"
                onClick={() => {
                  void window.fask
                    .clearRecent(projectId)
                    .then(refresh)
                    .then(() => setResetCount((c) => c + 1))
                }}
              >
                새 대화 시작
              </button>
            )}
            {(notice || error) && <p className="notice error">{notice || error}</p>}
          </div>
          <footer className="overlay-panel-footer">
            <small>모서리를 드래그해 크기 조절</small>
            <button
              type="button"
              className={`panel-resize-handle ${corner}`}
              aria-label="질문 창 크기 조절"
              title="드래그해서 질문 창 크기 조절"
              onPointerDown={(e) => {
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                const rect = e.currentTarget.closest('.overlay-panel')!.getBoundingClientRect()
                resizing.current = {
                  x: e.clientX,
                  y: e.clientY,
                  width: rect.width,
                  height: rect.height,
                  left: rect.left,
                  top: rect.top,
                  west,
                  north
                }
                setPanelInteraction(true)
              }}
              onPointerMove={(e) => {
                const start = resizing.current
                if (!start) return
                const width = Math.max(
                  Math.min(320, innerWidth - 16),
                  Math.min(
                    start.west ? start.left + start.width - 8 : innerWidth - start.left - 8,
                    start.width + (e.clientX - start.x) * (start.west ? -1 : 1)
                  )
                )
                const height = Math.max(
                  Math.min(260, innerHeight - 16),
                  Math.min(
                    start.north ? start.top + start.height - 8 : innerHeight - start.top - 8,
                    start.height + (e.clientY - start.y) * (start.north ? -1 : 1)
                  )
                )
                setPanelSize({ width, height })
                setPosition({
                  x: start.west ? start.left + start.width - width : start.left,
                  y: start.north ? start.top + start.height - height : start.top
                })
              }}
              onPointerUp={() => {
                resizing.current = null
                setPanelInteraction(false)
              }}
              onPointerCancel={() => {
                resizing.current = null
                setPanelInteraction(false)
              }}
            >
              ◢
            </button>
          </footer>
        </section>
      )}
    </div>
  )
}

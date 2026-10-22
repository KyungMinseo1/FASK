import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useSearchParams } from 'react-router'
import { eraseAt, redraw, type Stroke } from './strokes'
import Composer from './Composer'
import { errorText, useSnapshot } from './common'
import './personal.css'

export default function Overlay(): React.JSX.Element {
  const [params] = useSearchParams()
  const projectId = params.get('project') || '',
    profileId = params.get('profile') || ''
  const { data, error, refresh } = useSnapshot()
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'idle' | 'pen' | 'eraser'>('idle'),
    [panel, setPanel] = useState(params.get('panel') === '1')
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
  const [toolbarHeight, setToolbarHeight] = useState(480)
  const toolbarMoving = useRef<{
    x: number
    y: number
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [resetCount, setResetCount] = useState(0)
  const recent = data?.questions.find((q) => q.id === data.recentQuestions?.[projectId])
  const conversationId = recent?.conversationId
  const west = toolbar.x + 32 >= innerWidth / 2
  const north = toolbar.y + toolbarHeight / 2 > innerHeight / 2
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
    const element = document.querySelector('.overlay-toolbar')!
    const clamp = (): void => {
      const rect = element.getBoundingClientRect()
      setToolbarHeight(rect.height)
      setToolbar((p) => ({
        x: Math.max(8, Math.min(p.x, innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(p.y, innerHeight - rect.height - 8))
      }))
    }
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(clamp)
    })
    observer.observe(element)
    clamp()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
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
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') reset()
    }
    const resize = (): void =>
      setSize({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
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
    }
  }, [])
  useLayoutEffect(() => {
    const update = (): void => {
      const regions = [...document.querySelectorAll('.overlay-toolbar,.overlay-panel')].map(
        (el) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
      )
      void window.fask.overlayRegions(mode !== 'idle' || panelInteraction, regions, panel).catch(() => {})
    }
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    })
    document
      .querySelectorAll('.overlay-toolbar,.overlay-panel')
      .forEach((el) => observer.observe(el))
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [mode, panel, position, toolbar, size, panelSize, panelInteraction])
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
    e.currentTarget.setPointerCapture(e.pointerId)
    if (mode === 'pen') {
      drawing.current = { points: [{ x: e.clientX, y: e.clientY }] }
      paint([...strokes, drawing.current])
    } else setStrokes((s) => eraseAt(s, { x: e.clientX, y: e.clientY }))
  }
  const move = (e: PointerEvent<HTMLCanvasElement>): void => {
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
  const project = data?.projects.find((p) => p.id === projectId)
  const region = data?.settings.regions.find((r) => r.displayId === data.settings.displayId)
  return (
    <div className="personal-overlay">
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
          <span>이 영역 안쪽만 캡처 · Esc로 배경 앱 사용</span>
        </div>
      )}
      <div
        className="overlay-toolbar"
        style={{ left: toolbar.x, top: toolbar.y, right: 'auto', transform: 'none' }}
      >
        <button
          className="toolbar-drag-handle"
          aria-label="토글 위치 이동"
          title="드래그해서 토글 이동"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            const r = e.currentTarget.parentElement!.getBoundingClientRect()
            toolbarMoving.current = {
              x: e.clientX,
              y: e.clientY,
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height
            }
            setPanelInteraction(true)
          }}
          onPointerMove={(e) => {
            const start = toolbarMoving.current
            if (start)
              setToolbar({
                x: Math.max(
                  8,
                  Math.min(innerWidth - start.width - 8, start.left + e.clientX - start.x)
                ),
                y: Math.max(
                  8,
                  Math.min(innerHeight - start.height - 8, start.top + e.clientY - start.y)
                )
              })
          }}
          onPointerUp={() => {
            toolbarMoving.current = null
            setPanelInteraction(false)
          }}
          onPointerCancel={() => {
            toolbarMoving.current = null
            setPanelInteraction(false)
          }}
        >
          <b>
            f<span>{project?.name || 'FASK'}</span>
          </b>
        </button>
        <button
          title="배경 앱 조작"
          className={mode === 'idle' ? 'active' : ''}
          onClick={() => setMode('idle')}
        >
          ↖<small>선택</small>
        </button>
        <button
          className={mode === 'pen' ? 'active' : ''}
          onClick={() => {
            setMode('pen')
            setPanel(false)
          }}
        >
          ✎<small>펜</small>
        </button>
        <button
          className={mode === 'eraser' ? 'active' : ''}
          onClick={() => {
            setMode('eraser')
            setPanel(false)
          }}
        >
          ▱<small>지우개</small>
        </button>
        <button onClick={() => setStrokes([])}>
          ⌫<small>모두 지우기</small>
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
          ？<small>질문</small>
        </button>
        <button onClick={() => void window.fask.showDashboard()}>
          ▦<small>대시보드</small>
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
          ▣<small>캡처 영역</small>
        </button>
      </div>
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
          <div className="overlay-panel-content">
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
                conversationId={conversationId}
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
              />
            )}
            {conversationId && (
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

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useSearchParams } from 'react-router'
import { eraseAt, redraw, type Stroke } from '../pages/student/overlay/strokes'
import Composer from './Composer'
import { useSnapshot } from './common'
import './personal.css'

export default function Overlay(): React.JSX.Element {
  const [params] = useSearchParams()
  const projectId = params.get('project') || '',
    profileId = params.get('profile') || ''
  const { data, error } = useSnapshot()
  const [mode, setMode] = useState<'idle' | 'pen' | 'eraser'>('idle'),
    [panel, setPanel] = useState(params.get('panel') === '1')
  const [strokes, setStrokes] = useState<Stroke[]>([]),
    [size, setSize] = useState({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
  const canvas = useRef<HTMLCanvasElement>(null),
    drawing = useRef<Stroke | null>(null)
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [position, setPosition] = useState({ x: Math.max(10, innerWidth - 520), y: 64 })
  const moving = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => {
    const targets = [document.body, document.documentElement, document.getElementById('root')]
    for (const element of targets) if (element) element.style.background = 'transparent'
    const reset = (): void => {
      setMode('idle')
      drawing.current = null
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') reset()
    }
    const resize = (): void =>
      setSize({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
    window.addEventListener('keydown', key)
    window.addEventListener('resize', resize)
    const off = window.fask.onEscape(reset)
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
      void window.fask.overlayRegions(mode !== 'idle', regions).catch(() => {})
    }
    const observer = new ResizeObserver(update)
    document
      .querySelectorAll('.overlay-toolbar,.overlay-panel')
      .forEach((el) => observer.observe(el))
    update()
    return () => observer.disconnect()
  }, [mode, panel, position, size])
  const paint = (list: Stroke[]): void => {
    const ctx = canvas.current?.getContext('2d')
    if (ctx) redraw(ctx, list, size.width, size.height)
  }
  useEffect(() => {
    if (!canvas.current) return
    canvas.current.width = Math.round(size.width * size.dpr)
    canvas.current.height = Math.round(size.height * size.dpr)
    canvas.current.getContext('2d')?.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
    paint(strokes)
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
      <div className="overlay-toolbar">
        <b>
          f<span>{project?.name || 'FASK'}</span>
        </b>
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
          className={panel ? 'active' : ''}
          onClick={() => {
            setPanel((s) => !s)
            setMode('idle')
          }}
        >
          ？<small>질문</small>
        </button>
        <button onClick={() => window.askkup.showDashboard()}>
          ▦<small>대시보드</small>
        </button>
        <button onClick={() => window.askkup.closeOverlay()}>
          ×<small>나가기</small>
        </button>
      </div>
      {panel && (
        <section className="overlay-panel" style={{ left: position.x, top: position.y }}>
          <header
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              e.currentTarget.setPointerCapture(e.pointerId)
              moving.current = { x: e.clientX, y: e.clientY, left: position.x, top: position.y }
            }}
            onPointerMove={(e) => {
              const d = moving.current
              if (d)
                setPosition({
                  x: Math.max(0, Math.min(innerWidth - 180, d.left + e.clientX - d.x)),
                  y: Math.max(0, Math.min(innerHeight - 100, d.top + e.clientY - d.y))
                })
            }}
            onPointerUp={() => {
              moving.current = null
            }}
          >
            <div>
              <span className="eyebrow">ASK IN CONTEXT</span>
              <b>{project?.name || '화면 질문'}</b>
            </div>
            <button onClick={() => setPanel(false)}>접기 ×</button>
          </header>
          <small className="overlay-capture-note">
            {region ? '설정한 영역만 캡처' : '영역 미설정 · 전체 모니터 캡처'} · 캡처 버튼으로
            이미지를 확인한 후 전송하세요.
          </small>
          {data && (
            <Composer
              key={projectId}
              projectId={projectId}
              profileId={profileId}
              settings={data.settings}
              conversationId={conversationId}
              onCapture={() =>
                window.fask.captureQuestion(
                  strokes.length ? canvas.current?.toDataURL('image/png') : undefined
                )
              }
              onSaved={(id) => {
                void window.fask
                  .snapshot()
                  .then((s) =>
                    setConversationId(s.questions.find((q) => q.id === id)?.conversationId)
                  )
                setStrokes([])
              }}
            />
          )}
          {conversationId && (
            <button className="overlay-new" onClick={() => setConversationId(undefined)}>
              새 대화 시작
            </button>
          )}
          {error && <p className="notice error">{error}</p>}
        </section>
      )}
    </div>
  )
}

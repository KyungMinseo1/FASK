import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { CapturePreview, CaptureRect } from '../../../preload/personal'
import { errorText } from './common'
import { useT } from '../../../shared/i18n/react'
import { captureSetupMessage } from '../../../shared/capture'

const initial: CaptureRect = { x: 0.1, y: 0.12, width: 0.8, height: 0.76 }
export default function CaptureEditor(): React.JSX.Element {
  const t = useT()
  const [preview, setPreview] = useState<CapturePreview | null>(null)
  const [rect, setRect] = useState(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [setupRequired, setSetupRequired] = useState(false)
  const busy = useRef(false)
  const drag = useRef<{ mode: string; x: number; y: number; rect: CaptureRect } | null>(null)
  const rectRef = useRef(rect)
  const previewRef = useRef(preview)
  useEffect(() => {
    rectRef.current = rect
    previewRef.current = preview
  }, [rect, preview])
  const apply = async (): Promise<void> => {
    const p = previewRef.current
    if (!p || busy.current) return
    busy.current = true
    setSaving(true)
    setError('')
    setSetupRequired(false)
    try {
      const result = await window.fask.saveRegion({
        displayId: p.display.id,
        rect: rectRef.current,
        screenWidth: p.display.width,
        screenHeight: p.display.height
      })
      if (!result.ok) {
        setSetupRequired(true)
        setError(t(captureSetupMessage(result.reason)))
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      busy.current = false
      setSaving(false)
    }
  }
  useEffect(() => {
    void window.fask
      .capturePreview()
      .then((p) => {
        setPreview(p)
        setRect(p.region?.rect ?? initial)
      })
      .catch((e) => setError(errorText(e)))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void window.fask.closeCaptureEditor()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        void apply()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const down = (e: PointerEvent, mode: string): void => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode, x: e.clientX, y: e.clientY, rect: { ...rect } }
  }
  const move = (e: PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / innerWidth,
      dy = (e.clientY - d.y) / innerHeight
    let { x, y, width, height } = d.rect
    const minW = Math.min(0.1, 64 / innerWidth),
      minH = Math.min(0.1, 64 / innerHeight)
    if (d.mode === 'move') {
      x = Math.max(0, Math.min(1 - width, x + dx))
      y = Math.max(0, Math.min(1 - height, y + dy))
    } else {
      const right = x + width,
        bottom = y + height
      if (d.mode.includes('w')) {
        x = Math.max(0, Math.min(right - minW, x + dx))
        width = right - x
      }
      if (d.mode.includes('e')) width = Math.max(minW, Math.min(1 - x, width + dx))
      if (d.mode.includes('n')) {
        y = Math.max(0, Math.min(bottom - minH, y + dy))
        height = bottom - y
      }
      if (d.mode.includes('s')) height = Math.max(minH, Math.min(1 - y, height + dy))
    }
    setRect({ x, y, width, height })
  }
  const inset = `inset(${rect.y * 100}% ${(1 - rect.x - rect.width) * 100}% ${(1 - rect.y - rect.height) * 100}% ${rect.x * 100}%)`
  return (
    <div
      className="capture-editor"
      onPointerMove={move}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
    >
      {preview && (
        <>
          <img
            className="capture-background"
            src={preview.image}
            style={{ filter: 'blur(7px) brightness(.42)' }}
            draggable={false}
          />
          <img
            className="capture-background"
            src={preview.image}
            style={{ clipPath: inset }}
            draggable={false}
          />
          <div
            className="capture-box"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`
            }}
            onPointerDown={(e) => down(e, 'move')}
          >
            <span className="capture-size">
              <span>
                {Math.round(rect.width * preview.display.width)} ×{' '}
                {Math.round(rect.height * preview.display.height)}
              </span>
              <span>{t('안쪽만 캡처')}</span>
            </span>
            {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((mode) => (
              <span
                key={mode}
                className={`capture-handle ${mode}`}
                onPointerDown={(e) => down(e, mode)}
                aria-label={t('{{mode}} 크기 조절', { mode })}
              />
            ))}
          </div>
        </>
      )}
      <div className="capture-controls">
        <div>
          <b>{t('캡처 영역 설정')}</b>
          <small>
            {t('박스를 옮기거나 가장자리를 드래그하세요. 바깥 영역은 전송되지 않습니다.')}
          </small>
        </div>
        <button onClick={() => setRect({ x: 0, y: 0, width: 1, height: 1 })}>
          {t('전체 화면')}
        </button>
        <button onClick={() => setRect(initial)}>{t('초기화')}</button>
        <button onClick={() => void window.fask.closeCaptureEditor()}>
          {t('취소')}
          <kbd>Esc</kbd>
        </button>
        <button className="primary" disabled={saving || !preview} onClick={() => void apply()}>
          {t('적용')}
          <kbd>Enter</kbd>
        </button>
      </div>
      {error && (
        <div className="capture-error">
          {error}
          <button onClick={() => void window.fask.closeCaptureEditor()}>
            {t(setupRequired ? '캡처 영역 다시 설정' : '닫기')}
          </button>
        </div>
      )}
    </div>
  )
}

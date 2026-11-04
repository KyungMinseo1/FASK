import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Turn } from '../../../preload/personal'
import { useT } from '../../../shared/i18n/react'

const HIDE_MS = 1600

/**
 * Floating jump controls for a question thread. They appear while the thread's
 * scroller moves, fade out after it stops, and stay while hovered or the turn list
 * is open. Portaled to <body> and pinned to the visible bottom-right corner of the
 * scroller: the scroller itself may extend past the viewport (desktop dashboard).
 */
/** The question header (close, star) scrolls away after this many pixels. */
const HEADER_PX = 80
/** Desktop: the pointer within this corner of the scroller reveals the header controls. */
const CORNER_W = 220
const CORNER_H = 90

export default function TurnNav({
  turns,
  important,
  onToggleImportant,
  onClose
}: {
  turns: Turn[]
  important: boolean
  onToggleImportant: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const anchor = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const timer = useRef<number>(undefined)
  const [visible, setVisible] = useState(false)
  const [farFromBottom, setFarFromBottom] = useState(false)
  const [corner, setCorner] = useState({ right: 12, bottom: 12 })
  const [top, setTop] = useState({ right: 12, top: 12 })
  const [scrolledPast, setScrolledPast] = useState(false)
  const [nearTop, setNearTop] = useState(false)
  const [topHover, setTopHover] = useState(false)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const pinned = hover || open
  useEffect(() => {
    // The scroller differs per host (desktop aside, mobile pane, overlay panel); take
    // whichever scrolling ancestor actually moved.
    const onScroll = (e: Event): void => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !anchor.current || !el.contains(anchor.current)) return
      scroller.current = el
      const r = el.getBoundingClientRect()
      setCorner({
        right: Math.max(0, innerWidth - r.right) + 12,
        bottom: Math.max(0, innerHeight - r.bottom) + 12
      })
      setTop({ right: Math.max(0, innerWidth - r.right) + 12, top: Math.max(0, r.top) + 12 })
      setScrolledPast(el.scrollTop > HEADER_PX)
      setFarFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight)
      setVisible(true)
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setVisible(false), HIDE_MS)
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      clearTimeout(timer.current)
    }
  }, [])
  // Desktop: reveal close/star when the mouse sits in the scroller's top-right corner.
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return
      const el = scroller.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const t = Math.max(0, r.top)
      setNearTop(e.clientX <= r.right && e.clientX >= r.right - CORNER_W && e.clientY >= t && e.clientY <= t + CORNER_H)
    }
    document.addEventListener('pointermove', move)
    return () => document.removeEventListener('pointermove', move)
  }, [])
  // Leaving the controls restarts the fade instead of hiding them instantly.
  useEffect(() => {
    if (pinned) return
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setVisible(false), HIDE_MS)
  }, [pinned])
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [open])
  const jump = (index: number): void => {
    setOpen(false)
    anchor.current
      ?.closest('.question-detail')
      ?.querySelectorAll('.detail-turn')
      [index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const shown = visible || pinned
  const showList = turns.length > 1
  const showBottom = farFromBottom
  // Touch has no hover, so the header controls follow the scroll-driven visibility instead.
  const showTop = scrolledPast && (nearTop || topHover || visible)
  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <div
          className={`turn-nav turn-nav-top${showTop ? ' shown' : ''}${topHover ? ' pinned' : ''}`}
          style={top}
          onPointerEnter={(e) => e.pointerType === 'mouse' && setTopHover(true)}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setTopHover(false)}
        >
          <button
            type="button"
            className={important ? 'star-on' : ''}
            aria-label={t('중요 표시')}
            title={t('중요 표시')}
            onClick={onToggleImportant}
          >
            {important ? '★' : '☆'}
          </button>
          <button type="button" aria-label={t('닫기')} title={t('닫기')} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>,
        document.body
      )}
      {createPortal(
        <div
          ref={root}
          className={`turn-nav${shown && (showList || showBottom) ? ' shown' : ''}${pinned ? ' pinned' : ''}`}
          style={corner}
          onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
        >
          {open && (
            <ol className="turn-nav-menu" role="menu">
              {turns.map((turn, i) => (
                <li key={turn.id}>
                  <button type="button" role="menuitem" onClick={() => jump(i)}>
                    <b>{t('질문 {{n}}', { n: i + 1 })}</b>
                    <span>{turn.sent}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {showList && (
            <button
              type="button"
              className={open ? 'active' : ''}
              aria-label={t('질문 목록')}
              title={t('질문 목록')}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M9 6h11M9 12h11M9 18h11" />
                <circle cx="4.5" cy="6" r="1" fill="currentColor" />
                <circle cx="4.5" cy="12" r="1" fill="currentColor" />
                <circle cx="4.5" cy="18" r="1" fill="currentColor" />
              </svg>
            </button>
          )}
          {showBottom && (
            <button
              type="button"
              aria-label={t('맨 아래로')}
              title={t('맨 아래로')}
              onClick={() => {
                const el = scroller.current
                el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 5v13M6 12l6 6 6-6" />
              </svg>
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

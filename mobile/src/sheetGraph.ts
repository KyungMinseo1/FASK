import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Half-sheet graph sizing: shrinks the graph above an open concept sheet and scrolls it into view. */
export function useSheetGraph(
  open: boolean,
  key: string | null
): {
  graphRef: React.RefObject<HTMLDivElement | null>
  sheetRef: React.RefObject<HTMLDivElement | null>
  graphHeight: number | null
  sheetFull: boolean
  setSheetFull: React.Dispatch<React.SetStateAction<boolean>>
} {
  const graphRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [sheetFull, setSheetFull] = useState(false)
  // Graph height while the half sheet is open: from the top of the graph's scroller (where
  // scrollIntoView puts it) down to the sheet. Measured, since banners above the header move it.
  const [graphHeight, setGraphHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const sheet = sheetRef.current
    const scroller = graphRef.current?.closest<HTMLElement>('.mobile-list-column, .mobile-body')
    if (!open || sheetFull || !sheet || !scroller) return
    const measure = (): void => {
      // The visible top is the lowest top among clipping ancestors: a scrolled column can sit above
      // the screen while its scrolling parent starts below the header and banners.
      let top = -Infinity
      for (let el = graphRef.current?.parentElement; el; el = el.parentElement)
        if (getComputedStyle(el).overflowY !== 'visible') top = Math.max(top, el.getBoundingClientRect().top)
      if (top === -Infinity) top = scroller.getBoundingClientRect().top
      // getBoundingClientRect is in zoomed pixels; style heights are not.
      const scale = scroller.offsetHeight ? scroller.getBoundingClientRect().height / scroller.offsetHeight : 1
      setGraphHeight(Math.max(160, Math.round((sheet.getBoundingClientRect().top - top) / scale) - 8))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(sheet)
    observer.observe(scroller)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, sheetFull, key])
  // The sheet covers the lower half: bring the (shrunken) graph to the top of its scroller.
  useEffect(() => {
    if (open) graphRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [open, key, graphHeight])
  useEffect(() => setSheetFull(false), [key])
  return { graphRef, sheetRef, graphHeight, sheetFull, setSheetFull }
}

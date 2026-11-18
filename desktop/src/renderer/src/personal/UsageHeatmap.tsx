import { useEffect, useMemo, useState } from 'react'
import type { UsageDay } from '../../../preload/personal'
import { useT } from '../../../shared/i18n/react'
import { i18n } from '../../../shared/i18n'
import { errorText } from './common'

const WEEKS = 53

/** Local YYYY-MM-DD, the same day key the store writes. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Daily tokens (model + Jev) for the last 53 weeks, Sunday-first columns ending with this week. */
export default function UsageHeatmap(): React.JSX.Element {
  const t = useT()
  const [days, setDays] = useState<UsageDay[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const load = (): void => {
      window.fask
        .usage()
        .then((d) => {
          setDays(d)
          setError('')
        })
        .catch((e: unknown) => setError(errorText(e)))
    }
    load()
    return window.fask.onChanged(load)
  }, [])
  const view = useMemo(() => {
    const byDay = new Map((days ?? []).map((d) => [d.day, d]))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7)
    const cells: { key: string; date: Date; usage: UsageDay | undefined; future: boolean }[] = []
    for (let i = 0; i < WEEKS * 7; i++) {
      const date = new Date(start)
      date.setDate(start.getDate() + i)
      const key = dayKey(date)
      cells.push({ key, date, usage: byDay.get(key), future: date > today })
    }
    const totals = cells
      .map((c) => (c.usage ? c.usage.model + c.usage.jev : 0))
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    const quartile = (q: number): number => totals[Math.min(totals.length - 1, Math.floor(totals.length * q))]
    const bounds = totals.length ? [quartile(0.25), quartile(0.5), quartile(0.75)] : []
    const months: { column: number; label: string }[] = []
    for (let w = 0; w < WEEKS; w++) {
      const first = cells[w * 7].date
      if (w === 0 || first.getMonth() !== cells[(w - 1) * 7].date.getMonth())
        months.push({ column: w, label: first.toLocaleDateString(i18n.language, { month: 'short' }) })
    }
    // A partial first month would sit on top of the next label.
    if (months.length > 1 && months[1].column - months[0].column < 3) months.shift()
    return {
      cells,
      bounds,
      months,
      total: totals.reduce((a, b) => a + b, 0),
      used: totals.length,
      estimated: cells.some((c) => c.usage?.estimated)
    }
  }, [days])
  if (error) return <p className="error">{error}</p>
  if (!days) return <p>{t('불러오는 중…')}</p>
  const number = (n: number): string => n.toLocaleString(i18n.language)
  return (
    <div className="usage-heatmap">
      <p className="usage-summary">
        {t('최근 1년 {{total}} 토큰, {{days}}일 사용', { total: number(view.total), days: number(view.used) })}
      </p>
      {/* Cells scale with the column, so the whole year always fits without scrolling. */}
      <div className="usage-grid" role="img" aria-label={t('사용량')}>
          {view.months.map((m) => (
            <span key={m.column} className="usage-month" style={{ gridColumn: m.column + 2, gridRow: 1 }}>
              {m.label}
            </span>
          ))}
          {(['월', '수', '금'] as const).map((label, i) => (
            <span key={label} className="usage-weekday" style={{ gridColumn: 1, gridRow: i * 2 + 3 }}>
              {t(label)}
            </span>
          ))}
          {view.cells.map((c, i) => {
            if (c.future) return null
            const value = c.usage ? c.usage.model + c.usage.jev : 0
            const level = value <= 0 ? 0 : 1 + view.bounds.filter((b) => value > b).length
            const cost = c.usage && c.usage.jevCost > 0 ? ` $${c.usage.jevCost.toFixed(4)}` : ''
            return (
              <span
                key={c.key}
                className={`usage-cell l${level}`}
                style={{ gridColumn: Math.floor(i / 7) + 2, gridRow: (i % 7) + 2 }}
                title={
                  t('{{date}}: {{total}} 토큰 (모델 {{model}}, Jev {{jev}})', {
                    date: c.date.toLocaleDateString(i18n.language),
                    total: number(value),
                    model: number(c.usage?.model ?? 0),
                    jev: number(c.usage?.jev ?? 0)
                  }) + cost
                }
              />
            )
          })}
        </div>
      {view.estimated && <small>{t('일부는 API가 사용량을 알려주지 않아 글자 수로 추정했습니다.')}</small>}
    </div>
  )
}

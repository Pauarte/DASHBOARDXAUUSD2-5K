import { useMemo, useState } from 'react'
import type { Trade } from '../lib/types'
import { groupIntoBaskets } from '../lib/stats'
import { dashboardDateKey, formatCurrency } from '../lib/format'
import { useThemeColors } from '../lib/useThemeColors'

interface DayCell {
  date: string
  pnl: number
  trades: number
  inMonth: boolean
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function CalendarHeatmap({ trades }: { trades: Trade[] }) {
  const colors = useThemeColors()

  const byDay = useMemo(() => {
    const map = new Map<string, { pnl: number; trades: number }>()
    for (const basket of groupIntoBaskets(trades)) {
      const day = dashboardDateKey(basket.closeTime)
      const entry = map.get(day) ?? { pnl: 0, trades: 0 }
      entry.pnl = Number((entry.pnl + basket.pnl).toFixed(2))
      entry.trades += 1
      map.set(day, entry)
    }
    return map
  }, [trades])

  const lastTradedDay = useMemo(() => {
    const days = Array.from(byDay.keys()).sort()
    return days[days.length - 1] ?? null
  }, [byDay])

  const [cursor, setCursor] = useState(() => {
    const base = lastTradedDay ? new Date(`${lastTradedDay}T00:00:00Z`) : new Date()
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1))
  })

  const year = cursor.getUTCFullYear()
  const month = cursor.getUTCMonth()

  const weeks = useMemo(() => {
    const firstOfMonth = new Date(Date.UTC(year, month, 1))
    const firstWeekday = (firstOfMonth.getUTCDay() + 6) % 7 // Monday-first
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

    const cells: DayCell[] = Array.from({ length: firstWeekday }, () => ({
      date: '',
      pnl: 0,
      trades: 0,
      inMonth: false,
    }))

    for (let day = 1; day <= daysInMonth; day++) {
      const key = toKey(new Date(Date.UTC(year, month, day)))
      const entry = byDay.get(key)
      cells.push({ date: key, pnl: entry?.pnl ?? 0, trades: entry?.trades ?? 0, inMonth: true })
    }
    while (cells.length % 7 !== 0) {
      cells.push({ date: '', pnl: 0, trades: 0, inMonth: false })
    }

    const rows: DayCell[][] = []
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
    return rows
  }, [year, month, byDay])

  const maxAbsPnl = Math.max(1, ...Array.from(byDay.values()).map((v) => Math.abs(v.pnl)))
  const monthLabel = cursor.toLocaleDateString('ca-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  const [selected, setSelected] = useState<DayCell | null>(null)
  const detail = selected ?? (lastTradedDay ? { date: lastTradedDay, ...byDay.get(lastTradedDay)! } : null)

  function intensity(pnl: number): number {
    if (pnl === 0) return 0
    return 0.2 + 0.55 * Math.min(1, Math.abs(pnl) / maxAbsPnl)
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Calendar</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous month"
            className="rounded-md border border-[var(--border)] w-6 h-6 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            onClick={() => setCursor(new Date(Date.UTC(year, month - 1, 1)))}
          >
            ‹
          </button>
          <span className="text-xs text-[var(--text-muted)] w-28 text-center tabular">{monthLabel}</span>
          <button
            type="button"
            aria-label="Next month"
            className="rounded-md border border-[var(--border)] w-6 h-6 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            onClick={() => setCursor(new Date(Date.UTC(year, month + 1, 1)))}
          >
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-[2px] mb-1">
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-[10px] text-[var(--text-muted)]">
            {d}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-[2px]">
        {weeks.map((week, i) => (
          <div key={i} className="grid grid-cols-7 gap-[2px]">
            {week.map((cell, j) => {
              if (!cell.inMonth) return <div key={j} className="aspect-square" />
              const bg =
                cell.pnl === 0
                  ? 'transparent'
                  : hexToRgba(cell.pnl > 0 ? colors.good : colors.critical, intensity(cell.pnl))
              const isSelected = detail?.date === cell.date
              return (
                <button
                  key={j}
                  type="button"
                  onMouseEnter={() => setSelected(cell)}
                  onFocus={() => setSelected(cell)}
                  onClick={() => setSelected(cell)}
                  className={`aspect-square rounded-md border text-left px-1.5 py-1 flex flex-col justify-between transition-colors ${
                    isSelected ? 'border-[var(--baseline)]' : 'border-[var(--border)]'
                  }`}
                  style={{ background: bg }}
                >
                  <span
                    className={`text-[10px] tabular ${
                      cell.trades > 0 ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {Number(cell.date.slice(8, 10))}
                  </span>
                  {cell.trades > 0 && (
                    <span className="text-[10px] font-semibold tabular text-[var(--text-primary)]">
                      {cell.pnl >= 0 ? '+' : ''}
                      {Math.round(cell.pnl)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center justify-between text-xs">
        {detail ? (
          <>
            <span className="text-[var(--text-secondary)]">
              {new Date(`${detail.date}T00:00:00Z`).toLocaleDateString('ca-ES', {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                timeZone: 'UTC',
              })}
              {' · '}
              {detail.trades} trade{detail.trades === 1 ? '' : 's'}
            </span>
            <span
              className={`tabular font-semibold ${
                detail.pnl >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
              }`}
            >
              {formatCurrency(detail.pnl, { signed: true })}
            </span>
          </>
        ) : (
          <span className="text-[var(--text-muted)]">No trades this month yet.</span>
        )}
      </div>
    </div>
  )
}

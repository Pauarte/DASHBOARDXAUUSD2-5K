import { useMemo, useState } from 'react'
import type { Trade } from '../lib/types'
import { groupIntoBaskets } from '../lib/stats'
import { dashboardDateKey, formatPercent, isWeekend } from '../lib/format'
import { useCurrencyFormatter, useCurrencyValue } from '../lib/currency'
import { useThemeColors } from '../lib/useThemeColors'

interface DayCell {
  date: string
  pnl: number
  pct: number
  trades: number
  inMonth: boolean
  weekend: boolean
}

const WEEKDAYS = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg']

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Capitalize just the leading letter — CSS `capitalize` title-cases every
// word, which wrongly uppercases Catalan prepositions ("de" -> "De") in
// "juliol de 2026" / "dj., 09 de jul.".
function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function CalendarHeatmap({ trades, dailyPct }: { trades: Trade[]; dailyPct?: Map<string, number> }) {
  const colors = useThemeColors()
  const formatCurrency = useCurrencyFormatter()
  const toDisplayCurrency = useCurrencyValue()
  const today = useMemo(() => dashboardDateKey(new Date().toISOString()), [])

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
      pct: 0,
      trades: 0,
      inMonth: false,
      weekend: false,
    }))

    for (let day = 1; day <= daysInMonth; day++) {
      const key = toKey(new Date(Date.UTC(year, month, day)))
      const entry = byDay.get(key)
      cells.push({
        date: key,
        pnl: entry?.pnl ?? 0,
        pct: dailyPct?.get(key) ?? 0,
        trades: entry?.trades ?? 0,
        inMonth: true,
        weekend: isWeekend(key),
      })
    }
    while (cells.length % 7 !== 0) {
      cells.push({ date: '', pnl: 0, pct: 0, trades: 0, inMonth: false, weekend: false })
    }

    const rows: DayCell[][] = []
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
    return rows
  }, [year, month, byDay, dailyPct])

  const maxAbsPnl = Math.max(1, ...Array.from(byDay.values()).map((v) => Math.abs(v.pnl)))
  const monthLabel = capitalizeFirst(
    cursor.toLocaleDateString('ca-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  )

  const [selected, setSelected] = useState<DayCell | null>(null)
  const detail = selected ?? (lastTradedDay ? { date: lastTradedDay, ...byDay.get(lastTradedDay)! } : null)

  function intensity(pnl: number): number {
    if (pnl === 0) return 0
    return 0.16 + 0.5 * Math.min(1, Math.abs(pnl) / maxAbsPnl)
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Calendari</h3>
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-[3px]"
                style={{ background: hexToRgba(colors.good, 0.55) }}
              />
              Guany
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-[3px]"
                style={{ background: hexToRgba(colors.critical, 0.55) }}
              />
              Pèrdua
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-[3px] calendar-weekend-swatch" />
              Mercat tancat
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Mes anterior"
            className="rounded-full border border-[var(--border)] w-7 h-7 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
            onClick={() => setCursor(new Date(Date.UTC(year, month - 1, 1)))}
          >
            ‹
          </button>
          <span className="text-xs font-medium text-[var(--text-secondary)] w-32 text-center tabular">
            {monthLabel}
          </span>
          <button
            type="button"
            aria-label="Mes següent"
            className="rounded-full border border-[var(--border)] w-7 h-7 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
            onClick={() => setCursor(new Date(Date.UTC(year, month + 1, 1)))}
          >
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5 mb-1.5">
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {d}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        {weeks.map((week, i) => (
          <div key={i} className="grid grid-cols-7 gap-1.5">
            {week.map((cell, j) => {
              if (!cell.inMonth) return <div key={j} className="aspect-square" />
              const bg =
                cell.pnl === 0
                  ? 'transparent'
                  : hexToRgba(cell.pnl > 0 ? colors.good : colors.critical, intensity(cell.pnl))
              const isSelected = detail?.date === cell.date
              const isToday = cell.date === today
              return (
                <button
                  key={j}
                  type="button"
                  onMouseEnter={() => setSelected(cell)}
                  onFocus={() => setSelected(cell)}
                  onClick={() => setSelected(cell)}
                  className={`calendar-cell relative aspect-square rounded-lg border px-1.5 py-1.5 sm:px-2 sm:py-2 flex flex-col items-center transition-all ${
                    isSelected
                      ? 'border-[var(--baseline)] ring-2 ring-[var(--baseline)] ring-offset-1 ring-offset-[var(--surface-card)]'
                      : 'border-[var(--border)] hover:border-[var(--baseline)]'
                  } ${cell.weekend && cell.trades === 0 ? 'calendar-weekend' : ''}`}
                  style={bg === 'transparent' ? undefined : { backgroundColor: bg }}
                >
                  <span
                    className={`self-start inline-flex items-center justify-center text-[11px] sm:text-xs tabular ${
                      cell.trades > 0 ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)]'
                    } ${isToday ? 'w-5 h-5 rounded-full ring-1 ring-[var(--text-primary)]' : ''}`}
                  >
                    {Number(cell.date.slice(8, 10))}
                  </span>
                  {cell.trades > 0 && (
                    <span className="flex-1 flex flex-col items-center justify-center gap-0.5 leading-tight">
                      <span className="text-xs sm:text-sm font-semibold tabular text-[var(--text-primary)]">
                        {cell.pnl >= 0 ? '+' : ''}
                        {Math.round(toDisplayCurrency(cell.pnl))}
                      </span>
                      {dailyPct && (
                        <span className="text-[10px] sm:text-[11px] tabular text-[var(--text-muted)]">
                          {formatPercent(cell.pct, 1)}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-[var(--border)]">
        {detail ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  detail.trades === 0
                    ? 'bg-[var(--baseline)]'
                    : detail.pnl >= 0
                      ? 'bg-[var(--good)]'
                      : 'bg-[var(--critical)]'
                }`}
              />
              <span>
                {capitalizeFirst(
                  new Date(`${detail.date}T00:00:00Z`).toLocaleDateString('ca-ES', {
                    weekday: 'short',
                    day: '2-digit',
                    month: 'short',
                    timeZone: 'UTC',
                  }),
                )}
              </span>
              <span className="text-[var(--text-muted)]">
                · {detail.trades} {detail.trades === 1 ? 'operació' : 'operacions'}
              </span>
            </div>
            <span
              className={`text-sm tabular font-semibold ${
                detail.trades === 0
                  ? 'text-[var(--text-muted)]'
                  : detail.pnl >= 0
                    ? 'text-[var(--good-text)]'
                    : 'text-[var(--critical)]'
              }`}
            >
              {detail.trades === 0 ? '—' : formatCurrency(detail.pnl, { signed: true })}
              {dailyPct && detail.trades > 0 && (
                <span className="text-[var(--text-muted)] font-normal">
                  {' · '}
                  {formatPercent(dailyPct.get(detail.date) ?? 0, 2)}
                </span>
              )}
            </span>
          </div>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">Encara no hi ha operacions aquest mes.</span>
        )}
      </div>
    </div>
  )
}

import { dashboardDateKey, DASHBOARD_TIME_ZONE } from '../lib/format'
import { ALL_TIME, type DateRange } from '../lib/dateRange'

function todayKey(): string {
  return dashboardDateKey(new Date().toISOString())
}

function daysAgoKey(days: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DASHBOARD_TIME_ZONE,
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  const asUtcNoon = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`)
  asUtcNoon.setUTCDate(asUtcNoon.getUTCDate() - days)
  return asUtcNoon.toISOString().slice(0, 10)
}

function monthStartKey(): string {
  const today = todayKey()
  return `${today.slice(0, 7)}-01`
}

const PRESETS: { label: string; range: () => DateRange }[] = [
  { label: 'Avui', range: () => ({ start: todayKey(), end: todayKey() }) },
  { label: '7 dies', range: () => ({ start: daysAgoKey(6), end: todayKey() }) },
  { label: '30 dies', range: () => ({ start: daysAgoKey(29), end: todayKey() }) },
  { label: 'Aquest mes', range: () => ({ start: monthStartKey(), end: todayKey() }) },
  { label: 'Tot', range: () => ALL_TIME },
]

function sameRange(a: DateRange, b: DateRange): boolean {
  return a.start === b.start && a.end === b.end
}

export function DateRangeFilter({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  const activePreset = PRESETS.find((p) => sameRange(p.range(), range))

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-wrap rounded-full border border-[var(--border)] p-0.5 text-xs font-medium">
        {PRESETS.map((preset) => {
          const isActive = preset.label === (activePreset?.label ?? (range.start || range.end ? undefined : 'Tot'))
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => onChange(preset.range())}
              className={`rounded-full px-2.5 py-1 transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {preset.label}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <input
          type="date"
          aria-label="Des de"
          value={range.start ?? ''}
          max={range.end ?? undefined}
          onChange={(e) => onChange({ ...range, start: e.target.value || null })}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-card)] px-2 py-1 text-[var(--text-secondary)]"
        />
        <span>–</span>
        <input
          type="date"
          aria-label="Fins a"
          value={range.end ?? ''}
          min={range.start ?? undefined}
          onChange={(e) => onChange({ ...range, end: e.target.value || null })}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-card)] px-2 py-1 text-[var(--text-secondary)]"
        />
      </div>
    </div>
  )
}

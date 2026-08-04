import { ALL_TIME, type DateRange } from '../lib/dateRange'

function isAllTime(range: DateRange): boolean {
  return !range.start && !range.end
}

export function DateRangeFilter({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  const allTimeActive = isAllTime(range)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(ALL_TIME)}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
          allTimeActive
            ? 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)]'
            : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        }`}
      >
        Tot
      </button>
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

interface TooltipRow {
  label: string
  value: string
  color?: string
}

export function ChartTooltip({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-card)] px-3 py-2 shadow-lg text-xs min-w-[140px]">
      <div className="text-[var(--text-muted)] mb-1">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3 py-0.5">
          <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
            {row.color && (
              <span
                className="inline-block w-2.5 h-[2px] rounded-full"
                style={{ background: row.color }}
              />
            )}
            {row.label}
          </span>
          <span className="tabular font-semibold text-[var(--text-primary)]">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

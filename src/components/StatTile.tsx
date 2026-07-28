import type { ReactNode } from 'react'

interface StatTileProps {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'good' | 'critical'
  icon?: ReactNode
}

const toneClass: Record<NonNullable<StatTileProps['tone']>, string> = {
  neutral: '',
  good: 'text-[var(--good-text)]',
  critical: 'text-[var(--critical)]',
}

export function StatTile({ label, value, sub, tone = 'neutral', icon }: StatTileProps) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4 flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {label}
        </span>
        {icon}
      </div>
      <span className={`tabular text-2xl font-semibold truncate ${toneClass[tone]}`}>
        {value}
      </span>
      {sub && <span className="text-xs text-[var(--text-secondary)]">{sub}</span>}
    </div>
  )
}

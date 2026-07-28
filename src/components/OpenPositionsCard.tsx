import type { OpenPosition } from '../lib/types'
import { formatCurrency, formatDateTime } from '../lib/format'

export function OpenPositionsCard({ positions }: { positions: OpenPosition[] }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Open positions</h3>
        <span className="text-xs text-[var(--text-muted)]">{positions.length} active</span>
      </div>
      {positions.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No open positions.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {positions.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">
                  XAUUSD{' '}
                  <span className={p.direction === 'BUY' ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'}>
                    {p.direction}
                  </span>{' '}
                  {p.lots.toFixed(2)}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  Opened {formatDateTime(p.openTime)} @ {p.entryPrice.toFixed(2)}
                </span>
              </div>
              <span
                className={`tabular font-semibold ${
                  p.floatingPnl >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
                }`}
              >
                {formatCurrency(p.floatingPnl, { signed: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

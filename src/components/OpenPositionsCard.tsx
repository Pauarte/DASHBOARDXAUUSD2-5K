import type { OpenPosition } from '../lib/types'
import { formatDateTime } from '../lib/format'
import { useCurrencyFormatter } from '../lib/currency'

export function OpenPositionsCard({ positions }: { positions: OpenPosition[] }) {
  const formatCurrency = useCurrencyFormatter()
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Posicions obertes</h3>
        <span className="text-xs text-[var(--text-muted)]">
          {positions.length} {positions.length === 1 ? 'activa' : 'actives'}
        </span>
      </div>
      {positions.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No hi ha posicions obertes.</p>
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
                  Oberta {formatDateTime(p.openTime)} @ {p.entryPrice.toFixed(2)}
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

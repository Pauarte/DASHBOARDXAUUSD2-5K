import { groupIntoBaskets } from '../lib/stats'
import type { Trade } from '../lib/types'
import { formatCurrency, formatDateTime } from '../lib/format'

const directionStyle: Record<Trade['direction'], string> = {
  BUY: 'text-[var(--good-text)] bg-[var(--good)]/10',
  SELL: 'text-[var(--critical)] bg-[var(--critical)]/10',
}

export function TradeHistoryTable({ trades }: { trades: Trade[] }) {
  const baskets = [...groupIntoBaskets(trades)].reverse().slice(0, 20)

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Recent trades</h3>
        <span className="text-xs text-[var(--text-muted)]">Last {baskets.length} closed</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
              <th className="font-medium py-2 pr-3">Closed</th>
              <th className="font-medium py-2 pr-3">Side</th>
              <th className="font-medium py-2 pr-3">Legs</th>
              <th className="font-medium py-2 pr-3">Lots</th>
              <th className="font-medium py-2 pr-3">Avg entry</th>
              <th className="font-medium py-2 pr-3">Reason</th>
              <th className="font-medium py-2 text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {baskets.map((basket) => {
              const first = basket.legs[0]
              const totalLots = basket.legs.reduce((s, l) => s + l.lots, 0)
              const avgEntry =
                basket.legs.reduce((s, l) => s + l.entryPrice * l.lots, 0) / (totalLots || 1)

              return (
                <tr key={basket.closeTime} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2 pr-3 text-[var(--text-secondary)] tabular whitespace-nowrap">
                    {formatDateTime(basket.closeTime)}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${directionStyle[first.direction]}`}
                    >
                      {first.direction}
                    </span>
                  </td>
                  <td className="py-2 pr-3 tabular text-[var(--text-secondary)]">
                    {basket.legs.length}
                  </td>
                  <td className="py-2 pr-3 tabular text-[var(--text-secondary)]">
                    {totalLots.toFixed(2)}
                  </td>
                  <td className="py-2 pr-3 tabular text-[var(--text-secondary)]">
                    {avgEntry.toFixed(2)}
                  </td>
                  <td className="py-2 pr-3 text-[var(--text-secondary)]">{first.exitReason}</td>
                  <td
                    className={`py-2 text-right tabular font-semibold ${
                      basket.pnl >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
                    }`}
                  >
                    {formatCurrency(basket.pnl, { signed: true })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

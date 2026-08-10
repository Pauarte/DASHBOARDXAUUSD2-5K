import type { OpenPosition } from '../lib/types'
import { formatDateTime } from '../lib/format'
import { useCurrencyFormatter } from '../lib/currency'
import { floatingMaxForBalance } from '../lib/floatingRisk'

// XAUUSD: 1 lot = 100 oz, so each $1 move in the gold price is $100 of
// P&L per lot.
const USD_PER_LOT_PER_DOLLAR = 100

// The gold price at which the whole open basket's floating P&L crosses
// zero. Derived from the *actual* current floating (not just the
// volume-weighted entry average), so accrued swap fees are automatically
// included: floating moves by $100 × net lots per $1 of price, so it hits
// zero at currentPrice − floating / (100 × netLots). Sign handling falls
// out naturally: a losing BUY basket puts BE above the current price, a
// losing SELL basket below it. Null when net exposure is zero (fully
// hedged — no single price flattens it).
function breakEvenPrice(positions: OpenPosition[]): number | null {
  const netLots = positions.reduce((s, p) => s + (p.direction === 'BUY' ? p.lots : -p.lots), 0)
  if (Math.abs(netLots) < 1e-9) return null
  const totalFloating = positions.reduce((s, p) => s + p.floatingPnl, 0)
  return positions[0].currentPrice - totalFloating / (USD_PER_LOT_PER_DOLLAR * netLots)
}

// The bot adds up to this many grid entries to a basket. Below that, a
// projected SL price is misleading: as price moves against the basket the
// bot will add more legs first, growing the lots and pulling the real
// stop level closer — the number would look reassuringly far away right
// up until it isn't. Only with the grid fully loaded is the exposure
// fixed until close, making the projection honest.
const MAX_BASKET_ENTRIES = 5

// The gold price at which the floating loss would hit the bot's own
// balance-scaled auto-close threshold (lib/floatingRisk.ts — the level the
// dashboard shows as −100%). The bot has no per-position SL order; this
// threshold is its de facto basket-level stop, so showing the price it
// maps to answers "how far can gold go against us before the bot cuts".
function stopLossPrice(positions: OpenPosition[], balance: number): number | null {
  if (positions.length < MAX_BASKET_ENTRIES) return null
  const netLots = positions.reduce((s, p) => s + (p.direction === 'BUY' ? p.lots : -p.lots), 0)
  if (Math.abs(netLots) < 1e-9 || balance <= 0) return null
  const totalFloating = positions.reduce((s, p) => s + p.floatingPnl, 0)
  const floatingAtStop = -floatingMaxForBalance(balance)
  return positions[0].currentPrice + (floatingAtStop - totalFloating) / (USD_PER_LOT_PER_DOLLAR * netLots)
}

export function OpenPositionsCard({ positions, balance }: { positions: OpenPosition[]; balance: number }) {
  const formatCurrency = useCurrencyFormatter()
  const currentPrice = positions.length > 0 ? positions[0].currentPrice : null
  const bePrice = positions.length > 0 ? breakEvenPrice(positions) : null
  const slPrice = positions.length > 0 ? stopLossPrice(positions, balance) : null
  const totalFloating = positions.reduce((s, p) => s + p.floatingPnl, 0)
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Posicions obertes</h3>
        <span className="text-xs text-[var(--text-muted)]">
          {positions.length} {positions.length === 1 ? 'activa' : 'actives'}
        </span>
      </div>
      {currentPrice !== null && (
        <div className="mb-3 rounded-lg bg-[var(--surface-2)] px-3 py-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--text-muted)]">Preu actual</span>
            <span className="tabular font-semibold">{currentPrice.toFixed(2)} $</span>
          </div>
          {bePrice !== null && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--text-muted)]">Break-even</span>
                <span className="tabular font-semibold">{bePrice.toFixed(2)} $</span>
              </div>
              {slPrice !== null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--text-muted)]">SL (límit del bot)</span>
                  <span className="tabular font-semibold text-[var(--critical)]">{slPrice.toFixed(2)} $</span>
                </div>
              )}
              {totalFloating < 0 && (
                <div className="text-xs text-[var(--text-muted)]">
                  L’or ha de {bePrice > currentPrice ? 'pujar' : 'baixar'}{' '}
                  <span className="tabular font-medium text-[var(--text-secondary)]">
                    {Math.abs(bePrice - currentPrice).toFixed(2)} $
                  </span>{' '}
                  per recuperar el floating
                </div>
              )}
            </>
          )}
        </div>
      )}
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

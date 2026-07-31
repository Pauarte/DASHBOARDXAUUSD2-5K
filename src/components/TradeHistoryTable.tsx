import { Fragment, useEffect, useMemo, useState } from 'react'
import { groupIntoBaskets, worstFloatingDuringBasket, type FloatingPoint } from '../lib/stats'
import type { Trade } from '../lib/types'
import { formatDateTime, formatPercent } from '../lib/format'
import { useCurrencyFormatter } from '../lib/currency'

const directionStyle: Record<Trade['direction'], string> = {
  BUY: 'text-[var(--good-text)] bg-[var(--good)]/10',
  SELL: 'text-[var(--critical)] bg-[var(--critical)]/10',
}

const PAGE_SIZE = 20

export function TradeHistoryTable({
  trades,
  floatingHistory,
}: {
  trades: Trade[]
  floatingHistory: FloatingPoint[]
}) {
  const formatCurrency = useCurrencyFormatter()
  const baskets = useMemo(() => [...groupIntoBaskets(trades)].reverse(), [trades])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(baskets.length / PAGE_SIZE))
  const visibleBaskets = baskets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages))
  }, [totalPages])

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Historial de cistelles</h3>
        <span className="text-xs text-[var(--text-muted)]">
          {baskets.length} cistelles guardades
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
              <th className="font-medium py-2 pr-3 w-4"></th>
              <th className="font-medium py-2 pr-3">Tancament</th>
              <th className="font-medium py-2 pr-3">Direcció</th>
              <th className="font-medium py-2 pr-3">Entrades</th>
              <th className="font-medium py-2 pr-3">Lots</th>
              <th className="font-medium py-2 pr-3">Entrada mitjana</th>
              <th className="font-medium py-2 pr-3 text-right">Pitjor floating registrat</th>
              <th className="font-medium py-2 text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {visibleBaskets.map((basket) => {
              const key = basket.legs.map((l) => l.id).join('-')
              const isOpen = expanded.has(key)
              const first = basket.legs[0]
              const totalLots = basket.legs.reduce((s, l) => s + l.lots, 0)
              const avgEntry =
                basket.legs.reduce((s, l) => s + l.entryPrice * l.lots, 0) / (totalLots || 1)
              const worstFloating = worstFloatingDuringBasket(floatingHistory, basket)

              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => toggle(key)}
                    className="border-b border-[var(--border)] last:border-0 cursor-pointer hover:bg-[var(--surface-2)]"
                  >
                    <td className="py-2 pr-3 text-[var(--text-muted)]">
                      <span
                        className="inline-block transition-transform"
                        style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                      >
                        ›
                      </span>
                    </td>
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
                    <td
                      className={`py-2 pr-3 text-right tabular ${
                        worstFloating !== null && worstFloating.pct < 0
                          ? 'text-[var(--critical)]'
                          : 'text-[var(--text-secondary)]'
                      }`}
                      title={worstFloating !== null ? formatCurrency(worstFloating.value, { signed: true }) : undefined}
                    >
                      {worstFloating !== null ? formatPercent(worstFloating.pct, 0) : '—'}
                    </td>
                    <td
                      className={`py-2 text-right tabular font-semibold ${
                        basket.pnl >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
                      }`}
                    >
                      {formatCurrency(basket.pnl, { signed: true })}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2 pl-3" />
                      <td colSpan={7} className="py-2 pr-3">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="text-left text-[var(--text-muted)]">
                              <th className="font-medium py-1 pr-3">Entrada</th>
                              <th className="font-medium py-1 pr-3">Obertura</th>
                              <th className="font-medium py-1 pr-3">Tancament</th>
                              <th className="font-medium py-1 pr-3">Lots</th>
                              <th className="font-medium py-1 pr-3">Preu entrada</th>
                              <th className="font-medium py-1 pr-3">Preu sortida</th>
                              <th className="font-medium py-1 pr-3 text-right">Brut</th>
                              <th className="font-medium py-1 pr-3 text-right">Comissió</th>
                              <th className="font-medium py-1 pr-3 text-right">Swap</th>
                              <th className="font-medium py-1 text-right">P&amp;L</th>
                            </tr>
                          </thead>
                          <tbody>
                            {basket.legs.map((leg, i) => (
                              <tr key={leg.id} className="text-[var(--text-secondary)]">
                                <td className="py-1 pr-3 tabular">#{i + 1}</td>
                                <td className="py-1 pr-3 tabular whitespace-nowrap">
                                  {formatDateTime(leg.openTime)}
                                </td>
                                <td className="py-1 pr-3 tabular whitespace-nowrap">
                                  {formatDateTime(leg.closeTime)}
                                </td>
                                <td className="py-1 pr-3 tabular">{leg.lots.toFixed(2)}</td>
                                <td className="py-1 pr-3 tabular">{leg.entryPrice.toFixed(2)}</td>
                                <td className="py-1 pr-3 tabular">{leg.exitPrice.toFixed(2)}</td>
                                <td className="py-1 pr-3 text-right tabular">
                                  {formatCurrency(leg.grossProfit, { signed: true })}
                                </td>
                                <td className="py-1 pr-3 text-right tabular">
                                  {formatCurrency(leg.commission, { signed: true })}
                                </td>
                                <td className="py-1 pr-3 text-right tabular">
                                  {formatCurrency(leg.swap, { signed: true })}
                                </td>
                                <td
                                  className={`py-1 text-right tabular font-semibold ${
                                    leg.pnl >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
                                  }`}
                                >
                                  {formatCurrency(leg.pnl, { signed: true })}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {baskets.length > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
          <span>
            Pàgina {page} de {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-[var(--border)] px-3 py-1 disabled:opacity-40"
              disabled={page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Anterior
            </button>
            <button
              type="button"
              className="rounded border border-[var(--border)] px-3 py-1 disabled:opacity-40"
              disabled={page === totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Següent
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

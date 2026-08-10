// Deliberately mirrors src/lib/stats.ts's groupIntoBaskets()/worstFloatingDuringBasket()
// exactly. Duplicated (not imported) because this is a plain-JS Vercel
// function and the frontend module is TypeScript compiled by Vite - if you
// change the basket-close-gap or break-even logic in src/lib/stats.ts,
// mirror the change here too, or the API and the dashboard will disagree
// about what counts as one basket.

const BASKET_CLOSE_GAP_SECONDS = 3
const BASKET_BREAKEVEN_PCT = 0.12

// Same fixed genesis balance as src/lib/useAccountData.ts's
// ACCOUNT_START_BALANCE - kept as a real deposit figure, not derived, for
// the same reason documented there (deriving it from trade history alone
// silently drifts if a trade is ever missing from a sync pass). Duplicated
// here rather than imported because this is a plain-JS Vercel function and
// that module is TypeScript compiled by Vite - if that constant ever
// changes (an actual deposit/withdrawal), mirror the change here too.
export const ACCOUNT_START_BALANCE = 2496.6

// `trades` must be the FULL close_time-ordered history up to whatever
// cutoff you want (not a pre-windowed slice) - the running balance used
// for break-even classification below only comes out right if nothing
// between account inception and the cutoff is missing. Callers that only
// need a narrow window (e.g. "just today's raw legs") should filter the
// *returned* baskets by date afterwards, not pre-filter the input trades.
export function groupIntoBaskets(trades, startBalance = ACCOUNT_START_BALANCE) {
  // Date.parse (not string localeCompare) - Postgres's own text format for
  // timestamptz isn't guaranteed to be lexicographically sortable the same
  // way an ISO 8601 string is, so compare actual instants instead.
  const sorted = [...trades].sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))
  const groups = []

  for (const trade of sorted) {
    const current = groups[groups.length - 1]
    const previous = current?.[current.length - 1]
    const gapSeconds = previous
      ? (Date.parse(trade.close_time) - Date.parse(previous.close_time)) / 1000
      : Number.POSITIVE_INFINITY

    if (current && gapSeconds <= BASKET_CLOSE_GAP_SECONDS) current.push(trade)
    else groups.push([trade])
  }

  // Running balance across every leg, in close-time order, exactly like
  // useAccountData.ts's `running` accumulator - each leg's balanceAfter
  // feeds the next basket's balanceBefore.
  let running = startBalance
  const balanceAfterByTradeId = new Map()
  for (const trade of sorted) {
    running = Number((running + Number(trade.pnl)).toFixed(2))
    balanceAfterByTradeId.set(trade.trade_id ?? trade.id, running)
  }

  return groups.map((legs) => {
    const pnl = Number(legs.reduce((sum, t) => sum + Number(t.pnl), 0).toFixed(2))
    const openTime = legs.reduce((min, t) => (t.open_time < min ? t.open_time : min), legs[0].open_time)
    const closeTime = legs[legs.length - 1].close_time
    const lotsTotal = Number(legs.reduce((sum, t) => sum + Number(t.lots), 0).toFixed(2))
    const lotsMax = Math.max(...legs.map((t) => Number(t.lots)))
    const avgEntryPrice =
      legs.reduce((sum, t) => sum + Number(t.entry_price) * Number(t.lots), 0) /
      legs.reduce((sum, t) => sum + Number(t.lots), 0)

    // A basket that closes as a small *loss* within this % of balance is
    // almost certainly just swap fees eating a flat position, not a real
    // trading loss - counted as break-even instead of hurting win rate. A
    // small win is still a real win no matter how small. Mirrors
    // src/lib/stats.ts's groupIntoBaskets() exactly (same balanceBefore
    // math), so win rate here matches the public dashboard.
    const lastLegId = legs[legs.length - 1].trade_id ?? legs[legs.length - 1].id
    const balanceAfter = balanceAfterByTradeId.get(lastLegId)
    const balanceBefore = balanceAfter - pnl
    const pnlPct = balanceBefore > 0 ? (pnl / balanceBefore) * 100 : 0
    const isBreakEven = pnl < 0 && Math.abs(pnlPct) <= BASKET_BREAKEVEN_PCT

    return {
      // synthetic - no basket_id column exists upstream (see docs/SYNC_SCRIPT_SPEC.md)
      basketId: `${legs[0].trade_id ?? legs[0].id}-${legs.length}`,
      legs,
      legCount: legs.length,
      direction: legs[0].direction,
      openTime,
      closeTime,
      pnl,
      isWin: pnl > 0,
      isLoss: pnl < 0 && !isBreakEven,
      lotsTotal,
      lotsMax,
      avgEntryPrice: Number(avgEntryPrice.toFixed(2)),
      durationMinutes: Number(((Date.parse(closeTime) - Date.parse(openTime)) / 60000).toFixed(1)),
      closeReason: legs[legs.length - 1].exit_reason,
    }
  })
}

// Worst (most negative) account-wide floating P&L recorded while this
// basket was open. Reads the whole-account floating history, so if two
// baskets were ever open at once this would include the other one's
// contribution too - in practice this bot runs one basket at a time.
export function worstFloatingDuringBasket(history, basket) {
  const openMs = Date.parse(basket.openTime)
  const closeMs = Date.parse(basket.closeTime)
  let worst = null
  let best = null
  for (const point of history) {
    const t = Date.parse(point.recorded_at)
    if (t < openMs || t > closeMs) continue
    const value = Number(point.floating_pnl)
    if (worst === null || value < worst) worst = value
    if (best === null || value > best) best = value
  }
  return { worstFloating: worst, bestFloating: best }
}

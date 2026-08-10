import type { Trade } from './types'
import { dashboardDateKey, isWeekend } from './format'
import { floatingSeverityPct } from './floatingRisk'

export interface EquityPoint {
  time: string
  balance: number
  profit: number
  drawdownPct: number
}

export interface DailyPnl {
  date: string
  pnl: number
}

// A "trade" for stats purposes: every leg that closes within a few seconds
// of the previous one is the same basket (the bot has no per-leg stop loss —
// it adds same-direction legs and closes them all together, but each leg's
// close order can land a second or two apart). The basket's total P&L, not
// any single leg, decides win/loss.
export interface Basket {
  closeTime: string
  legs: Trade[]
  pnl: number
  isWin: boolean
  isLoss: boolean
}

const BASKET_CLOSE_GAP_SECONDS = 3

// A basket that closes as a small loss within this % of balance is almost
// certainly just swap fees eating a flat position, not a real trading loss
// — counted as break-even instead of hurting win rate.
const BASKET_BREAKEVEN_PCT = 0.12

export interface FloatingPoint {
  recordedAt: string
  floatingPnl: number
  balance: number
}

export interface WorstFloatingSeverity {
  value: number
  pct: number
}

// Worst (most negative) account-wide floating P&L recorded while this
// basket was open — how deep it went underwater before closing. Reads
// from the whole-account floating history, so if two baskets were ever
// open at once this would include the other one's contribution too; in
// practice this bot runs one basket at a time. The % is relative to the
// bot's own balance-scaled close threshold at that same moment (see
// lib/floatingRisk.ts), so it stays meaningful as the account grows.
// `history` must be sorted ascending by recordedAt (useAccountData.ts
// queries it that way, and only ever appends newer rows). With floating
// history now running into the tens of thousands of rows, scanning the
// whole array per basket — and this runs once per *visible table row*,
// every render — is the difference between an instant table and a
// multi-second stall once the account has been live a few weeks. Binary
// search for the window's edges, then only scan the (small) slice between
// them.
function lowerBound(history: FloatingPoint[], timeMs: number): number {
  let lo = 0
  let hi = history.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (new Date(history[mid].recordedAt).getTime() < timeMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function worstFloatingDuringBasket(
  history: FloatingPoint[],
  basket: Basket,
): WorstFloatingSeverity | null {
  const openTime = Math.min(...basket.legs.map((l) => new Date(l.openTime).getTime()))
  const closeTime = new Date(basket.closeTime).getTime()

  const start = lowerBound(history, openTime)
  const end = lowerBound(history, closeTime + 1) // exclusive upper bound, closeTime inclusive

  let worst: FloatingPoint | null = null
  for (let i = start; i < end; i++) {
    const point = history[i]
    if (worst === null || point.floatingPnl < worst.floatingPnl) worst = point
  }
  if (!worst) return null
  return { value: worst.floatingPnl, pct: floatingSeverityPct(worst.floatingPnl, worst.balance) }
}

export interface AccountStats {
  totalTrades: number
  wins: number
  losses: number
  breakEvens: number
  winRate: number
  totalPnl: number
  avgWin: number
  avgLoss: number
  bestTrade: number
  worstTrade: number
  maxDrawdownPct: number
  maxDrawdownMoney: number
  todayPnl: number
  avgDailyReturnPct: number
}

export function groupIntoBaskets(trades: Trade[]): Basket[] {
  const sorted = [...trades].sort((a, b) => a.closeTime.localeCompare(b.closeTime))

  const groups: Trade[][] = []
  for (const trade of sorted) {
    const current = groups[groups.length - 1]
    const prevTime = current ? new Date(current[current.length - 1].closeTime).getTime() : null
    const gapSeconds = prevTime !== null ? (new Date(trade.closeTime).getTime() - prevTime) / 1000 : Infinity

    if (current && gapSeconds <= BASKET_CLOSE_GAP_SECONDS) {
      current.push(trade)
    } else {
      groups.push([trade])
    }
  }

  return groups.map((legs) => {
    const pnl = Number(legs.reduce((s, t) => s + t.pnl, 0).toFixed(2))
    const closeTime = legs[legs.length - 1].closeTime
    const balanceBefore = legs[legs.length - 1].balanceAfter - pnl
    const pnlPct = balanceBefore > 0 ? (pnl / balanceBefore) * 100 : 0
    // Only a small *loss* gets reclassified as break-even (almost certainly
    // just swap fees eating a flat position) — a small win is still a real
    // win no matter how small.
    const isBreakEven = pnl < 0 && Math.abs(pnlPct) <= BASKET_BREAKEVEN_PCT
    return { closeTime, legs, pnl, isWin: pnl > 0, isLoss: pnl < 0 && !isBreakEven }
  })
}

export function buildEquityCurve(
  trades: Trade[],
  startBalance: number,
  currentBalance?: number,
  currentTime?: string | null,
): EquityPoint[] {
  let peak = startBalance
  const points: EquityPoint[] = [
    { time: trades[0]?.openTime ?? new Date().toISOString(), balance: startBalance, profit: 0, drawdownPct: 0 },
  ]

  for (const trade of trades) {
    peak = Math.max(peak, trade.balanceAfter)
    const drawdownPct = peak > 0 ? ((trade.balanceAfter - peak) / peak) * 100 : 0
    points.push({
      time: trade.closeTime,
      balance: trade.balanceAfter,
      profit: trade.balanceAfter - startBalance,
      drawdownPct,
    })
  }

  // currentBalance should already be capital-adjusted (genesis + real
  // trading P&L) by the caller, not the account's raw balance — otherwise
  // a partner deposit/withdrawal would show up here as a fake profit jump.
  if (currentBalance !== undefined) {
    const lastPoint = points[points.length - 1]
    if (Math.abs(lastPoint.balance - currentBalance) >= 0.01) {
      peak = Math.max(peak, currentBalance)
      const drawdownPct = peak > 0 ? ((currentBalance - peak) / peak) * 100 : 0
      points.push({
        time: currentTime ?? new Date().toISOString(),
        balance: currentBalance,
        profit: currentBalance - startBalance,
        drawdownPct,
      })
    }
  }

  return points
}

export function buildDailyPnl(trades: Trade[]): DailyPnl[] {
  const map = new Map<string, number>()
  for (const trade of trades) {
    const day = dashboardDateKey(trade.closeTime)
    map.set(day, Number(((map.get(day) ?? 0) + trade.pnl).toFixed(2)))
  }
  return Array.from(map.entries())
    .map(([date, pnl]) => ({ date, pnl }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// Each day's % return relative to the balance it actually started that day
// with — read from real balance snapshots (so a partner deposit/withdrawal
// on a previous day is correctly reflected), not simulated purely from
// trade P&L, which would ignore capital movements and skew every % after one.
// Both inputs are chronological (buildDailyPnl sorts, the history comes
// ordered from the query), so "balance just before each day" is one merged
// walk — the old version rescanned the entire history per day, which at
// 12k+ snapshots × N days was a real contributor to freezing the UI.
export function buildDailyReturnPct(
  trades: Trade[],
  startBalance: number,
  balanceHistory: { recordedAt: string; balance: number }[] = [],
): Map<string, number> {
  const daily = buildDailyPnl(trades)
  const pctByDay = new Map<string, number>()
  let historyIndex = 0
  let balanceBefore = startBalance
  for (const day of daily) {
    while (
      historyIndex < balanceHistory.length &&
      dashboardDateKey(balanceHistory[historyIndex].recordedAt) < day.date
    ) {
      balanceBefore = balanceHistory[historyIndex].balance
      historyIndex += 1
    }
    // The market is closed weekends — any weekend "day" in here is stray
    // data (or a sync artifact), not a real trading day, and shouldn't
    // dilute the daily average.
    if (isWeekend(day.date)) continue
    pctByDay.set(day.date, balanceBefore > 0 ? (day.pnl / balanceBefore) * 100 : 0)
  }
  return pctByDay
}

export function computeStats(
  trades: Trade[],
  startBalance: number,
  balanceHistory: { recordedAt: string; balance: number }[] = [],
): AccountStats {
  const baskets = groupIntoBaskets(trades)
  const totalTrades = baskets.length
  const wins = baskets.filter((b) => b.isWin)
  const losses = baskets.filter((b) => b.isLoss)
  const breakEvens = baskets.filter((b) => !b.isWin && !b.isLoss)

  const grossProfit = wins.reduce((s, b) => s + b.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, b) => s + b.pnl, 0))
  // Sum every basket's real money, not just wins minus losses — a
  // break-even basket still moved real dollars (e.g. a swap loss) even
  // though it's excluded from the win/loss labels above.
  const totalPnl = Number(baskets.reduce((s, b) => s + b.pnl, 0).toFixed(2))

  const equityCurve = buildEquityCurve(trades, startBalance)
  const maxDrawdownPct = Math.min(0, ...equityCurve.map((p) => p.drawdownPct))

  let peak = startBalance
  let maxDrawdownMoney = 0
  for (const t of trades) {
    peak = Math.max(peak, t.balanceAfter)
    maxDrawdownMoney = Math.min(maxDrawdownMoney, t.balanceAfter - peak)
  }

  const today = dashboardDateKey(new Date().toISOString())
  const todayPnl = trades
    .filter((t) => dashboardDateKey(t.closeTime) === today)
    .reduce((s, t) => s + t.pnl, 0)

  const decidedTrades = wins.length + losses.length
  const winRate = decidedTrades > 0 ? (wins.length / decidedTrades) * 100 : 0
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0

  // Average of each trading day's return, as a % of that day's actual
  // starting balance (real snapshot, deposits included) — not total return
  // divided by day count, so a big early day doesn't get diluted by the
  // (larger) balance of later days.
  const dailyReturnPcts = Array.from(buildDailyReturnPct(trades, startBalance, balanceHistory).values())
  const avgDailyReturnPct =
    dailyReturnPcts.length > 0
      ? dailyReturnPcts.reduce((s, p) => s + p, 0) / dailyReturnPcts.length
      : 0

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    breakEvens: breakEvens.length,
    winRate,
    totalPnl,
    avgWin,
    avgLoss,
    bestTrade: baskets.length ? Math.max(...baskets.map((b) => b.pnl)) : 0,
    worstTrade: baskets.length ? Math.min(...baskets.map((b) => b.pnl)) : 0,
    maxDrawdownPct,
    maxDrawdownMoney,
    todayPnl: Number(todayPnl.toFixed(2)),
    avgDailyReturnPct,
  }
}

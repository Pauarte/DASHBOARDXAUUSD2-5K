import type { Trade } from './types'

export interface EquityPoint {
  time: string
  balance: number
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

export interface FloatingPoint {
  recordedAt: string
  floatingPnl: number
}

// Worst (most negative) account-wide floating P&L recorded while this
// basket was open — how deep it went underwater before closing. Reads
// from the whole-account floating history, so if two baskets were ever
// open at once this would include the other one's contribution too; in
// practice this bot runs one basket at a time.
export function worstFloatingDuringBasket(history: FloatingPoint[], basket: Basket): number | null {
  const openTime = Math.min(...basket.legs.map((l) => new Date(l.openTime).getTime()))
  const closeTime = new Date(basket.closeTime).getTime()

  let worst: number | null = null
  for (const point of history) {
    const t = new Date(point.recordedAt).getTime()
    if (t < openTime || t > closeTime) continue
    if (worst === null || point.floatingPnl < worst) worst = point.floatingPnl
  }
  return worst
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
    return { closeTime, legs, pnl, isWin: pnl > 0, isLoss: pnl < 0 }
  })
}

export function buildEquityCurve(trades: Trade[], startBalance: number): EquityPoint[] {
  let peak = startBalance
  const points: EquityPoint[] = [
    { time: trades[0]?.openTime ?? new Date().toISOString(), balance: startBalance, drawdownPct: 0 },
  ]

  for (const trade of trades) {
    peak = Math.max(peak, trade.balanceAfter)
    const drawdownPct = peak > 0 ? ((trade.balanceAfter - peak) / peak) * 100 : 0
    points.push({ time: trade.closeTime, balance: trade.balanceAfter, drawdownPct })
  }

  return points
}

export function buildDailyPnl(trades: Trade[]): DailyPnl[] {
  const map = new Map<string, number>()
  for (const trade of trades) {
    const day = trade.closeTime.slice(0, 10)
    map.set(day, Number(((map.get(day) ?? 0) + trade.pnl).toFixed(2)))
  }
  return Array.from(map.entries())
    .map(([date, pnl]) => ({ date, pnl }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function computeStats(trades: Trade[], startBalance: number): AccountStats {
  const baskets = groupIntoBaskets(trades)
  const totalTrades = baskets.length
  const wins = baskets.filter((b) => b.isWin)
  const losses = baskets.filter((b) => b.isLoss)
  const breakEvens = baskets.filter((b) => !b.isWin && !b.isLoss)

  const grossProfit = wins.reduce((s, b) => s + b.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, b) => s + b.pnl, 0))
  const totalPnl = Number((grossProfit - grossLoss).toFixed(2))

  const equityCurve = buildEquityCurve(trades, startBalance)
  const maxDrawdownPct = Math.min(0, ...equityCurve.map((p) => p.drawdownPct))

  let peak = startBalance
  let maxDrawdownMoney = 0
  for (const t of trades) {
    peak = Math.max(peak, t.balanceAfter)
    maxDrawdownMoney = Math.min(maxDrawdownMoney, t.balanceAfter - peak)
  }

  const today = new Date().toISOString().slice(0, 10)
  const todayPnl = trades
    .filter((t) => t.closeTime.slice(0, 10) === today)
    .reduce((s, t) => s + t.pnl, 0)

  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0

  // Average of each trading day's return, as a % of that day's starting
  // balance — not total return divided by day count, so a big early day
  // doesn't get diluted by the (larger) balance of later days.
  const daily = buildDailyPnl(trades)
  let dayStartBalance = startBalance
  const dailyReturnPcts: number[] = []
  for (const day of daily) {
    if (dayStartBalance > 0) dailyReturnPcts.push((day.pnl / dayStartBalance) * 100)
    dayStartBalance = Number((dayStartBalance + day.pnl).toFixed(2))
  }
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

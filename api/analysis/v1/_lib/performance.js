const MADRID_TIMEZONE = 'Europe/Madrid'

export function madridDateKey(value) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: MADRID_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

// ISO week (Mon-Sun) key in Europe/Madrid, e.g. "2026-W32".
export function madridWeekKey(value) {
  const dateKey = madridDateKey(value)
  const d = new Date(`${dateKey}T00:00:00Z`)
  const dayNum = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function madridMonthKey(value) {
  return madridDateKey(value).slice(0, 7)
}

function statsOf(numbers) {
  if (numbers.length === 0) return { avg: null, median: null, min: null, max: null }
  const sorted = [...numbers].sort((a, b) => a - b)
  const avg = numbers.reduce((s, n) => s + n, 0) / numbers.length
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { avg: round2(avg), median: round2(median), min: round2(sorted[0]), max: round2(sorted[sorted.length - 1]) }
}

function round2(n) {
  return n === null || n === undefined ? null : Number(n.toFixed(2))
}

// One period's rollup (a day, a week, a month, a rolling window) built from
// a pre-filtered list of baskets.
export function summarizePeriod(baskets) {
  const wins = baskets.filter((b) => b.isWin)
  const losses = baskets.filter((b) => b.isLoss)
  const grossProfit = round2(wins.reduce((s, b) => s + b.pnl, 0))
  const grossLoss = round2(Math.abs(losses.reduce((s, b) => s + b.pnl, 0)))
  const netProfit = round2(baskets.reduce((s, b) => s + b.pnl, 0))
  const decided = wins.length + losses.length
  const winRatePct = decided > 0 ? round2((wins.length / decided) * 100) : null
  const avgWin = wins.length ? round2(grossProfit / wins.length) : null
  const avgLoss = losses.length ? round2(grossLoss / losses.length) : null
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : null
  // expectancy in $ per basket = winRate*avgWin - lossRate*avgLoss
  const expectancy =
    decided > 0
      ? round2((wins.length / decided) * (avgWin ?? 0) - (losses.length / decided) * (avgLoss ?? 0))
      : null

  return {
    baskets_count: baskets.length,
    wins: wins.length,
    losses: losses.length,
    break_evens: baskets.length - wins.length - losses.length,
    win_rate_pct: winRatePct,
    gross_profit: grossProfit,
    gross_loss: grossLoss,
    net_profit: netProfit,
    profit_factor: profitFactor,
    expectancy_usd: expectancy,
    avg_win: avgWin,
    avg_loss: avgLoss,
    best_basket: baskets.length ? round2(Math.max(...baskets.map((b) => b.pnl))) : null,
    worst_basket: baskets.length ? round2(Math.min(...baskets.map((b) => b.pnl))) : null,
    duration_minutes: statsOf(baskets.map((b) => b.durationMinutes)),
  }
}

export function returnPctOf(pnl, startBalance) {
  if (!(startBalance > 0)) return null
  return round2((pnl / startBalance) * 100)
}

// Longest consecutive run of wins / losses, in basket close order.
export function streaks(baskets) {
  const sorted = [...baskets].sort((a, b) => String(a.closeTime).localeCompare(String(b.closeTime)))
  let maxWin = 0
  let maxLoss = 0
  let curWin = 0
  let curLoss = 0
  for (const b of sorted) {
    if (b.isWin) {
      curWin += 1
      curLoss = 0
    } else if (b.isLoss) {
      curLoss += 1
      curWin = 0
    } else {
      curWin = 0
      curLoss = 0
    }
    maxWin = Math.max(maxWin, curWin)
    maxLoss = Math.max(maxLoss, curLoss)
  }
  return { max_win_streak: maxWin, max_loss_streak: maxLoss }
}

export function positiveNegativeDays(baskets) {
  const byDay = new Map()
  for (const b of baskets) {
    const key = madridDateKey(b.closeTime)
    byDay.set(key, round2((byDay.get(key) ?? 0) + b.pnl))
  }
  let positive = 0
  let negative = 0
  for (const pnl of byDay.values()) {
    if (pnl > 0) positive += 1
    else if (pnl < 0) negative += 1
  }
  return { positive_days: positive, negative_days: negative, days_with_activity: byDay.size }
}

import type { AccountSnapshot, Direction, ExitReason, OpenPosition, Trade } from './types'

// Deterministic PRNG so the demo dataset is stable across reloads.
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20260511)

const START_BALANCE = 2500
const START_DATE = new Date('2026-05-11T14:00:00')

function skipWeekend(date: Date): Date {
  let d = date
  while (d.getUTCDay() === 6 || d.getUTCDay() === 0) {
    d = new Date(d.getTime() + 6 * 3600 * 1000)
  }
  return d
}

function pickLegCount(): number {
  const r = rand()
  if (r < 0.55) return 1
  if (r < 0.85) return 2
  return 3
}

// The bot adds same-direction legs to a basket and closes all of them
// together once the basket hits its target (or a time/manual exit) —
// there is no per-leg stop loss, so a "trade" for stats purposes is the
// whole basket, identified by every leg sharing the same close time.
function generateTrades(basketCount: number): Trade[] {
  const trades: Trade[] = []
  let balance = START_BALANCE
  let cursor = new Date(START_DATE)

  for (let b = 0; b < basketCount; b++) {
    cursor = skipWeekend(new Date(cursor.getTime() + (2 + rand() * 12) * 3600 * 1000))

    const direction: Direction = rand() > 0.48 ? 'BUY' : 'SELL'
    const legCount = pickLegCount()
    const basketId = `b${b + 1}`
    const referencePrice = 3000 + rand() * 1900

    const basketIsWin = rand() < 0.52
    const riskMoney = balance * (0.4 + rand() * 0.5 * legCount) / 100
    const basketPnl = Number(
      (basketIsWin ? riskMoney * (1.3 + rand() * 1.8) : -riskMoney * (0.6 + rand() * 0.7)).toFixed(2),
    )
    const exitReason: ExitReason = basketIsWin
      ? rand() < 0.8
        ? 'TP'
        : 'TIME'
      : rand() < 0.75
        ? 'MANUAL'
        : 'TIME'

    // stagger leg entries, then close every leg at the same instant
    const legOpenTimes: Date[] = []
    let legCursor = cursor
    for (let i = 0; i < legCount; i++) {
      legOpenTimes.push(legCursor)
      legCursor = new Date(legCursor.getTime() + (8 + rand() * 35) * 60 * 1000)
    }
    const closeTime = new Date(legCursor.getTime() + (20 + rand() * 180) * 60 * 1000)

    // split basket pnl across legs (grid-style: later legs carry more size),
    // last leg absorbs the rounding remainder so the sum is exact
    const weights = Array.from({ length: legCount }, (_, i) => 1 + i * 0.6)
    const weightSum = weights.reduce((s, w) => s + w, 0)
    let allocated = 0

    for (let i = 0; i < legCount; i++) {
      const lots = Number((0.05 + i * 0.03 + rand() * 0.1).toFixed(2))
      const entryPrice = Number((referencePrice + (rand() - 0.5) * (direction === 'BUY' ? -12 : 12) * (i + 1)).toFixed(2))

      let legPnl: number
      if (i === legCount - 1) {
        legPnl = Number((basketPnl - allocated).toFixed(2))
      } else {
        const share = Number(((basketPnl * weights[i]) / weightSum).toFixed(2))
        // individual legs can still print small opposite-sign noise, the
        // basket total is what decides win/loss
        legPnl = Number((share + (rand() - 0.5) * Math.abs(share) * 0.3).toFixed(2))
        allocated += legPnl
      }

      const priceMove = legPnl / (lots * 100)
      const exitPrice = Number((entryPrice + (direction === 'BUY' ? priceMove : -priceMove)).toFixed(2))

      balance = Number((balance + legPnl).toFixed(2))

      trades.push({
        id: `${basketId}-${i + 1}`,
        basketId,
        openTime: legOpenTimes[i].toISOString(),
        closeTime: closeTime.toISOString(),
        direction,
        lots,
        entryPrice,
        exitPrice,
        pnl: legPnl,
        exitReason,
        balanceAfter: balance,
      })
    }

    cursor = closeTime
  }

  return trades
}

export const mockTrades: Trade[] = generateTrades(100)

export const mockOpenPositions: OpenPosition[] = [
  {
    id: 'open-1',
    openTime: new Date(Date.now() - 3.2 * 3600 * 1000).toISOString(),
    direction: 'BUY',
    lots: 0.12,
    entryPrice: 4712.35,
    currentPrice: 4726.8,
    floatingPnl: 17.34,
  },
]

const lastBalance = mockTrades[mockTrades.length - 1]?.balanceAfter ?? START_BALANCE
const floatingTotal = mockOpenPositions.reduce((sum, p) => sum + p.floatingPnl, 0)

export const mockAccount: AccountSnapshot = {
  startBalance: START_BALANCE,
  balance: lastBalance,
  equity: Number((lastBalance + floatingTotal).toFixed(2)),
  currency: 'USD',
  symbol: 'XAUUSD',
}

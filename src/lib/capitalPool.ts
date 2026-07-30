import { dashboardDateKey } from './format'
import type { Trade } from './types'

export type ContributionType = 'deposit' | 'withdrawal'

export interface ContributionRow {
  id: number
  personName: string
  type: ContributionType
  amount: number
  poolValueBefore: number
  unitsBefore: number
  unitsDelta: number
  note: string | null
  createdAt: string
}

export interface PersonStake {
  personName: string
  units: number
  netContributed: number
  percentage: number
  currentValue: number
}

// Fund-unit accounting: every deposit "buys" units at the pool's current
// NAV-per-unit (pool value / total units), every withdrawal "sells" units
// at the same price. Ownership % is just a person's share of total units,
// so profit/loss is automatically split proportionally without ever
// needing to be recalculated by hand — exactly how mutual funds do it.
export function navPerUnit(poolValueBefore: number, unitsBefore: number): number {
  if (unitsBefore <= 0) return 1 // first-ever contribution defines the starting unit price
  if (poolValueBefore <= 0) return 0.000001 // pool wiped out — avoid divide-by-zero
  return poolValueBefore / unitsBefore
}

export function unitsForAmount(amount: number, poolValueBefore: number, unitsBefore: number): number {
  return amount / navPerUnit(poolValueBefore, unitsBefore)
}

export interface PersonValuePoint {
  time: string
  value: number
}

// Reconstructs one person's $ value over time from the account's balance
// history plus the contribution ledger — at each balance snapshot, the
// person's value is (their units at that point / total units at that
// point) * balance. Both inputs must already be sorted ascending by time.
export function personValueOverTime(
  rows: ContributionRow[],
  personName: string,
  balanceHistory: { recordedAt: string; balance: number }[],
): PersonValuePoint[] {
  const points: PersonValuePoint[] = []
  let rowIndex = 0
  let totalUnits = 0
  let personUnits = 0

  for (const snapshot of balanceHistory) {
    while (rowIndex < rows.length && rows[rowIndex].createdAt <= snapshot.recordedAt) {
      const row = rows[rowIndex]
      totalUnits += row.unitsDelta
      if (row.personName === personName) personUnits += row.unitsDelta
      rowIndex += 1
    }
    // Skip everything before this person's first contribution — otherwise
    // the chart shows a flat $0 line for the whole account history before
    // they even joined, instead of starting right at their own first value.
    if (totalUnits > 0 && personUnits > 0) {
      points.push({ time: snapshot.recordedAt, value: (personUnits / totalUnits) * snapshot.balance })
    }
  }

  return points
}

// Today's $ and % change in a person's own value — measured from their
// value at the start of today (Europe/Madrid), or from their first-ever
// value point if they joined today (there's no "start of day" before that).
export function personTodayChange(
  valueHistory: PersonValuePoint[],
  currentValue: number,
): { pnl: number; pct: number } {
  const today = dashboardDateKey(new Date().toISOString())
  let startOfDayValue: number | null = null
  for (const point of valueHistory) {
    if (dashboardDateKey(point.time) < today) startOfDayValue = point.value
  }
  if (startOfDayValue === null) startOfDayValue = valueHistory[0]?.value ?? currentValue

  const pnl = currentValue - startOfDayValue
  const pct = startOfDayValue > 0 ? (pnl / startOfDayValue) * 100 : 0
  return { pnl, pct }
}

// Rescales each trade's pnl to one person's own share, using the ownership
// % that was actually true at that trade's close time (not their current
// %) — so days/baskets from before they joined correctly show $0 for them
// instead of applying today's % retroactively. Feed the result into
// buildDailyPnl / CalendarHeatmap unchanged to get a personalized view.
export function scaleTradesForPerson(trades: Trade[], rows: ContributionRow[], personName: string): Trade[] {
  const sortedRows = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return trades.map((trade) => {
    let totalUnits = 0
    let personUnits = 0
    for (const row of sortedRows) {
      if (row.createdAt > trade.closeTime) break
      totalUnits += row.unitsDelta
      if (row.personName === personName) personUnits += row.unitsDelta
    }
    const fraction = totalUnits > 0 ? personUnits / totalUnits : 0
    return { ...trade, pnl: trade.pnl * fraction }
  })
}

export function computeStakes(rows: ContributionRow[], currentPoolValue: number): PersonStake[] {
  const totalUnits = rows.reduce((s, r) => s + r.unitsDelta, 0)

  const byPerson = new Map<string, { units: number; net: number }>()
  for (const r of rows) {
    const entry = byPerson.get(r.personName) ?? { units: 0, net: 0 }
    entry.units += r.unitsDelta
    entry.net += r.type === 'deposit' ? r.amount : -r.amount
    byPerson.set(r.personName, entry)
  }

  return Array.from(byPerson.entries())
    .map(([personName, { units, net }]) => ({
      personName,
      units,
      netContributed: net,
      percentage: totalUnits > 0 ? (units / totalUnits) * 100 : 0,
      currentValue: totalUnits > 0 ? (units / totalUnits) * currentPoolValue : 0,
    }))
    .sort((a, b) => b.units - a.units)
}

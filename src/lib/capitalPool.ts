import { dashboardDateKey, isWeekend } from './format'
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

export interface ContributionDbRow {
  id: number
  person_name: string
  type: ContributionType
  amount: string | number
  pool_value_before: string | number
  units_before: string | number
  units_delta: string | number
  note: string | null
  created_at: string
}

export function mapContributionRow(r: ContributionDbRow): ContributionRow {
  return {
    id: r.id,
    personName: r.person_name,
    type: r.type,
    amount: Number(r.amount),
    poolValueBefore: Number(r.pool_value_before),
    unitsBefore: Number(r.units_before),
    unitsDelta: Number(r.units_delta),
    note: r.note,
    createdAt: r.created_at,
  }
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

// A contribution's real money can land in the account before someone gets
// around to registering it in the ledger (the row is created after the
// fact) — if we only gated on createdAt, every snapshot in that gap would
// pair the *new* balance with the *old* unit count, making everyone's value
// spike by the deposit amount until the row's timestamp caught up. Treat a
// contribution as already in effect the moment the balance itself reflects
// it, whichever comes first.
function contributionInEffect(row: ContributionRow, snapshot: { recordedAt: string; balance: number }): boolean {
  if (row.createdAt <= snapshot.recordedAt) return true
  const signedAmount = row.type === 'deposit' ? row.amount : -row.amount
  const expectedBalance = row.poolValueBefore + signedAmount
  return signedAmount >= 0 ? snapshot.balance >= expectedBalance - 0.01 : snapshot.balance <= expectedBalance + 0.01
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
    while (rowIndex < rows.length && contributionInEffect(rows[rowIndex], snapshot)) {
      const row = rows[rowIndex]
      totalUnits += row.unitsDelta
      if (row.personName === personName) personUnits += row.unitsDelta
      rowIndex += 1
    }
    // The market is closed weekends — those snapshots are just the balance
    // sitting flat, and including one-per-minute of them turns the chart
    // into a long horizontal plateau every Sat/Sun for no informational
    // value. Skip them.
    if (isWeekend(dashboardDateKey(snapshot.recordedAt))) continue
    // Skip everything before this person's first contribution — otherwise
    // the chart shows a flat $0 line for the whole account history before
    // they even joined, instead of starting right at their own first value.
    if (totalUnits > 0 && personUnits > 0) {
      points.push({ time: snapshot.recordedAt, value: (personUnits / totalUnits) * snapshot.balance })
    }
  }

  return points
}

function valueBeforeDay(valueHistory: PersonValuePoint[], day: string): number | null {
  let result: number | null = null
  for (const point of valueHistory) {
    if (dashboardDateKey(point.time) < day) result = point.value
  }
  return result
}

// Today's $ and % change in a person's own value — measured from their
// value at the start of today (Europe/Madrid), or from their first-ever
// value point if they joined today (there's no "start of day" before that).
export function personTodayChange(
  valueHistory: PersonValuePoint[],
  currentValue: number,
): { pnl: number; pct: number } {
  const today = dashboardDateKey(new Date().toISOString())
  const startOfDayValue = valueBeforeDay(valueHistory, today) ?? valueHistory[0]?.value ?? currentValue

  const pnl = currentValue - startOfDayValue
  const pct = startOfDayValue > 0 ? (pnl / startOfDayValue) * 100 : 0
  return { pnl, pct }
}

// Same idea as personTodayChange but for every day in the person's own
// (already-scaled) daily P&L — % relative to their own value at the start
// of that day, not the whole bot's balance. Days before they joined have
// $0 pnl already, so they correctly show 0%.
// dailyPnl comes from buildDailyPnl (sorted ascending) and valueHistory is
// chronological, so this is a single merged walk instead of rescanning the
// whole (12k+ point) history once per day like valueBeforeDay would.
export function personDailyReturnPct(
  dailyPnl: { date: string; pnl: number }[],
  valueHistory: PersonValuePoint[],
): Map<string, number> {
  const pctByDay = new Map<string, number>()
  let historyIndex = 0
  let valueBefore: number | null = null
  for (const day of dailyPnl) {
    while (historyIndex < valueHistory.length && dashboardDateKey(valueHistory[historyIndex].time) < day.date) {
      valueBefore = valueHistory[historyIndex].value
      historyIndex += 1
    }
    if (isWeekend(day.date)) continue
    pctByDay.set(day.date, valueBefore && valueBefore > 0 ? (day.pnl / valueBefore) * 100 : 0)
  }
  return pctByDay
}

// Rescales each trade's pnl to one person's own share, using the ownership
// % that was actually true at that trade's close time (not their current
// %) — so days/baskets from before they joined correctly show $0 for them
// instead of applying today's % retroactively. Feed the result into
// buildDailyPnl / CalendarHeatmap unchanged to get a personalized view.
export function scaleTradesForPerson(trades: Trade[], rows: ContributionRow[], personName: string): Trade[] {
  const sortedRows = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return trades.flatMap((trade) => {
    let totalUnits = 0
    let personUnits = 0
    for (const row of sortedRows) {
      if (row.createdAt > trade.closeTime) break
      totalUnits += row.unitsDelta
      if (row.personName === personName) personUnits += row.unitsDelta
    }
    const fraction = totalUnits > 0 ? personUnits / totalUnits : 0
    // A trade from before this person joined is not one of their trades.
    // Keeping it with a synthetic $0 P&L distorted operation counts,
    // break-evens and win rate on the personal dashboard.
    return fraction > 0 ? [{ ...trade, pnl: trade.pnl * fraction }] : []
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

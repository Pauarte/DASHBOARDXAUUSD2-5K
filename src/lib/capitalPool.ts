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

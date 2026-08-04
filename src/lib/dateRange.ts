import { dashboardDateKey } from './format'

// start/end are inclusive dashboard dates ("YYYY-MM-DD", Europe/Madrid) —
// null on either side means unbounded in that direction, {start: null, end:
// null} means "everything".
export interface DateRange {
  start: string | null
  end: string | null
}

export const ALL_TIME: DateRange = { start: null, end: null }

export function isWithinRange(dateKey: string, range: DateRange): boolean {
  if (range.start && dateKey < range.start) return false
  if (range.end && dateKey > range.end) return false
  return true
}

export function filterByCloseTime<T extends { closeTime: string }>(items: T[], range: DateRange): T[] {
  if (!range.start && !range.end) return items
  return items.filter((item) => isWithinRange(dashboardDateKey(item.closeTime), range))
}

export function filterByRecordedAt<T extends { recordedAt: string }>(items: T[], range: DateRange): T[] {
  if (!range.start && !range.end) return items
  return items.filter((item) => isWithinRange(dashboardDateKey(item.recordedAt), range))
}

// The real balance the moment the range began — lets stats/equity curves
// for a filtered period be indexed from what the account actually held
// going in, instead of the account's all-time genesis balance (which would
// make a "last 7 days" view show a curve/drawdown that includes months of
// unrelated prior growth).
export function balanceAtRangeStart(
  history: { recordedAt: string; balance: number }[],
  range: DateRange,
  fallback: number,
): number {
  if (!range.start) return fallback
  let result = fallback
  for (const point of history) {
    if (dashboardDateKey(point.recordedAt) < range.start) result = point.balance
  }
  return result
}

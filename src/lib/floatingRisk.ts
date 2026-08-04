// Mirrors the bot's own basket-close logic: the floating loss at which it
// closes a basket isn't a fixed dollar amount, it scales with balance — so
// a raw $ "worst floating" number means less and less as the account
// grows. Expressing it as a % of this same threshold (the floating level
// at which the bot would have closed anyway) stays meaningful at any
// balance: -100% means "right at the bot's own close threshold."
const FLOATING_BASE = 350
const RESERVE_PCT = 20
const BALANCE_REFERENCE = 2500
const FACTOR_MIN = 0.01
const FACTOR_MAX = 400

export function floatingMaxForBalance(balance: number): number {
  const rawFactor = (balance * (1 - RESERVE_PCT / 100)) / BALANCE_REFERENCE
  const factor = Math.min(Math.max(rawFactor, FACTOR_MIN), FACTOR_MAX)
  return FLOATING_BASE * factor
}

// Negative floatingPnl / positive floatingMax -> a negative %, e.g. -80%
// means the basket was 80% of the way to the bot's own auto-close level.
export function floatingSeverityPct(floatingPnl: number, balance: number): number {
  const floatingMax = floatingMaxForBalance(balance)
  return floatingMax > 0 ? (floatingPnl / floatingMax) * 100 : 0
}

// The single worst (most negative) floating point within a slice of
// history — feed it the full account history for the all-time figure, or
// a date-filtered slice to scope "worst floating" to whatever period the
// dashboard is currently filtered to.
export function worstFloatingIn(
  history: { recordedAt: string; floatingPnl: number; balance: number }[],
): { value: number; pct: number; at: string } | null {
  let worst: { recordedAt: string; floatingPnl: number; balance: number } | null = null
  for (const point of history) {
    if (worst === null || point.floatingPnl < worst.floatingPnl) worst = point
  }
  if (!worst) return null
  return { value: worst.floatingPnl, pct: floatingSeverityPct(worst.floatingPnl, worst.balance), at: worst.recordedAt }
}

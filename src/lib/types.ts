export type Direction = 'BUY' | 'SELL'

// No fixed stop loss: this bot closes baskets on a profit target (TP),
// a time-based exit, or a manual/risk-driven close.
export type ExitReason = 'TP' | 'MANUAL' | 'TIME' | 'BOT'

export interface Trade {
  id: string
  basketId: string
  openTime: string
  closeTime: string
  direction: Direction
  lots: number
  entryPrice: number
  exitPrice: number
  pnl: number
  exitReason: ExitReason
  balanceAfter: number
  positionId: string | null
  grossProfit: number
  commission: number
  swap: number
  fee: number
}

export interface OpenPosition {
  id: string
  openTime: string
  direction: Direction
  lots: number
  entryPrice: number
  currentPrice: number
  floatingPnl: number
}

export interface AccountSnapshot {
  startBalance: number
  balance: number
  equity: number
  currency: string
  symbol: string
}

export interface TechnicalTelemetry {
  updatedAt: string
  botVersionKey: string
  marginFree: number
  marginLevel: number
  positionCount: number
  totalLots: number
  drawdownAmount: number
  drawdownPct: number
  intradayDrawdownAmount: number
  intradayDrawdownPct: number
  effectiveBaseLot: number
  effectiveMaxTotalLot: number
  effectiveMaxFloatingLoss: number
  floatingLimitUsedPct: number
  lotLimitUsedPct: number
  bid: number | null
  ask: number | null
  spreadPoints: number | null
  atrM1: number | null
  atrM5: number | null
  spreadAtrRatio: number | null
  rsiM1: number | null
  adxM1: number | null
  recentMove5m: number | null
  recentMove15m: number | null
  recentMove60m: number | null
  newsBlockActive: boolean
  newsBlockReason: string | null
  rolloverBlockActive: boolean
  dayWorstFloating: number
  dayMaxFloatingLimitUsedPct: number
  dayMaxSpreadPoints: number | null
  dayMaxSpreadAtrRatio: number | null
  dayMinMarginLevel: number | null
  dayWorstIntradayDrawdownPct: number
  syncDurationMs: number
}

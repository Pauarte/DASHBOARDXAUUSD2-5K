export type Direction = 'BUY' | 'SELL'

// No fixed stop loss: this bot closes baskets on a profit target (TP),
// a time-based exit, or a manual/risk-driven close.
export type ExitReason = 'TP' | 'MANUAL' | 'TIME'

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

export type ReportPeriod = 'daily' | 'weekly' | 'monthly'

export interface AnalysisReport {
  id: number
  botId: string
  reportDate: string
  period: ReportPeriod
  title: string
  content: string
  updatedAt: string
}

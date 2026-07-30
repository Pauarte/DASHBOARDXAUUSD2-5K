import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured, fetchAllRows } from './supabaseClient'
import { mockAccount, mockOpenPositions, mockTrades } from './mockData'
import type {
  AccountSnapshot,
  Direction,
  ExitReason,
  OpenPosition,
  TechnicalTelemetry,
  Trade,
} from './types'
import type { FloatingPoint } from './stats'
import { floatingSeverityPct } from './floatingRisk'

const ACCOUNT_ID = import.meta.env.VITE_MT5_ACCOUNT || mockAccount.symbol
const REFRESH_INTERVAL_MS = 30_000
export const STALE_AFTER_MS = 3 * 60_000

// The actual initial deposit into this account. Fixed on purpose, not
// derived from balance/trade data — deriving it as "current balance minus
// synced trades' P&L" silently drifted upward whenever a trade was missing
// from the trades table (lookback window, sync gaps, etc.), which made the
// dashboard show a moving "start balance" instead of the real one. Only
// change this number if money is actually deposited into or withdrawn
// from the account.
const ACCOUNT_START_BALANCE = 2496.6

export interface WorstFloating {
  value: number
  pct: number
  at: string
}

interface AccountData {
  trades: Trade[]
  openPositions: OpenPosition[]
  account: AccountSnapshot
  isLive: boolean
  loading: boolean
  worstFloating: WorstFloating | null
  floatingHistory: FloatingPoint[]
  totalNetCapital: number
  lastSyncAt: string | null
  isStale: boolean
  syncAgeSeconds: number | null
  lastCheckedAt: string | null
  connectionError: string | null
  telemetry: TechnicalTelemetry | null
}

type StoredAccountData = Omit<AccountData, 'isStale' | 'syncAgeSeconds'>

const FALLBACK: StoredAccountData = {
  trades: mockTrades,
  openPositions: mockOpenPositions,
  account: mockAccount,
  isLive: false,
  loading: false,
  worstFloating: null,
  floatingHistory: [],
  totalNetCapital: ACCOUNT_START_BALANCE,
  lastSyncAt: null,
  lastCheckedAt: null,
  connectionError: null,
  telemetry: null,
}

interface TradeRow {
  id: number
  basket_id?: string | null
  direction: Direction
  lots: string | number
  entry_price: string | number
  exit_price: string | number
  open_time: string
  close_time: string
  pnl: string | number
  exit_reason: ExitReason
  position_id?: number | null
  gross_profit?: string | number | null
  commission?: string | number | null
  swap?: string | number | null
  fee?: string | number | null
}

interface OpenPositionRow {
  mt5_ticket: number
  direction: Direction
  lots: string | number
  entry_price: string | number
  current_price: string | number
  open_time: string
  floating_pnl: string | number
}

interface AccountSnapshotRow {
  balance: string | number
  equity: string | number
  currency: string
  updated_at: string
}

interface TelemetrySummaryRow {
  updated_at: string
  bot_version_key: string
  margin_free: string | number
  margin_level: string | number
  position_count: number
  total_lots: string | number
  drawdown_amount: string | number
  drawdown_pct: string | number
  intraday_drawdown_amount: string | number
  intraday_drawdown_pct: string | number
  effective_base_lot: string | number
  effective_max_total_lot: string | number
  effective_max_floating_loss: string | number
  floating_limit_used_pct: string | number
  lot_limit_used_pct: string | number
  bid: string | number | null
  ask: string | number | null
  spread_points: string | number | null
  atr_m1: string | number | null
  atr_m5: string | number | null
  spread_atr_ratio: string | number | null
  rsi_m1: string | number | null
  adx_m1: string | number | null
  recent_move_5m: string | number | null
  recent_move_15m: string | number | null
  recent_move_60m: string | number | null
  news_block_active: boolean
  news_block_reason: string | null
  rollover_block_active: boolean
  day_worst_floating: string | number
  day_max_floating_limit_used_pct: string | number
  day_max_spread_points: string | number | null
  day_max_spread_atr_ratio: string | number | null
  day_min_margin_level: string | number | null
  day_worst_intraday_drawdown_pct: string | number
  sync_duration_ms: number
}

function optionalNumber(value: string | number | null): number | null {
  if (value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

async function fetchTrades() {
  try {
    const data = await fetchAllRows<TradeRow>((from, to) =>
      supabase!
        .from('trades')
        .select(
          'id,basket_id,position_id,direction,lots,entry_price,exit_price,open_time,' +
            'close_time,pnl,gross_profit,commission,swap,fee,exit_reason',
        )
        .eq('account', ACCOUNT_ID)
        .order('close_time', { ascending: true })
        .returns<TradeRow[]>()
        .range(from, to),
    )
    return { data, error: null }
  } catch {
    try {
      const data = await fetchAllRows<TradeRow>((from, to) =>
        supabase!
          .from('trades')
          .select('id,direction,lots,entry_price,exit_price,open_time,close_time,pnl,exit_reason')
          .eq('account', ACCOUNT_ID)
          .order('close_time', { ascending: true })
          .returns<TradeRow[]>()
          .range(from, to),
      )
      return { data, error: null }
    } catch (error) {
      return { data: null, error }
    }
  }
}

export function useAccountData(): AccountData {
  const [data, setData] = useState<StoredAccountData>({
    ...FALLBACK,
    loading: isSupabaseConfigured,
  })
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!supabase) return
    let cancelled = false

    async function load() {
      const [tradesRes, positionsRes, snapshotRes, worstFloatingRes, floatingHistoryRes, capitalRes, telemetryRes] = await Promise.all([
        fetchTrades(),
        supabase!
          .from('open_positions')
          .select('mt5_ticket, direction, lots, entry_price, current_price, open_time, floating_pnl')
          .eq('account', ACCOUNT_ID),
        supabase!
          .from('account_snapshots')
          .select('balance, equity, currency, updated_at')
          .eq('account', ACCOUNT_ID)
          .maybeSingle(),
        // floating_pnl_snapshots may not exist yet on older deployments — tolerate the error.
        supabase!
          .from('floating_pnl_snapshots')
          .select('floating_pnl, recorded_at, balance')
          .eq('account', ACCOUNT_ID)
          .order('floating_pnl', { ascending: true })
          .limit(1)
          .maybeSingle()
          .then(
            (res) => res,
            () => ({ data: null, error: null }),
          ),
        // Full history (not just the worst point), used to find the worst
        // floating reached during each individual closed operation. Paged
        // via fetchAllRows — a single .limit() silently caps at Supabase's
        // max-rows (1000) once the table grows past that.
        fetchAllRows<{ floating_pnl: string | number; recorded_at: string; balance: string | number }>((from, to) =>
          supabase!
            .from('floating_pnl_snapshots')
            .select('floating_pnl, recorded_at, balance')
            .eq('account', ACCOUNT_ID)
            .order('recorded_at', { ascending: true })
            .range(from, to),
        )
          .then((data) => ({ data, error: null }))
          .catch(() => ({ data: null, error: null })),
        // Partner deposits/withdrawals (from /socis) — the real "how much
        // money is currently invested" baseline, which grows/shrinks every
        // time someone adds or takes out capital. Tolerate the table not
        // existing yet.
        supabase!
          .from('capital_contributions')
          .select('type, amount')
          .then(
            (res) => res,
            () => ({ data: null, error: null }),
          ),
        supabase!
          .from('telemetry_summary')
          .select(
            'updated_at,bot_version_key,margin_free,margin_level,position_count,total_lots,' +
              'drawdown_amount,drawdown_pct,intraday_drawdown_amount,intraday_drawdown_pct,' +
              'effective_base_lot,effective_max_total_lot,effective_max_floating_loss,' +
              'floating_limit_used_pct,lot_limit_used_pct,bid,ask,spread_points,atr_m1,atr_m5,' +
              'spread_atr_ratio,rsi_m1,adx_m1,recent_move_5m,recent_move_15m,recent_move_60m,' +
              'news_block_active,news_block_reason,rollover_block_active,day_worst_floating,' +
              'day_max_floating_limit_used_pct,day_max_spread_points,day_max_spread_atr_ratio,' +
              'day_min_margin_level,day_worst_intraday_drawdown_pct,sync_duration_ms',
          )
          .eq('account', ACCOUNT_ID)
          .maybeSingle()
          .then(
            (res) => res,
            () => ({ data: null, error: null }),
          ),
      ])

      if (cancelled) return

      const criticalError = tradesRes.error ?? positionsRes.error ?? snapshotRes.error
      if (criticalError) throw criticalError

      const tradeRows = (tradesRes.data as TradeRow[] | null) ?? []
      const checkedAt = new Date().toISOString()
      if (!snapshotRes.data) {
        setData({
          ...FALLBACK,
          loading: false,
          lastCheckedAt: checkedAt,
        })
        return
      }

      const snapshot = snapshotRes.data as AccountSnapshotRow
      const currentBalance = Number(snapshot.balance)
      const startBalance = ACCOUNT_START_BALANCE
      const lastSyncAt = snapshot.updated_at

      let running = startBalance
      const trades: Trade[] = tradeRows.map((r) => {
        running = Number((running + Number(r.pnl)).toFixed(2))
        return {
          id: String(r.id),
          basketId: r.basket_id || String(r.id),
          openTime: r.open_time,
          closeTime: r.close_time,
          direction: r.direction,
          lots: Number(r.lots),
          entryPrice: Number(r.entry_price),
          exitPrice: Number(r.exit_price),
          pnl: Number(r.pnl),
          exitReason: r.exit_reason,
          balanceAfter: running,
          positionId: r.position_id == null ? null : String(r.position_id),
          grossProfit: Number(r.gross_profit ?? r.pnl),
          commission: Number(r.commission ?? 0),
          swap: Number(r.swap ?? 0),
          fee: Number(r.fee ?? 0),
        }
      })

      const openPositions: OpenPosition[] = ((positionsRes.data as OpenPositionRow[] | null) ?? []).map((r) => ({
        id: `mt5-${r.mt5_ticket}`,
        openTime: r.open_time,
        direction: r.direction,
        lots: Number(r.lots),
        entryPrice: Number(r.entry_price),
        currentPrice: Number(r.current_price),
        floatingPnl: Number(r.floating_pnl),
      }))

      const worstRow = worstFloatingRes.data as
        | { floating_pnl: string | number; recorded_at: string; balance: string | number }
        | null
      const worstFloating: WorstFloating | null = worstRow
        ? {
            value: Number(worstRow.floating_pnl),
            pct: floatingSeverityPct(Number(worstRow.floating_pnl), Number(worstRow.balance)),
            at: worstRow.recorded_at,
          }
        : null

      const floatingHistory: FloatingPoint[] = (
        (floatingHistoryRes.data as
          | Array<{ floating_pnl: string | number; recorded_at: string; balance: string | number }>
          | null) ?? []
      ).map((r) => ({ recordedAt: r.recorded_at, floatingPnl: Number(r.floating_pnl), balance: Number(r.balance) }))

      const capitalRows = (capitalRes.data as Array<{ type: 'deposit' | 'withdrawal'; amount: string | number }> | null) ?? []
      const totalNetCapital = capitalRows.length
        ? capitalRows.reduce((sum, r) => sum + (r.type === 'deposit' ? Number(r.amount) : -Number(r.amount)), 0)
        : ACCOUNT_START_BALANCE
      const telemetryRow = telemetryRes.data as TelemetrySummaryRow | null
      const telemetry: TechnicalTelemetry | null = telemetryRow
        ? {
            updatedAt: telemetryRow.updated_at,
            botVersionKey: telemetryRow.bot_version_key,
            marginFree: Number(telemetryRow.margin_free),
            marginLevel: Number(telemetryRow.margin_level),
            positionCount: telemetryRow.position_count,
            totalLots: Number(telemetryRow.total_lots),
            drawdownAmount: Number(telemetryRow.drawdown_amount),
            drawdownPct: Number(telemetryRow.drawdown_pct),
            intradayDrawdownAmount: Number(telemetryRow.intraday_drawdown_amount),
            intradayDrawdownPct: Number(telemetryRow.intraday_drawdown_pct),
            effectiveBaseLot: Number(telemetryRow.effective_base_lot),
            effectiveMaxTotalLot: Number(telemetryRow.effective_max_total_lot),
            effectiveMaxFloatingLoss: Number(telemetryRow.effective_max_floating_loss),
            floatingLimitUsedPct: Number(telemetryRow.floating_limit_used_pct),
            lotLimitUsedPct: Number(telemetryRow.lot_limit_used_pct),
            bid: optionalNumber(telemetryRow.bid),
            ask: optionalNumber(telemetryRow.ask),
            spreadPoints: optionalNumber(telemetryRow.spread_points),
            atrM1: optionalNumber(telemetryRow.atr_m1),
            atrM5: optionalNumber(telemetryRow.atr_m5),
            spreadAtrRatio: optionalNumber(telemetryRow.spread_atr_ratio),
            rsiM1: optionalNumber(telemetryRow.rsi_m1),
            adxM1: optionalNumber(telemetryRow.adx_m1),
            recentMove5m: optionalNumber(telemetryRow.recent_move_5m),
            recentMove15m: optionalNumber(telemetryRow.recent_move_15m),
            recentMove60m: optionalNumber(telemetryRow.recent_move_60m),
            newsBlockActive: telemetryRow.news_block_active,
            newsBlockReason: telemetryRow.news_block_reason,
            rolloverBlockActive: telemetryRow.rollover_block_active,
            dayWorstFloating: Number(telemetryRow.day_worst_floating),
            dayMaxFloatingLimitUsedPct: Number(telemetryRow.day_max_floating_limit_used_pct),
            dayMaxSpreadPoints: optionalNumber(telemetryRow.day_max_spread_points),
            dayMaxSpreadAtrRatio: optionalNumber(telemetryRow.day_max_spread_atr_ratio),
            dayMinMarginLevel: optionalNumber(telemetryRow.day_min_margin_level),
            dayWorstIntradayDrawdownPct: Number(telemetryRow.day_worst_intraday_drawdown_pct),
            syncDurationMs: telemetryRow.sync_duration_ms,
          }
        : null

      setData({
        trades,
        openPositions,
        account: {
          startBalance,
          balance: currentBalance,
          equity: Number(snapshot.equity),
          currency: snapshot.currency,
          symbol: mockAccount.symbol,
        },
        isLive: true,
        loading: false,
        worstFloating,
        floatingHistory,
        totalNetCapital,
        lastSyncAt,
        lastCheckedAt: checkedAt,
        connectionError: null,
        telemetry,
      })
    }

    function loadAndCatch() {
      load().catch((error) => {
        console.error('Failed to load Supabase account data', error)
        if (!cancelled) {
          setData((current) => ({
            ...current,
            loading: false,
            lastCheckedAt: new Date().toISOString(),
            connectionError: error instanceof Error ? error.message : 'No s’ha pogut consultar Supabase',
          }))
        }
      })
    }

    loadAndCatch()
    // The VPS syncs every 60s — poll a bit faster so the open dashboard tab
    // picks up new trades / floating P&L without needing a manual reload.
    const interval = setInterval(loadAndCatch, REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const syncAgeSeconds = data.lastSyncAt
    ? Math.max(0, Math.floor((now - Date.parse(data.lastSyncAt)) / 1000))
    : null

  return {
    ...data,
    syncAgeSeconds,
    isStale: syncAgeSeconds === null || syncAgeSeconds * 1000 > STALE_AFTER_MS,
  }
}

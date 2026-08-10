import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured, fetchAllRows } from './supabaseClient'
import { mockAccount, mockOpenPositions, mockTrades } from './mockData'
import type { AccountSnapshot, Direction, ExitReason, OpenPosition, Trade } from './types'
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
}

type StoredAccountData = Omit<AccountData, 'isStale' | 'syncAgeSeconds'>

// Used only when Supabase isn't configured at all (pure local demo mode) —
// never shown while a real fetch is in flight, otherwise these made-up
// numbers flash on screen looking like real account data before the actual
// response arrives.
const DEMO_FALLBACK: StoredAccountData = {
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
}

// Genuine "nothing loaded yet" state while the real Supabase fetch is in
// flight — no fabricated balances/trades, so a loading screen can key off
// lastSyncAt === null instead of ever rendering placeholder numbers.
const EMPTY: StoredAccountData = {
  trades: [],
  openPositions: [],
  account: { startBalance: 0, balance: 0, equity: 0, currency: 'USD', symbol: mockAccount.symbol },
  isLive: false,
  loading: true,
  worstFloating: null,
  floatingHistory: [],
  totalNetCapital: ACCOUNT_START_BALANCE,
  lastSyncAt: null,
  lastCheckedAt: null,
  connectionError: null,
}

interface TradeRow {
  id: number
  direction: Direction
  lots: string | number
  entry_price: string | number
  exit_price: string | number
  open_time: string
  close_time: string
  pnl: string | number
  exit_reason: ExitReason
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

export function useAccountData(): AccountData {
  const [data, setData] = useState<StoredAccountData>(isSupabaseConfigured ? EMPTY : DEMO_FALLBACK)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  // floating_pnl_snapshots is append-only (one row per sync pass, never
  // overwritten — see supabase/schema.sql) and already has 10k+ rows,
  // growing every ~60s forever. Re-fetching the whole table every 30s poll
  // meant 12+ paginated HTTP round trips, every poll, for data that's
  // almost entirely unchanged from the previous poll — and that only gets
  // worse the longer the bot runs. Kept in a ref (not state) so the poll
  // loop can keep appending to it across ticks without re-running this
  // effect; `accumulated` only becomes a *new* array reference (triggering
  // downstream useMemo recalculation) when new rows actually arrive.
  const floatingHistoryRef = useRef<FloatingPoint[]>([])
  const floatingCursorRef = useRef<string | null>(null)
  const tradesRef = useRef<Trade[]>([])

  useEffect(() => {
    if (!supabase) return
    let cancelled = false

    async function load() {
      const isFirstLoad = floatingCursorRef.current === null

      const [tradesRes, positionsRes, snapshotRes, worstFloatingRes, floatingHistoryRes, capitalRes] = await Promise.all([
        supabase!
          .from('trades')
          .select('id, direction, lots, entry_price, exit_price, open_time, close_time, pnl, exit_reason')
          .eq('account', ACCOUNT_ID)
          .order('close_time', { ascending: true }),
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
        // First load: full history (paged — a single .limit() silently caps
        // at Supabase's max-rows once the table grows past 1000). Every
        // poll after that: only rows newer than what we already have —
        // typically 0-1 rows, since the VPS syncs about once a minute.
        // Still paged via fetchAllRows even for the delta, so an
        // implausibly large gap (tab backgrounded for hours) can't silently
        // truncate at Supabase's max-rows either.
        fetchAllRows<{ floating_pnl: string | number; recorded_at: string; balance: string | number }>((from, to) => {
          let query = supabase!
            .from('floating_pnl_snapshots')
            .select('floating_pnl, recorded_at, balance')
            .eq('account', ACCOUNT_ID)
          if (!isFirstLoad) query = query.gt('recorded_at', floatingCursorRef.current!)
          return query.order('recorded_at', { ascending: true }).range(from, to)
        })
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
      ])

      if (cancelled) return

      const criticalError = tradesRes.error ?? positionsRes.error ?? snapshotRes.error
      if (criticalError) throw criticalError

      const tradeRows = (tradesRes.data as TradeRow[] | null) ?? []
      const checkedAt = new Date().toISOString()
      if (!snapshotRes.data) {
        setData({
          ...EMPTY,
          loading: false,
          lastCheckedAt: checkedAt,
        })
        return
      }

      const snapshot = snapshotRes.data as AccountSnapshotRow
      const currentBalance = Number(snapshot.balance)
      const startBalance = ACCOUNT_START_BALANCE
      const lastSyncAt = snapshot.updated_at

      // Cheap "did anything actually change" check before rebuilding the
      // trades array — reusing the same reference when nothing changed
      // means every useMemo downstream (stats, equity curve, baskets...)
      // skips recomputation too, not just this hook's own re-render.
      const previousTrades = tradesRef.current
      const lastRow = tradeRows[tradeRows.length - 1]
      const previousLast = previousTrades[previousTrades.length - 1]
      const tradesUnchanged =
        tradeRows.length === previousTrades.length &&
        (lastRow === undefined || (previousLast?.id === String(lastRow.id) && previousLast?.pnl === Number(lastRow.pnl)))

      let trades: Trade[]
      if (tradesUnchanged) {
        trades = previousTrades
      } else {
        let running = startBalance
        trades = tradeRows.map((r) => {
          running = Number((running + Number(r.pnl)).toFixed(2))
          return {
            id: String(r.id),
            basketId: String(r.id),
            openTime: r.open_time,
            closeTime: r.close_time,
            direction: r.direction,
            lots: Number(r.lots),
            entryPrice: Number(r.entry_price),
            exitPrice: Number(r.exit_price),
            pnl: Number(r.pnl),
            exitReason: r.exit_reason,
            balanceAfter: running,
          }
        })
        tradesRef.current = trades
      }

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

      const newFloatingRows =
        (floatingHistoryRes.data as
          | Array<{ floating_pnl: string | number; recorded_at: string; balance: string | number }>
          | null) ?? []
      const newFloatingPoints: FloatingPoint[] = newFloatingRows.map((r) => ({
        recordedAt: r.recorded_at,
        floatingPnl: Number(r.floating_pnl),
        balance: Number(r.balance),
      }))

      // Only produce a *new* array (and advance the cursor) when something
      // actually arrived - otherwise reuse the existing reference so every
      // consumer downstream (worstFloatingDuringBasket, equity/date-range
      // filters, ...) can skip recomputing on ticks where nothing changed.
      let floatingHistory: FloatingPoint[]
      if (isFirstLoad) {
        floatingHistory = newFloatingPoints
        floatingHistoryRef.current = floatingHistory
      } else if (newFloatingPoints.length > 0) {
        floatingHistory = floatingHistoryRef.current.concat(newFloatingPoints)
        floatingHistoryRef.current = floatingHistory
      } else {
        floatingHistory = floatingHistoryRef.current
      }
      if (floatingHistory.length > 0) {
        floatingCursorRef.current = floatingHistory[floatingHistory.length - 1].recordedAt
      }

      const capitalRows = (capitalRes.data as Array<{ type: 'deposit' | 'withdrawal'; amount: string | number }> | null) ?? []
      const totalNetCapital = capitalRows.length
        ? capitalRows.reduce((sum, r) => sum + (r.type === 'deposit' ? Number(r.amount) : -Number(r.amount)), 0)
        : ACCOUNT_START_BALANCE

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

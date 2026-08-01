import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (!supabase) return
    let cancelled = false

    async function load() {
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

      let running = startBalance
      const trades: Trade[] = tradeRows.map((r) => {
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

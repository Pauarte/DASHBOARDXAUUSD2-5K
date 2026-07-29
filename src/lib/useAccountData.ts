import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient'
import { mockAccount, mockOpenPositions, mockTrades } from './mockData'
import type { AccountSnapshot, Direction, ExitReason, OpenPosition, Trade } from './types'
import type { FloatingPoint } from './stats'

const ACCOUNT_ID = import.meta.env.VITE_MT5_ACCOUNT || mockAccount.symbol
const REFRESH_INTERVAL_MS = 30_000

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
  lastSyncAt: string | null
  isStale: boolean
}

const FALLBACK: AccountData = {
  trades: mockTrades,
  openPositions: mockOpenPositions,
  account: mockAccount,
  isLive: false,
  loading: false,
  worstFloating: null,
  floatingHistory: [],
  lastSyncAt: null,
  isStale: true,
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
  const [data, setData] = useState<AccountData>({
    ...FALLBACK,
    loading: isSupabaseConfigured,
  })

  useEffect(() => {
    if (!supabase) return
    let cancelled = false

    async function load() {
      const [tradesRes, positionsRes, snapshotRes, worstFloatingRes, floatingHistoryRes] = await Promise.all([
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
          .select('floating_pnl, recorded_at')
          .eq('account', ACCOUNT_ID)
          .order('floating_pnl', { ascending: true })
          .limit(1)
          .maybeSingle()
          .then(
            (res) => res,
            () => ({ data: null, error: null }),
          ),
        // Full history (not just the worst point), used to find the worst
        // floating reached during each individual closed operation.
        supabase!
          .from('floating_pnl_snapshots')
          .select('floating_pnl, recorded_at')
          .eq('account', ACCOUNT_ID)
          .order('recorded_at', { ascending: true })
          .limit(5000)
          .then(
            (res) => res,
            () => ({ data: null, error: null }),
          ),
      ])

      if (cancelled) return

      const tradeRows = (tradesRes.data as TradeRow[] | null) ?? []
      if (tradeRows.length === 0 || !snapshotRes.data) {
        // the sync script hasn't written any data for this account yet
        setData({ ...FALLBACK, loading: false })
        return
      }

      const snapshot = snapshotRes.data as AccountSnapshotRow
      const currentBalance = Number(snapshot.balance)
      const startBalance = ACCOUNT_START_BALANCE
      const lastSyncAt = snapshot.updated_at
      const isStale = Date.now() - Date.parse(lastSyncAt) > 3 * 60_000

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

      const worstRow = worstFloatingRes.data as { floating_pnl: string | number; recorded_at: string } | null
      const worstFloating: WorstFloating | null = worstRow
        ? { value: Number(worstRow.floating_pnl), at: worstRow.recorded_at }
        : null

      const floatingHistory: FloatingPoint[] = (
        (floatingHistoryRes.data as Array<{ floating_pnl: string | number; recorded_at: string }> | null) ?? []
      ).map((r) => ({ recordedAt: r.recorded_at, floatingPnl: Number(r.floating_pnl) }))

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
        lastSyncAt,
        isStale,
      })
    }

    function loadAndCatch() {
      load().catch((error) => {
        console.error('Failed to load Supabase account data, falling back to demo data', error)
        if (!cancelled) setData({ ...FALLBACK, loading: false })
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

  return data
}

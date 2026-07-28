import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient'
import { mockAccount, mockOpenPositions, mockTrades } from './mockData'
import type { AccountSnapshot, Direction, ExitReason, OpenPosition, Trade } from './types'

const ACCOUNT_ID = import.meta.env.VITE_MT5_ACCOUNT || mockAccount.symbol

interface AccountData {
  trades: Trade[]
  openPositions: OpenPosition[]
  account: AccountSnapshot
  isLive: boolean
  loading: boolean
}

const FALLBACK: AccountData = {
  trades: mockTrades,
  openPositions: mockOpenPositions,
  account: mockAccount,
  isLive: false,
  loading: false,
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
      const [tradesRes, positionsRes, snapshotRes] = await Promise.all([
        supabase!
          .from('trades')
          .select('id, direction, lots, entry_price, exit_price, open_time, close_time, pnl, exit_reason')
          .eq('account', ACCOUNT_ID)
          .order('close_time', { ascending: true }),
        supabase!
          .from('open_positions')
          .select('mt5_ticket, direction, lots, entry_price, current_price, open_time, floating_pnl')
          .eq('account', ACCOUNT_ID),
        supabase!.from('account_snapshots').select('balance, equity, currency').eq('account', ACCOUNT_ID).maybeSingle(),
      ])

      if (cancelled) return

      const tradeRows = (tradesRes.data as TradeRow[] | null) ?? []
      if (tradeRows.length === 0 || !snapshotRes.data) {
        // the sync script hasn't written any data for this account yet
        setData({ ...FALLBACK, loading: false })
        return
      }

      const snapshot = snapshotRes.data as AccountSnapshotRow
      const totalPnl = tradeRows.reduce((sum, r) => sum + Number(r.pnl), 0)
      const currentBalance = Number(snapshot.balance)
      const startBalance = Number((currentBalance - totalPnl).toFixed(2))

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

      const floatingTotal = openPositions.reduce((s, p) => s + p.floatingPnl, 0)

      setData({
        trades,
        openPositions,
        account: {
          startBalance,
          balance: currentBalance,
          equity: Number((currentBalance + floatingTotal).toFixed(2)),
          currency: snapshot.currency,
          symbol: mockAccount.symbol,
        },
        isLive: true,
        loading: false,
      })
    }

    load().catch((error) => {
      console.error('Failed to load Supabase account data, falling back to demo data', error)
      if (!cancelled) setData({ ...FALLBACK, loading: false })
    })

    return () => {
      cancelled = true
    }
  }, [])

  return data
}

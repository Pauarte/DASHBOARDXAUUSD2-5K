import { createClient } from '@supabase/supabase-js'

const STALE_AFTER_SECONDS = 180
const BASKET_CLOSE_GAP_SECONDS = 3
const MADRID_TIMEZONE = 'Europe/Madrid'

function madridDateKey(value) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: MADRID_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function groupIntoOperations(rows) {
  const sorted = [...rows].sort((a, b) => String(a.close_time).localeCompare(String(b.close_time)))
  const groups = []

  for (const trade of sorted) {
    const current = groups[groups.length - 1]
    const previous = current?.[current.length - 1]
    const gap = previous
      ? (Date.parse(trade.close_time) - Date.parse(previous.close_time)) / 1000
      : Number.POSITIVE_INFINITY

    if (current && gap <= BASKET_CLOSE_GAP_SECONDS) current.push(trade)
    else groups.push([trade])
  }

  return groups.map((legs) => ({
    close_time: legs[legs.length - 1].close_time,
    pnl: Number(legs.reduce((sum, leg) => sum + Number(leg.pnl), 0).toFixed(2)),
    legs: legs.length,
  }))
}

export default async function handler(_request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Access-Control-Allow-Origin', '*')

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY
  const accountId = process.env.VITE_MT5_ACCOUNT

  if (!supabaseUrl || !supabaseAnonKey || !accountId) {
    return response.status(503).json({
      ok: false,
      error: 'analysis_context_not_configured',
      generated_at: new Date().toISOString(),
    })
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey)
    const historyFrom = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const [snapshotResult, positionsResult, tradesResult, floatingResult, capitalResult] = await Promise.all([
      supabase
        .from('account_snapshots')
        .select('balance, equity, currency, updated_at')
        .eq('account', accountId)
        .maybeSingle(),
      supabase
        .from('open_positions')
        .select('direction, lots, entry_price, current_price, open_time, floating_pnl')
        .eq('account', accountId),
      supabase
        .from('trades')
        .select('direction, lots, open_time, close_time, pnl, exit_reason')
        .eq('account', accountId)
        .gte('close_time', historyFrom)
        .order('close_time', { ascending: true }),
      supabase
        .from('floating_pnl_snapshots')
        .select('floating_pnl, recorded_at')
        .eq('account', accountId)
        .gte('recorded_at', historyFrom)
        .order('recorded_at', { ascending: true }),
      supabase.from('capital_contributions').select('type, amount'),
    ])

    const criticalError = snapshotResult.error ?? positionsResult.error ?? tradesResult.error
    if (criticalError) throw criticalError
    if (!snapshotResult.data) throw new Error('No account snapshot available')

    const now = new Date()
    const today = madridDateKey(now)
    const recentTrades = tradesResult.data ?? []
    const todayTrades = recentTrades.filter((trade) => madridDateKey(trade.close_time) === today)
    const operations = groupIntoOperations(todayTrades)
    const wins = operations.filter((operation) => operation.pnl > 0).length
    const losses = operations.filter((operation) => operation.pnl < 0).length
    const dailyPnl = Number(operations.reduce((sum, operation) => sum + operation.pnl, 0).toFixed(2))
    const snapshot = snapshotResult.data
    const balance = Number(snapshot.balance)
    const dayStartBalance = balance - dailyPnl
    const updatedAt = snapshot.updated_at
    const syncAgeSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(updatedAt)) / 1000))
    const positions = positionsResult.data ?? []
    const floatingPnl = Number(
      positions.reduce((sum, position) => sum + Number(position.floating_pnl), 0).toFixed(2),
    )
    const todayFloating = (floatingResult.data ?? [])
      .filter((point) => madridDateKey(point.recorded_at) === today)
      .map((point) => Number(point.floating_pnl))
    const capitalRows = capitalResult.data ?? []
    const netCapital = capitalRows.reduce(
      (sum, row) => sum + (row.type === 'deposit' ? Number(row.amount) : -Number(row.amount)),
      0,
    )

    return response.status(200).json({
      ok: true,
      generated_at: now.toISOString(),
      timezone: MADRID_TIMEZONE,
      date: today,
      bot: 'R2-A',
      data_freshness: {
        last_sync_at: updatedAt,
        age_seconds: syncAgeSeconds,
        is_stale: syncAgeSeconds > STALE_AFTER_SECONDS,
      },
      account: {
        balance,
        equity: Number(snapshot.equity),
        currency: snapshot.currency,
        net_capital: Number(netCapital.toFixed(2)),
        total_real_pnl: Number((balance - netCapital).toFixed(2)),
      },
      today: {
        pnl: dailyPnl,
        return_pct: dayStartBalance > 0 ? Number(((dailyPnl / dayStartBalance) * 100).toFixed(4)) : null,
        closed_operations: operations.length,
        wins,
        losses,
        break_evens: operations.length - wins - losses,
        win_rate_pct: operations.length > 0 ? Number(((wins / operations.length) * 100).toFixed(2)) : null,
        worst_floating: todayFloating.length > 0 ? Math.min(...todayFloating) : null,
      },
      live: {
        open_positions: positions.length,
        floating_pnl: floatingPnl,
      },
      recent_operations: operations.slice(-10),
      unavailable_metrics: ['spread'],
    })
  } catch (error) {
    return response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'analysis_context_failed',
      generated_at: new Date().toISOString(),
    })
  }
}

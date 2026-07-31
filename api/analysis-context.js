import { createClient } from '@supabase/supabase-js'

const STALE_AFTER_SECONDS = 180
const BASKET_CLOSE_GAP_SECONDS = 3
const MADRID_TIMEZONE = 'Europe/Madrid'
const DEFAULT_NET_CAPITAL = Number(process.env.ACCOUNT_START_BALANCE ?? 2496.6)

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

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
  const explicitGroups = []
  const fallbackGroups = []
  const explicitById = new Map()

  for (const trade of sorted) {
    if (trade.basket_id) {
      const existing = explicitById.get(trade.basket_id)
      if (existing) existing.push(trade)
      else {
        const group = [trade]
        explicitById.set(trade.basket_id, group)
        explicitGroups.push(group)
      }
      continue
    }
    const current = fallbackGroups[fallbackGroups.length - 1]
    const previous = current?.[current.length - 1]
    const gap = previous
      ? (Date.parse(trade.close_time) - Date.parse(previous.close_time)) / 1000
      : Number.POSITIVE_INFINITY

    if (current && gap <= BASKET_CLOSE_GAP_SECONDS) current.push(trade)
    else fallbackGroups.push([trade])
  }

  const groups = [...explicitGroups, ...fallbackGroups].sort((a, b) =>
    String(a[a.length - 1].close_time).localeCompare(String(b[b.length - 1].close_time)),
  )

  return groups.map((legs) => ({
    basket_id: legs[0].basket_id ?? null,
    open_time: legs.reduce(
      (earliest, leg) => (String(leg.open_time) < earliest ? String(leg.open_time) : earliest),
      String(legs[0].open_time),
    ),
    close_time: legs[legs.length - 1].close_time,
    pnl: Number(legs.reduce((sum, leg) => sum + Number(leg.pnl), 0).toFixed(2)),
    gross_profit: Number(
      legs.reduce((sum, leg) => sum + Number(leg.gross_profit ?? leg.pnl), 0).toFixed(2),
    ),
    commission: Number(
      legs.reduce((sum, leg) => sum + Number(leg.commission ?? 0), 0).toFixed(2),
    ),
    swap: Number(legs.reduce((sum, leg) => sum + Number(leg.swap ?? 0), 0).toFixed(2)),
    fee: Number(legs.reduce((sum, leg) => sum + Number(leg.fee ?? 0), 0).toFixed(2)),
    lots: Number(legs.reduce((sum, leg) => sum + Number(leg.lots), 0).toFixed(2)),
    legs: legs.length,
  }))
}

async function fetchTrades(supabase, accountId, historyFrom) {
  const extended = await supabase
    .from('trades')
    .select(
      'basket_id,direction,lots,open_time,close_time,pnl,gross_profit,' +
        'commission,swap,fee,exit_reason',
    )
    .eq('account', accountId)
    .gte('close_time', historyFrom)
    .order('close_time', { ascending: true })

  if (!extended.error) return extended

  return supabase
    .from('trades')
    .select('direction,lots,open_time,close_time,pnl,exit_reason')
    .eq('account', accountId)
    .gte('close_time', historyFrom)
    .order('close_time', { ascending: true })
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

    const [snapshotResult, positionsResult, tradesResult, floatingResult, capitalResult, telemetryResult] = await Promise.all([
      supabase
        .from('account_snapshots')
        .select('balance, equity, currency, updated_at')
        .eq('account', accountId)
        .maybeSingle(),
      supabase
        .from('open_positions')
        .select('direction, lots, entry_price, current_price, open_time, floating_pnl')
        .eq('account', accountId),
      fetchTrades(supabase, accountId, historyFrom),
      supabase
        .from('floating_pnl_snapshots')
        .select('floating_pnl, recorded_at')
        .eq('account', accountId)
        .gte('recorded_at', historyFrom)
        .order('recorded_at', { ascending: true }),
      supabase.from('capital_contributions').select('type, amount'),
      supabase
        .from('telemetry_summary')
        .select(
          'updated_at,bot_version_key,balance,equity,floating_pnl,margin_free,margin_level,' +
          'position_count,total_lots,drawdown_amount,drawdown_pct,intraday_drawdown_amount,' +
          'intraday_drawdown_pct,effective_base_lot,effective_max_total_lot,' +
          'effective_max_floating_loss,floating_limit_used_pct,lot_limit_used_pct,bid,ask,' +
          'spread_points,atr_m1,atr_m5,spread_atr_ratio,rsi_m1,adx_m1,recent_move_5m,' +
          'recent_move_15m,recent_move_60m,news_block_active,news_block_reason,' +
          'rollover_block_active,day_worst_floating,day_max_floating_limit_used_pct,' +
          'day_max_spread_points,day_max_spread_atr_ratio,day_min_margin_level,' +
          'day_worst_intraday_drawdown_pct,sync_duration_ms',
        )
        .eq('account', accountId)
        .maybeSingle()
        .then(
          (result) => result,
          () => ({ data: null, error: null }),
        ),
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
    const netCapital = capitalRows.length
      ? capitalRows.reduce(
          (sum, row) => sum + (row.type === 'deposit' ? Number(row.amount) : -Number(row.amount)),
          0,
        )
      : DEFAULT_NET_CAPITAL
    const telemetry = telemetryResult.data

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
        total_lots: telemetry ? Number(telemetry.total_lots) : null,
        margin_free: telemetry ? Number(telemetry.margin_free) : null,
        margin_level: telemetry ? Number(telemetry.margin_level) : null,
        effective_base_lot: telemetry ? Number(telemetry.effective_base_lot) : null,
        effective_max_total_lot: telemetry ? Number(telemetry.effective_max_total_lot) : null,
        effective_max_floating_loss: telemetry ? Number(telemetry.effective_max_floating_loss) : null,
        floating_limit_used_pct: telemetry ? Number(telemetry.floating_limit_used_pct) : null,
        lot_limit_used_pct: telemetry ? Number(telemetry.lot_limit_used_pct) : null,
      },
      risk: telemetry
        ? {
            global_drawdown: Number(telemetry.drawdown_amount),
            global_drawdown_pct: Number(telemetry.drawdown_pct),
            intraday_drawdown: Number(telemetry.intraday_drawdown_amount),
            intraday_drawdown_pct: Number(telemetry.intraday_drawdown_pct),
            day_worst_floating: Number(telemetry.day_worst_floating),
            day_max_floating_limit_used_pct: Number(telemetry.day_max_floating_limit_used_pct),
            day_worst_intraday_drawdown_pct: Number(telemetry.day_worst_intraday_drawdown_pct),
          }
        : null,
      market: telemetry
        ? {
            bid: numericOrNull(telemetry.bid),
            ask: numericOrNull(telemetry.ask),
            spread_points: numericOrNull(telemetry.spread_points),
            atr_m1: numericOrNull(telemetry.atr_m1),
            atr_m5: numericOrNull(telemetry.atr_m5),
            spread_atr_ratio: numericOrNull(telemetry.spread_atr_ratio),
            rsi_m1: numericOrNull(telemetry.rsi_m1),
            adx_m1: numericOrNull(telemetry.adx_m1),
            recent_move_5m: numericOrNull(telemetry.recent_move_5m),
            recent_move_15m: numericOrNull(telemetry.recent_move_15m),
            recent_move_60m: numericOrNull(telemetry.recent_move_60m),
            day_max_spread_points: numericOrNull(telemetry.day_max_spread_points),
            day_max_spread_atr_ratio: numericOrNull(telemetry.day_max_spread_atr_ratio),
          }
        : null,
      guards: telemetry
        ? {
            news_block_active: Boolean(telemetry.news_block_active),
            news_block_reason: telemetry.news_block_reason,
            rollover_block_active: Boolean(telemetry.rollover_block_active),
          }
        : null,
      telemetry: telemetry
        ? {
            version_key: telemetry.bot_version_key,
            sync_duration_ms: Number(telemetry.sync_duration_ms),
          }
        : null,
      recent_operations: operations.slice(-10),
      unavailable_metrics: telemetry ? [] : ['spread', 'market_context', 'risk_limits'],
    })
  } catch (error) {
    return response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'analysis_context_failed',
      generated_at: new Date().toISOString(),
    })
  }
}

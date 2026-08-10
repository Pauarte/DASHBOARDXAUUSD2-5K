import { getReaderPool, verifyAnalysisToken, extractBearerToken } from './_lib/db.js'
import { groupIntoBaskets, worstFloatingDuringBasket } from './_lib/baskets.js'
import {
  madridDateKey,
  madridMidnightUtc,
  isValidDateKey,
  addDays,
  MADRID_TIMEZONE,
} from './_lib/date.js'
import {
  madridWeekKey,
  madridMonthKey,
  summarizePeriod,
  returnPctOf,
  streaks,
  positiveNegativeDays,
} from './_lib/performance.js'

const SCHEMA_VERSION = 1
const ROLLUP_WINDOW_DAYS = 32 // enough lookback for a full month + rolling-30 window
const MAX_PAGE_SIZE = 500
const STALE_AFTER_SECONDS = 180

// Postgres `numeric` columns come back from node-postgres as strings (to
// avoid silent float-precision loss on the driver's side) - fine for the
// arithmetic this file does (JS coerces numeric strings in operators), but
// every value that reaches the JSON response must be an actual number, or
// callers parsing this schema would see `"2496.60"` instead of `2496.6`.
function numOrNull(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function sendJson(response, status, body) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  return response.status(status).json(body)
}

function errorBody(status, error, requestId) {
  return { ok: false, error, request_id: requestId, generated_at: new Date().toISOString() }
}

export default async function handler(request, response) {
  const requestId = Math.random().toString(36).slice(2, 10)

  // --- method gate: this is a read-only endpoint, full stop -----------------
  response.setHeader('Allow', 'GET, HEAD, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(response, 405, errorBody(405, 'method_not_allowed_read_only_endpoint', requestId))
  }

  const pool = getReaderPool()
  if (!pool) {
    return sendJson(response, 503, errorBody(503, 'analysis_reader_not_configured', requestId))
  }

  // --- auth -------------------------------------------------------------
  const token = extractBearerToken(request)
  let auth
  try {
    auth = await verifyAnalysisToken(pool, token, '/api/analysis/v1/report-data')
  } catch {
    return sendJson(response, 503, errorBody(503, 'auth_check_failed', requestId))
  }
  if (!auth.ok) {
    return sendJson(response, auth.status, errorBody(auth.status, `unauthorized_${auth.reason}`, requestId))
  }

  // --- query params -------------------------------------------------------
  const query = request.query ?? {}
  const requestedDate = Array.isArray(query.date) ? query.date[0] : query.date
  const requestedTimezone = Array.isArray(query.timezone) ? query.timezone[0] : query.timezone
  const warnings = []

  if (requestedDate !== undefined && !isValidDateKey(requestedDate)) {
    return sendJson(response, 400, errorBody(400, 'invalid_date_use_yyyy_mm_dd', requestId))
  }
  if (requestedTimezone && requestedTimezone !== MADRID_TIMEZONE) {
    warnings.push(`timezone=${requestedTimezone} is not supported yet; all dates below use ${MADRID_TIMEZONE}.`)
  }

  const pageRaw = Number(Array.isArray(query.page) ? query.page[0] : query.page)
  const pageSizeRaw = Number(Array.isArray(query.page_size) ? query.page_size[0] : query.page_size)
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
  const pageSize =
    Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, MAX_PAGE_SIZE) : 100

  const now = new Date()
  const today = madridDateKey(now)
  const resolvedDate = requestedDate ?? today
  const isLiveDay = resolvedDate === today

  const dayStart = madridMidnightUtc(resolvedDate).toISOString()
  const dayEnd = madridMidnightUtc(addDays(resolvedDate, 1)).toISOString()
  const rollupStart = madridMidnightUtc(addDays(resolvedDate, -ROLLUP_WINDOW_DAYS)).toISOString()

  try {
    const [botRow, accountRow, positionsRes, allTradesUpToDayEndRes, floatingRes, snapshotRes, capitalRow, incidentsRes] =
      await Promise.all([
        pool.query('select * from analysis_v1_bot limit 1'),
        pool.query('select * from analysis_v1_account order by updated_at desc limit 1'),
        isLiveDay ? pool.query('select * from analysis_v1_open_positions order by open_time asc') : Promise.resolve({ rows: [] }),
        // No lower bound: an accurate running balance (used to classify a
        // basket as a real loss vs a break-even swap fee, same as the
        // public dashboard) needs the *entire* history up to this cutoff,
        // not a pre-windowed slice - see groupIntoBaskets() in _lib/baskets.js.
        pool.query('select * from analysis_v1_closed_trades where close_time < $1 order by close_time asc', [dayEnd]),
        pool.query(
          'select * from analysis_v1_floating_history where recorded_at >= $1 and recorded_at < $2 order by recorded_at asc',
          [rollupStart, dayEnd],
        ),
        pool.query('select * from analysis_v1_daily_snapshots where snapshot_date = $1', [resolvedDate]),
        pool.query('select * from analysis_v1_capital_summary'),
        pool.query('select * from analysis_v1_incidents order by occurred_at desc limit 50'),
      ])

    const bot = botRow.rows[0] ?? null
    const account = accountRow.rows[0] ?? null
    const dailySnapshot = snapshotRes.rows[0] ?? null
    const capital = capitalRow.rows[0] ?? null

    const syncAgeSeconds = account ? Math.max(0, Math.floor((now.getTime() - Date.parse(account.updated_at)) / 1000)) : null
    const isStale = syncAgeSeconds === null ? true : syncAgeSeconds > STALE_AFTER_SECONDS

    // --- baskets --------------------------------------------------------
    // One canonical basket list, built from the full history up to dayEnd
    // (accurate running balance -> correct break-even classification),
    // then sliced by date in-memory for the day/week/month/rolling views -
    // never re-grouped from a pre-windowed query, which would both get the
    // balance wrong and risk splitting a basket that straddles a window edge.
    const allBaskets = groupIntoBaskets(allTradesUpToDayEndRes.rows)
    const rollupStartKey = addDays(resolvedDate, -ROLLUP_WINDOW_DAYS)
    const dayBaskets = allBaskets.filter((b) => madridDateKey(b.closeTime) === resolvedDate)
    const rollupBaskets = allBaskets.filter((b) => madridDateKey(b.closeTime) >= rollupStartKey && madridDateKey(b.closeTime) <= resolvedDate)
    const dayStartMs = Date.parse(dayStart)
    const dayEndMs = Date.parse(dayEnd)
    const dayTrades = allTradesUpToDayEndRes.rows.filter((t) => {
      const ms = Date.parse(t.close_time)
      return ms >= dayStartMs && ms < dayEndMs
    })
    const floatingHistory = floatingRes.rows

    const basketsWithMae = dayBaskets.map((b) => {
      const { worstFloating, bestFloating } = worstFloatingDuringBasket(floatingHistory, b)
      return {
        basket_id: b.basketId,
        state: 'closed',
        direction: b.direction,
        open_time: b.openTime,
        close_time: b.closeTime,
        duration_minutes: b.durationMinutes,
        leg_count: b.legCount,
        lots_total: b.lotsTotal,
        lots_max: b.lotsMax,
        avg_entry_price: b.avgEntryPrice,
        realized_pnl: b.pnl,
        floating_pnl: 0, // closed baskets have no floating left
        worst_floating_during_basket: worstFloating,
        best_floating_during_basket: bestFloating,
        mae_mfe_note: 'derived from account-wide floating_pnl_snapshots (coarse, ~1/min); not a true per-leg tick MAE/MFE',
        close_reason: b.closeReason,
        legs: b.legs.map((leg) => ({
          trade_id: leg.trade_id,
          mt5_deal_id: leg.mt5_deal_id,
          direction: leg.direction,
          lots: Number(leg.lots),
          entry_price: Number(leg.entry_price),
          exit_price: Number(leg.exit_price),
          open_time: leg.open_time,
          close_time: leg.close_time,
          pnl: Number(leg.pnl),
          exit_reason: leg.exit_reason,
        })),
      }
    })

    // --- performance rollups ---------------------------------------------
    const inRange = (basket, startKey, endKeyExclusive) => {
      const key = madridDateKey(basket.closeTime)
      return key >= startKey && key < endKeyExclusive
    }
    const weekKey = madridWeekKey(`${resolvedDate}T12:00:00Z`)
    const monthKey = madridMonthKey(`${resolvedDate}T12:00:00Z`)
    const weekBaskets = rollupBaskets.filter((b) => madridWeekKey(b.closeTime) === weekKey)
    const monthBaskets = rollupBaskets.filter((b) => madridMonthKey(b.closeTime) === monthKey)
    const rolling7 = rollupBaskets.filter((b) => inRange(b, addDays(resolvedDate, -6), addDays(resolvedDate, 1)))
    const rolling30 = rollupBaskets.filter((b) => inRange(b, addDays(resolvedDate, -29), addDays(resolvedDate, 1)))

    const dayStartBalance =
      numOrNull(dailySnapshot?.balance_open) ??
      (account && isLiveDay ? Number(account.balance) - dayBaskets.reduce((s, b) => s + b.pnl, 0) : null)

    const performance = {
      day: { date: resolvedDate, ...summarizePeriod(dayBaskets), return_pct: returnPctOf(summarizePeriod(dayBaskets).net_profit, dayStartBalance) },
      week: { week: weekKey, ...summarizePeriod(weekBaskets) },
      month: { month: monthKey, ...summarizePeriod(monthBaskets) },
      rolling_7d: summarizePeriod(rolling7),
      rolling_30d: summarizePeriod(rolling30),
      ...streaks(rollupBaskets),
      ...positiveNegativeDays(rollupBaskets),
      commissions: null,
      swaps: null,
      commissions_swaps_note: 'the sync pipeline stores pnl as profit+commission+swap already combined; they are not recorded separately (see docs/SYNC_SCRIPT_SPEC.md)',
    }

    // --- risk ---------------------------------------------------------
    const floatingValuesInDay = floatingHistory
      .filter((p) => {
        const ms = Date.parse(p.recorded_at)
        return ms >= dayStartMs && ms < dayEndMs
      })
      .map((p) => Number(p.floating_pnl))
    const floatingMaxIntraday = floatingValuesInDay.length ? Math.min(...floatingValuesInDay) : null
    const currentFloating = isLiveDay && positionsRes.rows.length ? Number((account ? Number(account.equity) - Number(account.balance) : 0).toFixed(2)) : isLiveDay ? 0 : null

    const risk = {
      floating_current: currentFloating,
      floating_max_intraday: floatingMaxIntraday,
      floating_max_all_time: null,
      floating_max_all_time_note: 'requires scanning the full floating_pnl_snapshots history; not computed per-request for cost reasons - available via analysis_daily_snapshots once backfilled',
      drawdown_current_pct: null,
      drawdown_daily_pct: numOrNull(dailySnapshot?.drawdown_max_pct_intraday),
      drawdown_max_pct: null,
      drawdown_max_pct_note: 'all-time max drawdown requires the full daily-snapshot history; only available once analysis_daily_snapshots has enough days accumulated',
      high_water_mark: null,
      exposure_by_direction: isLiveDay
        ? positionsRes.rows.reduce(
            (acc, p) => {
              acc[p.direction] = Number((acc[p.direction] + Number(p.lots)).toFixed(2))
              return acc
            },
            { BUY: 0, SELL: 0 },
          )
        : null,
      lots_max_simultaneous: isLiveDay ? Number(positionsRes.rows.reduce((s, p) => s + Number(p.lots), 0).toFixed(2)) : null,
      mae_mfe_available: false,
      mae_mfe_note: 'per-trade MAE/MFE is not stored; basket-level approximation is in baskets[].worst_floating_during_basket',
    }

    // --- assemble response ---------------------------------------------
    const missingFields = [
      'bot.active_config.*',
      'bot.risk_limits_active',
      'bot.broker',
      'account.credit',
      'account.margin_used',
      'account.margin_free',
      'account.margin_level_pct',
      'account.leverage',
      'performance.commissions',
      'performance.swaps',
      'risk.drawdown_current_pct',
      'risk.drawdown_max_pct',
      'risk.floating_max_all_time',
      'market.*',
    ]
    if (!isLiveDay) missingFields.push('open_positions (historical dates have no open positions)')
    if (!dailySnapshot) missingFields.push('historical.snapshot (no daily snapshot stored for this date yet)')

    const body = {
      meta: {
        schema_version: SCHEMA_VERSION,
        generated_at: now.toISOString(),
        data_as_of: account?.updated_at ?? null,
        timezone: MADRID_TIMEZONE,
        requested_date: requestedDate ?? null,
        resolved_date: resolvedDate,
        is_live_day: isLiveDay,
        server_time: now.toISOString(),
        data_age_seconds: syncAgeSeconds,
        sync_status: account === null ? 'unknown' : isStale ? 'stale' : 'ok',
        missing_fields: missingFields,
        warnings,
        truncated: dayTrades.length > page * pageSize,
        request_id: requestId,
      },
      bot: bot
        ? {
            id: bot.bot_id,
            name: bot.bot_name,
            magic_number: 20260723122,
            magic_number_note: 'documented constant from the sync configuration, not a live query',
            symbol: bot.symbol,
            environment: 'live',
            broker: null,
            strategy_version: null,
            active_config: {
              grid_step: null,
              max_lots: null,
              floating_stop: null,
              spread_atr_filter: null,
              note:
                'these are backtest/context reference values the requester supplied (grid 2.25, max 0.07 lots, floating stop 350, spread/ATR filter 0.12) - the live bot config is not synced to Supabase yet, so per the requester\'s own instruction this must stay null rather than echo those numbers as if verified live.',
            },
            risk_limits_active: null,
            status: isStale ? 'stale' : 'running',
            last_heartbeat_at: account?.updated_at ?? null,
            account_masked: bot.account_masked,
          }
        : null,
      account:
        isLiveDay && account
          ? {
              currency: account.currency,
              balance: Number(account.balance),
              equity: Number(account.equity),
              floating_pnl: Number((Number(account.equity) - Number(account.balance)).toFixed(2)),
              credit: null,
              margin_used: null,
              margin_free: null,
              margin_level_pct: null,
              leverage: null,
              exposure_total_lots: risk.lots_max_simultaneous,
              net_capital: capital ? Number(capital.net_capital) : null,
              updated_at: account.updated_at,
            }
          : {
              note: 'account balance/equity for a past date comes only from analysis_daily_snapshots; live account_snapshots reflects the current state, not historical state',
              balance_close: numOrNull(dailySnapshot?.balance_close),
              equity_close: numOrNull(dailySnapshot?.equity_close),
            },
      performance,
      risk,
      open_positions: isLiveDay
        ? positionsRes.rows.map((p) => ({
            position_id: p.position_id,
            symbol: bot?.symbol ?? 'XAUUSD',
            direction: p.direction,
            basket_id: null,
            basket_id_note: 'open positions cannot be grouped into a basket until they close (grouping is by close_time proximity)',
            magic_number: 20260723122,
            comment: null,
            lots: Number(p.lots),
            open_time: p.open_time,
            entry_price: Number(p.entry_price),
            current_price: Number(p.current_price),
            sl: null,
            tp: null,
            sl_tp_note: 'this bot does not use fixed per-position SL/TP orders (basket-level floating target instead)',
            profit_gross: Number(p.floating_pnl),
            profit_net: Number(p.floating_pnl),
            floating: Number(p.floating_pnl),
            commission: null,
            swap: null,
            spread_entry: null,
            spread_current: null,
            duration_minutes: Number(((now.getTime() - Date.parse(p.open_time)) / 60000).toFixed(1)),
            grid_level: null,
          }))
        : [],
      closed_trades: {
        total_count: dayTrades.length,
        page,
        page_size: pageSize,
        truncated: dayTrades.length > page * pageSize,
        items: dayTrades.slice((page - 1) * pageSize, page * pageSize).map((t) => ({
          trade_id: t.trade_id,
          mt5_deal_id: t.mt5_deal_id,
          order_id: null,
          basket_id: null,
          direction: t.direction,
          lots: Number(t.lots),
          entry_price: Number(t.entry_price),
          exit_price: Number(t.exit_price),
          open_time: t.open_time,
          close_time: t.close_time,
          profit_gross: Number(t.pnl),
          profit_net: Number(t.pnl),
          commission: null,
          swap: null,
          duration_minutes: Number(((Date.parse(t.close_time) - Date.parse(t.open_time)) / 60000).toFixed(1)),
          spread: null,
          slippage: null,
          exit_reason: t.exit_reason,
          strategy_version: null,
        })),
      },
      baskets: {
        total_count: basketsWithMae.length,
        items: basketsWithMae,
      },
      market: {
        bid: null,
        ask: null,
        price: null,
        spread_current: null,
        spread_avg: null,
        spread_min: null,
        spread_max: null,
        spread_unit: null,
        atr: null,
        atr_timeframe: null,
        volatility_current: null,
        volatility_historical: null,
        session: null,
        market_open: null,
        swap_long: null,
        swap_short: null,
        next_rollover: null,
        triple_swap_day: null,
        commissions_schedule: null,
        news_events: 'unavailable',
        source: null,
        note: 'no market/quote feed is synced to Supabase yet - only trade fills and account snapshots are. Every field above is genuinely unavailable, not estimated.',
      },
      incidents: {
        items: incidentsRes.rows,
        note: incidentsRes.rows.length === 0 ? 'no incident log has been written yet - analysis_incidents exists but nothing populates it until the sync script or snapshot job is updated to write to it' : undefined,
      },
      historical: {
        requested_date: resolvedDate,
        snapshot: dailySnapshot
          ? {
              account_masked: dailySnapshot.account_masked,
              snapshot_date: dailySnapshot.snapshot_date,
              balance_open: numOrNull(dailySnapshot.balance_open),
              balance_close: numOrNull(dailySnapshot.balance_close),
              equity_open: numOrNull(dailySnapshot.equity_open),
              equity_close: numOrNull(dailySnapshot.equity_close),
              equity_min_intraday: numOrNull(dailySnapshot.equity_min_intraday),
              equity_max_intraday: numOrNull(dailySnapshot.equity_max_intraday),
              floating_max_intraday: numOrNull(dailySnapshot.floating_max_intraday),
              floating_min_intraday: numOrNull(dailySnapshot.floating_min_intraday),
              drawdown_max_pct_intraday: numOrNull(dailySnapshot.drawdown_max_pct_intraday),
              drawdown_max_money_intraday: numOrNull(dailySnapshot.drawdown_max_money_intraday),
              realized_pnl: numOrNull(dailySnapshot.realized_pnl),
              trades_count: dailySnapshot.trades_count,
              baskets_count: dailySnapshot.baskets_count,
              wins_count: dailySnapshot.wins_count,
              losses_count: dailySnapshot.losses_count,
              lots_max: numOrNull(dailySnapshot.lots_max),
              is_complete: dailySnapshot.is_complete,
              generated_at: dailySnapshot.generated_at,
            }
          : null,
        available: Boolean(dailySnapshot),
        note: dailySnapshot
          ? null
          : 'no analysis_daily_snapshots row for this date - either it predates the snapshot job, or the job has not run yet for this date. Not reconstructed from partial data.',
      },
    }

    return sendJson(response, 200, { ok: true, ...body })
  } catch (error) {
    // Sanitized response only - the raw error (which could include query
    // fragments) goes to the server log, correlated by request_id, never
    // to the client.
    console.error(`[analysis/v1/report-data] request_id=${requestId}`, error)
    return sendJson(response, 503, errorBody(503, 'query_failed', requestId))
  }
}

import { getWriterPool } from '../_lib/db.js'
import { groupIntoBaskets } from '../_lib/baskets.js'
import { madridMidnightUtc, addDays, madridDateKey } from '../_lib/date.js'

// Cron-only endpoint: writes yesterday's (Europe/Madrid) daily rollup into
// analysis_daily_snapshots. Never reachable by the analysis_reader token -
// it authenticates separately, with CRON_SECRET, and uses a *different*
// DB role (analysis_snapshot_writer) that can INSERT/UPDATE exactly one
// table (see supabase/analysis_reader.sql). It cannot open/close/modify
// trades - it has no grant on the trades/open_positions tables at all,
// only on the read-only analysis_v1_* views.
//
// Vercel Cron fires in UTC and doesn't shift for Europe/Madrid's DST - see
// vercel.json for the schedule and its DST caveat. This handler always
// computes the target date from actual Madrid-timezone math, so a cron
// firing a little early/late (across the DST boundary) still snapshots the
// correct calendar day.

function sendJson(response, status, body) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  return response.status(status).json(body)
}

export default async function handler(request, response) {
  response.setHeader('Allow', 'GET, POST, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET' && request.method !== 'POST') {
    return sendJson(response, 405, { ok: false, error: 'method_not_allowed' })
  }

  const expectedSecret = process.env.CRON_SECRET
  const providedSecret =
    request.headers?.authorization === `Bearer ${expectedSecret}` ? expectedSecret : undefined
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return sendJson(response, 401, { ok: false, error: 'unauthorized' })
  }

  const pool = getWriterPool()
  if (!pool) return sendJson(response, 503, { ok: false, error: 'snapshot_writer_not_configured' })

  const query = request.query ?? {}
  const todayMadrid = madridDateKey(new Date().toISOString())
  const yesterdayMadrid = addDays(todayMadrid, -1)
  const targetDate = (Array.isArray(query.date) ? query.date[0] : query.date) ?? yesterdayMadrid

  const dayStart = madridMidnightUtc(targetDate).toISOString()
  const dayEnd = madridMidnightUtc(addDays(targetDate, 1)).toISOString()

  try {
    const [tradesRes, floatingRes, accountAtEndRes, accountBeforeRes] = await Promise.all([
      pool.query(
        'select * from analysis_v1_closed_trades where close_time >= $1 and close_time < $2 order by close_time asc',
        [dayStart, dayEnd],
      ),
      pool.query(
        'select * from analysis_v1_floating_history where recorded_at >= $1 and recorded_at < $2 order by recorded_at asc',
        [dayStart, dayEnd],
      ),
      // Last balance/equity snapshot at or before the end of the target day.
      pool.query('select * from analysis_v1_account where updated_at < $1 order by updated_at desc limit 1', [dayEnd]),
      pool.query('select * from analysis_v1_account where updated_at < $1 order by updated_at desc limit 1', [dayStart]),
    ])

    const baskets = groupIntoBaskets(tradesRes.rows)
    const wins = baskets.filter((b) => b.isWin)
    const losses = baskets.filter((b) => b.isLoss)
    const realizedPnl = Number(baskets.reduce((s, b) => s + b.pnl, 0).toFixed(2))
    const floatingValues = floatingRes.rows.map((p) => Number(p.floating_pnl))
    const equityValues = floatingRes.rows.map((p) => Number(p.equity))

    const equityClose = accountAtEndRes.rows[0] ? Number(accountAtEndRes.rows[0].equity) : null
    const balanceClose = accountAtEndRes.rows[0] ? Number(accountAtEndRes.rows[0].balance) : null
    const balanceOpen = accountBeforeRes.rows[0] ? Number(accountBeforeRes.rows[0].balance) : balanceClose !== null ? Number((balanceClose - realizedPnl).toFixed(2)) : null
    const equityOpen = accountBeforeRes.rows[0] ? Number(accountBeforeRes.rows[0].equity) : equityClose

    // Data is only as complete as the sync pipeline's coverage of the day -
    // if we have zero floating snapshots AND zero trades, the sync may
    // simply not have been running that day; flag it rather than write a
    // silently-empty "complete" row.
    const isComplete = tradesRes.rows.length > 0 || floatingRes.rows.length > 0

    const row = {
      // The raw MT5 login is stored here (matches trades.account /
      // account_snapshots.account) - masking happens only in the
      // analysis_v1_daily_snapshots *view* analysis_reader reads from.
      account: '730432938',
      snapshot_date: targetDate,
      balance_open: balanceOpen,
      balance_close: balanceClose,
      equity_open: equityOpen,
      equity_close: equityClose,
      equity_min_intraday: equityValues.length ? Math.min(...equityValues) : null,
      equity_max_intraday: equityValues.length ? Math.max(...equityValues) : null,
      floating_max_intraday: floatingValues.length ? Math.min(...floatingValues) : null,
      floating_min_intraday: floatingValues.length ? Math.max(...floatingValues) : null,
      drawdown_max_pct_intraday:
        equityValues.length && equityOpen ? Number((((Math.min(...equityValues) - equityOpen) / equityOpen) * 100).toFixed(4)) : null,
      drawdown_max_money_intraday: equityValues.length && equityOpen ? Number((Math.min(...equityValues) - equityOpen).toFixed(2)) : null,
      realized_pnl: realizedPnl,
      trades_count: tradesRes.rows.length,
      baskets_count: baskets.length,
      wins_count: wins.length,
      losses_count: losses.length,
      lots_max: baskets.length ? Math.max(...baskets.map((b) => b.lotsMax)) : null,
      is_complete: isComplete,
    }

    await pool.query(
      `insert into analysis_daily_snapshots (
        account, snapshot_date, balance_open, balance_close, equity_open, equity_close,
        equity_min_intraday, equity_max_intraday, floating_max_intraday, floating_min_intraday,
        drawdown_max_pct_intraday, drawdown_max_money_intraday, realized_pnl,
        trades_count, baskets_count, wins_count, losses_count, lots_max, is_complete, generated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now()
      )
      on conflict (account, snapshot_date) do update set
        balance_open = excluded.balance_open,
        balance_close = excluded.balance_close,
        equity_open = excluded.equity_open,
        equity_close = excluded.equity_close,
        equity_min_intraday = excluded.equity_min_intraday,
        equity_max_intraday = excluded.equity_max_intraday,
        floating_max_intraday = excluded.floating_max_intraday,
        floating_min_intraday = excluded.floating_min_intraday,
        drawdown_max_pct_intraday = excluded.drawdown_max_pct_intraday,
        drawdown_max_money_intraday = excluded.drawdown_max_money_intraday,
        realized_pnl = excluded.realized_pnl,
        trades_count = excluded.trades_count,
        baskets_count = excluded.baskets_count,
        wins_count = excluded.wins_count,
        losses_count = excluded.losses_count,
        lots_max = excluded.lots_max,
        is_complete = excluded.is_complete,
        generated_at = now()`,
      [
        row.account,
        row.snapshot_date,
        row.balance_open,
        row.balance_close,
        row.equity_open,
        row.equity_close,
        row.equity_min_intraday,
        row.equity_max_intraday,
        row.floating_max_intraday,
        row.floating_min_intraday,
        row.drawdown_max_pct_intraday,
        row.drawdown_max_money_intraday,
        row.realized_pnl,
        row.trades_count,
        row.baskets_count,
        row.wins_count,
        row.losses_count,
        row.lots_max,
        row.is_complete,
      ],
    )

    return sendJson(response, 200, { ok: true, snapshot_date: targetDate, is_complete: isComplete })
  } catch (error) {
    console.error('[analysis/v1/internal/generate-daily-snapshot]', error)
    return sendJson(response, 503, { ok: false, error: 'snapshot_generation_failed' })
  }
}

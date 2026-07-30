import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'

const MAX_HOURS = 24 * 31
const DEFAULT_HOURS = 24
const PAGE_SIZE = 1000
const MAX_ROWS_PER_TABLE = 20000

function bearerToken(request) {
  const authorization = request.headers.authorization ?? ''
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim()
  return ''
}

function validToken(supplied, expected) {
  if (!expected || supplied.length < 32 || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

function safeHours(request) {
  const requested = Number(request.query?.hours ?? DEFAULT_HOURS)
  if (!Number.isFinite(requested)) return DEFAULT_HOURS
  return Math.min(MAX_HOURS, Math.max(1, Math.floor(requested)))
}

async function fetchPaged(buildQuery) {
  const rows = []
  for (let offset = 0; offset < MAX_ROWS_PER_TABLE; offset += PAGE_SIZE) {
    const { data, error } = await buildQuery(offset, offset + PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')

  const expectedToken = process.env.ANALYSIS_API_TOKEN
  const suppliedToken = bearerToken(request)
  if (!validToken(suppliedToken, expectedToken)) {
    return response.status(401).json({
      ok: false,
      error: 'unauthorized',
      generated_at: new Date().toISOString(),
    })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const accountId = process.env.VITE_MT5_ACCOUNT
  if (!supabaseUrl || !serviceRoleKey || !accountId) {
    return response.status(503).json({
      ok: false,
      error: 'private_telemetry_not_configured',
      generated_at: new Date().toISOString(),
    })
  }

  try {
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const hours = safeHours(request)
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    const includeRaw = request.query?.detail === 'raw'

    const [
      accountTelemetry,
      positionTelemetry,
      riskProbes,
      marketTelemetry,
      basketsResult,
      healthResult,
      newsResult,
      versionsResult,
      rawDeals,
      rawOrders,
      runtimeEvents,
    ] = await Promise.all([
      fetchPaged((from, to) =>
        client
          .from('account_telemetry')
          .select('*')
          .eq('account', accountId)
          .gte('recorded_at', since)
          .order('recorded_at')
          .range(from, to),
      ),
      fetchPaged((from, to) =>
        client
          .from('position_telemetry')
          .select('*')
          .eq('account', accountId)
          .gte('recorded_at', since)
          .order('recorded_at')
          .range(from, to),
      ),
      fetchPaged((from, to) =>
        client
          .from('risk_probes')
          .select('*')
          .eq('account', accountId)
          .gte('recorded_at', since)
          .order('recorded_at')
          .range(from, to),
      ),
      fetchPaged((from, to) =>
        client
          .from('market_telemetry')
          .select('*')
          .eq('account', accountId)
          .gte('recorded_at', since)
          .order('recorded_at')
          .range(from, to),
      ),
      client
        .from('basket_telemetry')
        .select('*')
        .eq('account', accountId)
        .gte('close_time', since)
        .order('close_time'),
      client
        .from('sync_health')
        .select('*')
        .eq('account', accountId)
        .gte('started_at', since)
        .order('started_at'),
      client
        .from('economic_events')
        .select('event_time,currency,impact,event_name,source')
        .eq('account', accountId)
        .gte('event_time', since)
        .order('event_time'),
      client
        .from('bot_versions')
        .select(
          'bot_id,magic,version_label,source_sha256,config_sha256,git_commit,' +
          'config_json,first_seen_at,last_seen_at',
        )
        .eq('account', accountId)
        .order('last_seen_at', { ascending: false }),
      includeRaw
        ? fetchPaged((from, to) =>
            client
              .from('raw_deals')
              .select('*')
              .eq('account', accountId)
              .gte('deal_time', since)
              .order('deal_time')
              .range(from, to),
          )
        : Promise.resolve([]),
      includeRaw
        ? fetchPaged((from, to) =>
            client
              .from('raw_orders')
              .select('*')
              .eq('account', accountId)
              .gte('done_time', since)
              .order('done_time')
              .range(from, to),
          )
        : Promise.resolve([]),
      includeRaw
        ? fetchPaged((from, to) =>
            client
              .from('bot_runtime_events')
              .select('*')
              .eq('account', accountId)
              .gte('captured_at', since)
              .order('captured_at')
              .range(from, to),
          )
        : Promise.resolve([]),
    ])

    const firstError =
      basketsResult.error ?? healthResult.error ?? newsResult.error ?? versionsResult.error
    if (firstError) throw firstError

    return response.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      period: { hours, from: since, to: new Date().toISOString() },
      bot: versionsResult.data?.[0]?.bot_id ?? 'R2-A',
      counts: {
        account_snapshots: accountTelemetry.length,
        position_snapshots: positionTelemetry.length,
        risk_probes: riskProbes.length,
        market_snapshots: marketTelemetry.length,
        baskets: basketsResult.data?.length ?? 0,
        sync_runs: healthResult.data?.length ?? 0,
        economic_events: newsResult.data?.length ?? 0,
        raw_deals: rawDeals.length,
        raw_orders: rawOrders.length,
        runtime_events: runtimeEvents.length,
      },
      account_telemetry: accountTelemetry,
      position_telemetry: positionTelemetry,
      risk_probes: riskProbes,
      market_telemetry: marketTelemetry,
      baskets: basketsResult.data ?? [],
      sync_health: healthResult.data ?? [],
      economic_events: newsResult.data ?? [],
      bot_versions: versionsResult.data ?? [],
      raw: includeRaw
        ? { deals: rawDeals, orders: rawOrders, runtime_events: runtimeEvents }
        : undefined,
    })
  } catch (error) {
    return response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'private_telemetry_failed',
      generated_at: new Date().toISOString(),
    })
  }
}

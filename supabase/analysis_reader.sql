-- Read-only analysis access for external tools (e.g. "chatgpt-reader").
-- Run this once in the Supabase SQL Editor, AFTER supabase/schema.sql:
-- https://supabase.com/dashboard/project/dkfnbamheyghbzppwxki/sql/new
--
-- What this gives you:
--   - Two new Postgres LOGIN roles, reachable only via a direct Postgres
--     connection string (not through the anon/service_role PostgREST keys):
--       * analysis_reader          -> SELECT on curated analysis_v1_* views only.
--       * analysis_snapshot_writer -> SELECT on those same views, plus
--         INSERT/UPDATE on analysis_daily_snapshots and INSERT on
--         analysis_incidents only. Cannot touch trades/open_positions/
--         account_snapshots/capital_contributions/analysis_tokens at all -
--         not "restricted by RLS", but literally never GRANTed access, so
--         there's nothing to bypass even if a policy were misconfigured.
--   - Neither role can INSERT/UPDATE/DELETE trading data, run any RPC,
--     or read analysis_tokens (where the bearer-token hashes live).
--   - Both roles are LOGIN roles with a placeholder password below - set a
--     real one immediately after running this (see the ALTER ROLE lines).
--
-- Existing tables/roles (anon, service_role, "public read ..." policies on
-- trades/open_positions/etc.) are untouched. analysis_reader and
-- analysis_snapshot_writer never receive any grant on those base tables,
-- so the permissive `using (true)` policies on them are simply irrelevant
-- to these two roles - Postgres checks table-level GRANTs before RLS ever
-- runs, and neither role has one.

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. New tables
-- ============================================================================

-- Bearer tokens for external read-only tools. Only the SHA-256 hash is
-- stored - the plaintext token is shown to the operator exactly once, at
-- creation time, and is unrecoverable afterwards (matches how e.g. GitHub
-- PATs work). "label" identifies the holder (e.g. "chatgpt-reader") for
-- logs/audit without needing the token itself.
create table if not exists analysis_tokens (
  id bigint generated always as identity primary key,
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  created_by text,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  note text
);

-- Sliding-window rate-limit log, checked/pruned by verify_and_log_analysis_token().
create table if not exists analysis_token_requests (
  id bigint generated always as identity primary key,
  token_id bigint not null references analysis_tokens (id) on delete cascade,
  requested_at timestamptz not null default now(),
  route text,
  ok boolean not null default true
);

create index if not exists analysis_token_requests_token_time_idx
  on analysis_token_requests (token_id, requested_at desc);

-- One row per (account, Europe/Madrid calendar day). Populated by the
-- separate generate-daily-snapshot job (analysis_snapshot_writer), not by
-- analysis_reader. Historical days from before this table existed are
-- intentionally absent - the report API must mark those as unavailable
-- rather than reconstruct them from incomplete data.
create table if not exists analysis_daily_snapshots (
  id bigint generated always as identity primary key,
  account text not null,
  snapshot_date date not null, -- Europe/Madrid calendar date
  balance_open numeric,
  balance_close numeric,
  equity_open numeric,
  equity_close numeric,
  equity_min_intraday numeric,
  equity_max_intraday numeric,
  floating_max_intraday numeric,
  floating_min_intraday numeric,
  drawdown_max_pct_intraday numeric,
  drawdown_max_money_intraday numeric,
  realized_pnl numeric,
  trades_count integer,
  baskets_count integer,
  wins_count integer,
  losses_count integer,
  lots_max numeric,
  is_complete boolean not null default true, -- false if the day's sync data looked partial
  generated_at timestamptz not null default now(),
  unique (account, snapshot_date)
);

create index if not exists analysis_daily_snapshots_account_date_idx
  on analysis_daily_snapshots (account, snapshot_date desc);

-- Sanitized incident log (sync gaps, broker/API errors, stale-data spells).
-- Nothing currently writes to this table - it exists so the sync script
-- (or the snapshot job) can start logging into it later. Until then the
-- API returns an empty list with a note, never a fabricated entry.
create table if not exists analysis_incidents (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  resolved_at timestamptz,
  severity text not null check (severity in ('info', 'warning', 'error')),
  component text not null,
  message text not null, -- must already be sanitized by the writer - no stack traces/secrets
  repeat_count integer not null default 1
);

create index if not exists analysis_incidents_occurred_idx on analysis_incidents (occurred_at desc);

alter table analysis_tokens enable row level security;
alter table analysis_token_requests enable row level security;
alter table analysis_daily_snapshots enable row level security;
alter table analysis_incidents enable row level security;

-- analysis_tokens and analysis_token_requests get NO policies at all, for
-- any role - RLS enabled + zero policies denies every row to everyone
-- except the table owner. verify_and_log_analysis_token() still works
-- because SECURITY DEFINER functions run with their *owner's* privileges
-- (the owner, as table owner, is exempt from RLS by default), regardless
-- of who calls the function. analysis_reader itself never touches these
-- tables - it only ever calls that function.
--
-- analysis_daily_snapshots and analysis_incidents DO need policies: RLS
-- with zero policies would block analysis_snapshot_writer's INSERT/UPDATE
-- even though it already has the table-level GRANT below - GRANT decides
-- whether a role may attempt a command at all, RLS policies decide which
-- rows it may affect, and both are required. analysis_reader still gets no
-- policy here either - it only reads these two through the
-- analysis_v1_daily_snapshots / analysis_v1_incidents views (which run
-- with the view owner's privileges, so RLS on the base table doesn't
-- apply to that read path).
create policy "analysis_snapshot_writer can insert daily snapshots"
  on analysis_daily_snapshots for insert to analysis_snapshot_writer with check (true);
create policy "analysis_snapshot_writer can update daily snapshots"
  on analysis_daily_snapshots for update to analysis_snapshot_writer using (true) with check (true);
create policy "analysis_snapshot_writer can insert incidents"
  on analysis_incidents for insert to analysis_snapshot_writer with check (true);

-- ============================================================================
-- 2. Helpers
-- ============================================================================

-- Masks the raw MT5 login (e.g. "730432938") down to "MT5-***938" so the
-- account number never appears in an analysis response.
create or replace function analysis_mask_account(p_account text)
returns text
language sql
immutable
as $$
  select 'MT5-***' || right(p_account, 3)
$$;

-- ============================================================================
-- 3. Curated read views (SELECT-only surface for analysis_reader)
-- ============================================================================
-- Views run with the privileges of their OWNER (whoever runs this script,
-- normally the postgres/service role), not the caller's - this is the
-- standard Postgres "view as security boundary" pattern. analysis_reader
-- never receives a grant on the underlying tables, only on these views, so
-- it cannot query trades/open_positions/etc. directly no matter what RLS
-- policy exists on them.

create or replace view analysis_v1_bot as
select
  '730432938' as account_raw_do_not_expose, -- never selected by the API layer; kept only for joins if ever needed
  analysis_mask_account('730432938') as account_masked,
  'R2-A' as bot_id,
  'RR0109 R2-A' as bot_name,
  'XAUUSD' as symbol,
  now() as queried_at;

create or replace view analysis_v1_account as
select
  analysis_mask_account(s.account) as account_masked,
  s.balance,
  s.equity,
  s.currency,
  s.updated_at
from account_snapshots s;

create or replace view analysis_v1_open_positions as
select
  p.mt5_ticket as position_id,
  p.direction,
  p.lots,
  p.entry_price,
  p.current_price,
  p.open_time,
  p.floating_pnl,
  p.updated_at
from open_positions p;

create or replace view analysis_v1_closed_trades as
select
  t.id as trade_id,
  t.mt5_deal_id,
  t.direction,
  t.lots,
  t.entry_price,
  t.exit_price,
  t.open_time,
  t.close_time,
  t.pnl, -- already includes commission + swap combined; the sync script does not separate them (see docs/SYNC_SCRIPT_SPEC.md)
  t.exit_reason
from trades t;

create or replace view analysis_v1_floating_history as
select
  f.recorded_at,
  f.floating_pnl,
  f.equity,
  f.balance
from floating_pnl_snapshots f;

-- Aggregate only - never exposes per-partner names/amounts to the analysis
-- token holder, since that's partner PII unrelated to bot analysis.
create or replace view analysis_v1_capital_summary as
select
  coalesce(sum(case when type = 'deposit' then amount else -amount end), 0) as net_capital,
  count(*) as contribution_events,
  max(created_at) as last_contribution_at
from capital_contributions;

create or replace view analysis_v1_daily_snapshots as
select
  analysis_mask_account(account) as account_masked,
  snapshot_date,
  balance_open,
  balance_close,
  equity_open,
  equity_close,
  equity_min_intraday,
  equity_max_intraday,
  floating_max_intraday,
  floating_min_intraday,
  drawdown_max_pct_intraday,
  drawdown_max_money_intraday,
  realized_pnl,
  trades_count,
  baskets_count,
  wins_count,
  losses_count,
  lots_max,
  is_complete,
  generated_at
from analysis_daily_snapshots;

create or replace view analysis_v1_incidents as
select occurred_at, resolved_at, severity, component, message, repeat_count
from analysis_incidents;

-- ============================================================================
-- 4. Token verification + rate limiting (SECURITY DEFINER)
-- ============================================================================
-- analysis_reader is granted EXECUTE on this function only - never SELECT on
-- analysis_tokens itself. The function runs with the privileges of whoever
-- owns it (the migration runner), so it can read/write analysis_tokens and
-- analysis_token_requests even though the caller (analysis_reader) cannot.
--
-- Returns one row: (ok, reason, token_label). "ok=false" covers: unknown
-- token, revoked, expired, or rate-limited - the caller (the report-data
-- serverless function) maps that to 401/403/429 without ever learning why
-- in more detail than "reason" already says (no oracle for guessing tokens).
create or replace function verify_and_log_analysis_token(p_token text, p_route text default null)
returns table (ok boolean, reason text, token_label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_row analysis_tokens%rowtype;
  v_recent_count integer;
  v_rate_limit_per_minute constant integer := 30;
begin
  select * into v_row from analysis_tokens where token_hash = v_hash;

  if v_row.id is null then
    return query select false, 'invalid_token', null::text;
    return;
  end if;

  if v_row.revoked_at is not null then
    return query select false, 'revoked', v_row.label;
    return;
  end if;

  if v_row.expires_at is not null and v_row.expires_at < now() then
    return query select false, 'expired', v_row.label;
    return;
  end if;

  select count(*) into v_recent_count
  from analysis_token_requests
  where token_id = v_row.id and requested_at > now() - interval '1 minute';

  if v_recent_count >= v_rate_limit_per_minute then
    insert into analysis_token_requests (token_id, route, ok) values (v_row.id, p_route, false);
    return query select false, 'rate_limited', v_row.label;
    return;
  end if;

  insert into analysis_token_requests (token_id, route, ok) values (v_row.id, p_route, true);
  update analysis_tokens set last_used_at = now() where id = v_row.id;

  return query select true, 'ok', v_row.label;
end;
$$;

-- ============================================================================
-- 5. Roles
-- ============================================================================
-- CHANGE THESE PASSWORDS before/immediately after running this script - do
-- not leave the placeholder in place, and do not commit the real password
-- anywhere. Generate one with e.g. `openssl rand -base64 32`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'analysis_reader') then
    create role analysis_reader with login password 'CHANGE_ME_STRONG_RANDOM_PASSWORD_1';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'analysis_snapshot_writer') then
    create role analysis_snapshot_writer with login password 'CHANGE_ME_STRONG_RANDOM_PASSWORD_2';
  end if;
end
$$;

-- Keep session limits sane for two roles only ever used by short-lived
-- serverless function invocations.
alter role analysis_reader connection limit 10;
alter role analysis_snapshot_writer connection limit 5;

grant usage on schema public to analysis_reader, analysis_snapshot_writer;

-- analysis_reader: SELECT on curated views only, EXECUTE on the token
-- verifier only. No INSERT/UPDATE/DELETE grant exists anywhere for this
-- role, on any table or view - there is nothing to revoke to make writes
-- fail, because they were never granted in the first place.
grant select on
  analysis_v1_bot,
  analysis_v1_account,
  analysis_v1_open_positions,
  analysis_v1_closed_trades,
  analysis_v1_floating_history,
  analysis_v1_capital_summary,
  analysis_v1_daily_snapshots,
  analysis_v1_incidents
to analysis_reader;

grant execute on function verify_and_log_analysis_token(text, text) to analysis_reader;

-- analysis_snapshot_writer: same read views (to compute a day's rollup),
-- plus write access to exactly two analysis-only tables. It still cannot
-- reach trades/open_positions/account_snapshots/capital_contributions
-- directly, and has no EXECUTE grant on verify_and_log_analysis_token.
grant select on
  analysis_v1_account,
  analysis_v1_open_positions,
  analysis_v1_closed_trades,
  analysis_v1_floating_history,
  analysis_v1_daily_snapshots
to analysis_snapshot_writer;

grant insert, update on analysis_daily_snapshots to analysis_snapshot_writer;
grant insert on analysis_incidents to analysis_snapshot_writer;
grant usage on sequence analysis_daily_snapshots_id_seq to analysis_snapshot_writer;
grant usage on sequence analysis_incidents_id_seq to analysis_snapshot_writer;

-- Belt-and-suspenders: explicitly confirm neither role has anything on the
-- operational tables. (These are no-ops if nothing was ever granted, which
-- is the expected state - they exist so a future "GRANT ALL" mistake gets
-- immediately undone by re-running this script.)
revoke all on trades, open_positions, account_snapshots, floating_pnl_snapshots,
  capital_contributions, analysis_reports, analysis_tokens, analysis_token_requests
  from analysis_reader, analysis_snapshot_writer;

-- ============================================================================
-- 6. Create your first token (run separately, in the SQL Editor, once)
-- ============================================================================
-- Generate a random token client-side (or with gen_random_uuid()||gen_random_uuid()),
-- hash it the same way verify_and_log_analysis_token() does, and store only
-- the hash. Example - replace the literal token before running, then copy
-- the plaintext into Vercel as ANALYSIS_READER_TOKEN_CHATGPT and discard it:
--
--   insert into analysis_tokens (label, token_hash, created_by, note)
--   values (
--     'chatgpt-reader',
--     encode(digest('PASTE_A_LONG_RANDOM_TOKEN_HERE', 'sha256'), 'hex'),
--     'you',
--     'created for external read-only analysis'
--   );
--
-- To revoke it later:
--   update analysis_tokens set revoked_at = now() where label = 'chatgpt-reader';
--
-- To rotate it: revoke the old row (above) and insert a new one with a new
-- random token - old and new can coexist during the switch-over.

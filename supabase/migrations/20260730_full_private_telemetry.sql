-- Telemetria completa R2-A.
-- Executar una sola vegada al SQL Editor de Supabase.
-- Les taules *_telemetry, raw_* i bot_* NO tenen cap policy de lectura anon.

alter table trades
  add column if not exists position_id bigint,
  add column if not exists basket_id text,
  add column if not exists entry_deal_id bigint,
  add column if not exists gross_profit numeric,
  add column if not exists commission numeric,
  add column if not exists swap numeric,
  add column if not exists fee numeric,
  add column if not exists entry_requested_price numeric,
  add column if not exists exit_requested_price numeric,
  add column if not exists entry_slippage_points numeric,
  add column if not exists exit_slippage_points numeric,
  add column if not exists entry_reason_code integer,
  add column if not exists exit_reason_code integer,
  add column if not exists magic bigint,
  add column if not exists comment text,
  add column if not exists bot_version_key text;

create index if not exists trades_account_basket_idx
  on trades (account, basket_id, close_time);

create table if not exists bot_versions (
  id bigint generated always as identity primary key,
  account text not null,
  bot_id text not null,
  magic bigint not null,
  version_label text not null,
  source_sha256 text not null default '',
  config_sha256 text not null,
  git_commit text,
  source_path_hint text,
  config_json jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (account, bot_id, source_sha256, config_sha256)
);

create table if not exists account_telemetry (
  id bigint generated always as identity primary key,
  account text not null,
  minute_bucket timestamptz not null,
  recorded_at timestamptz not null default now(),
  bot_version_key text not null,
  balance numeric not null,
  equity numeric not null,
  profit numeric not null,
  margin numeric not null,
  margin_free numeric not null,
  margin_level numeric not null,
  currency text not null,
  leverage integer,
  trade_mode integer,
  position_count integer not null,
  total_lots numeric not null,
  floating_pnl numeric not null,
  equity_peak numeric not null,
  drawdown_amount numeric not null,
  drawdown_pct numeric not null,
  day_start_balance numeric not null,
  day_closed_pnl numeric not null,
  intraday_drawdown_amount numeric not null,
  intraday_drawdown_pct numeric not null,
  effective_base_lot numeric not null,
  effective_max_total_lot numeric not null,
  effective_max_floating_loss numeric not null,
  floating_limit_used_pct numeric not null,
  lot_limit_used_pct numeric not null,
  bid numeric,
  ask numeric,
  spread_price numeric,
  spread_points numeric,
  tick_age_seconds numeric,
  atr_m1 numeric,
  atr_m5 numeric,
  spread_atr_ratio numeric,
  rsi_m1 numeric,
  adx_m1 numeric,
  recent_move_5m numeric,
  recent_move_15m numeric,
  recent_move_60m numeric,
  latest_bar_range numeric,
  latest_bar_body numeric,
  tick_volume bigint,
  news_block_active boolean not null default false,
  news_block_reason text,
  rollover_block_active boolean not null default false,
  server text,
  company text,
  terminal_build integer,
  unique (account, minute_bucket)
);

create index if not exists account_telemetry_account_time_idx
  on account_telemetry (account, recorded_at);

create index if not exists account_telemetry_risk_idx
  on account_telemetry (account, floating_limit_used_pct desc, recorded_at);

create table if not exists position_telemetry (
  id bigint generated always as identity primary key,
  account text not null,
  mt5_ticket bigint not null,
  position_id bigint,
  basket_id text,
  minute_bucket timestamptz not null,
  recorded_at timestamptz not null default now(),
  bot_version_key text not null,
  direction text not null check (direction in ('BUY', 'SELL')),
  lots numeric not null,
  entry_price numeric not null,
  current_price numeric not null,
  open_time timestamptz not null,
  age_seconds bigint not null,
  profit numeric not null,
  swap numeric not null,
  floating_pnl numeric not null,
  sl numeric,
  tp numeric,
  distance_price numeric not null,
  distance_points numeric not null,
  favorable_move_price numeric not null,
  adverse_move_price numeric not null,
  magic bigint not null,
  comment text,
  reason_code integer,
  spread_points numeric,
  unique (account, mt5_ticket, minute_bucket)
);

create index if not exists position_telemetry_account_ticket_time_idx
  on position_telemetry (account, mt5_ticket, recorded_at);

create table if not exists risk_probes (
  id bigint generated always as identity primary key,
  account text not null,
  basket_id text not null,
  probe_bucket timestamptz not null,
  recorded_at timestamptz not null default now(),
  equity numeric not null,
  floating_pnl numeric not null,
  margin_free numeric not null,
  margin_level numeric not null,
  position_count integer not null,
  total_lots numeric not null,
  bid numeric,
  ask numeric,
  spread_points numeric,
  effective_max_floating_loss numeric not null,
  floating_limit_used_pct numeric not null,
  unique (account, basket_id, probe_bucket)
);

create index if not exists risk_probes_account_basket_time_idx
  on risk_probes (account, basket_id, recorded_at);

create table if not exists market_telemetry (
  id bigint generated always as identity primary key,
  account text not null,
  symbol text not null,
  minute_bucket timestamptz not null,
  recorded_at timestamptz not null default now(),
  broker_bar_time timestamptz,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  tick_volume bigint,
  real_volume bigint,
  bid numeric,
  ask numeric,
  spread_price numeric,
  spread_points numeric,
  atr_m1 numeric,
  atr_m5 numeric,
  spread_atr_ratio numeric,
  rsi_m1 numeric,
  adx_m1 numeric,
  recent_move_5m numeric,
  recent_move_15m numeric,
  recent_move_60m numeric,
  unique (account, symbol, minute_bucket)
);

create index if not exists market_telemetry_account_time_idx
  on market_telemetry (account, recorded_at);

create table if not exists raw_deals (
  id bigint generated always as identity primary key,
  account text not null,
  deal_ticket bigint not null,
  order_ticket bigint,
  position_id bigint,
  deal_time timestamptz not null,
  symbol text,
  deal_type integer,
  entry_type integer,
  reason_code integer,
  magic bigint,
  volume numeric,
  price numeric,
  commission numeric,
  swap numeric,
  profit numeric,
  fee numeric,
  comment text,
  external_id text,
  bot_version_key text not null,
  captured_at timestamptz not null default now(),
  unique (account, deal_ticket)
);

create index if not exists raw_deals_account_position_idx
  on raw_deals (account, position_id, deal_time);

create table if not exists raw_orders (
  id bigint generated always as identity primary key,
  account text not null,
  order_ticket bigint not null,
  position_id bigint,
  setup_time timestamptz,
  done_time timestamptz,
  order_type integer,
  state_code integer,
  reason_code integer,
  magic bigint,
  volume_initial numeric,
  volume_current numeric,
  requested_price numeric,
  current_price numeric,
  stop_limit_price numeric,
  sl numeric,
  tp numeric,
  comment text,
  external_id text,
  bot_version_key text not null,
  captured_at timestamptz not null default now(),
  unique (account, order_ticket)
);

create index if not exists raw_orders_account_position_idx
  on raw_orders (account, position_id, done_time);

create table if not exists bot_runtime_events (
  id bigint generated always as identity primary key,
  account text not null,
  source_file text not null,
  row_hash text not null,
  event_time timestamptz,
  payload jsonb not null,
  bot_version_key text not null,
  captured_at timestamptz not null default now(),
  unique (account, source_file, row_hash)
);

create table if not exists economic_events (
  id bigint generated always as identity primary key,
  account text not null,
  event_time timestamptz not null,
  currency text not null,
  impact text not null,
  event_name text not null,
  source text not null default 'bot-news-file',
  source_hash text not null,
  captured_at timestamptz not null default now(),
  unique (account, source_hash)
);

create index if not exists economic_events_account_time_idx
  on economic_events (account, event_time);

create table if not exists sync_health (
  id bigint generated always as identity primary key,
  account text not null,
  run_id text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('ok', 'error')),
  duration_ms integer not null,
  closed_positions integer not null default 0,
  open_positions integer not null default 0,
  raw_deals integer not null default 0,
  raw_orders integer not null default 0,
  runtime_events integer not null default 0,
  error_type text,
  error_message text,
  bot_version_key text,
  unique (account, run_id)
);

create index if not exists sync_health_account_time_idx
  on sync_health (account, started_at desc);

-- Un sol resum actual. És la capa segura que pot consumir el dashboard.
create table if not exists telemetry_summary (
  account text primary key,
  bot_id text not null,
  updated_at timestamptz not null,
  summary_date date not null,
  bot_version_key text not null,
  balance numeric not null,
  equity numeric not null,
  floating_pnl numeric not null,
  margin_free numeric not null,
  margin_level numeric not null,
  position_count integer not null,
  total_lots numeric not null,
  drawdown_amount numeric not null,
  drawdown_pct numeric not null,
  intraday_drawdown_amount numeric not null,
  intraday_drawdown_pct numeric not null,
  effective_base_lot numeric not null,
  effective_max_total_lot numeric not null,
  effective_max_floating_loss numeric not null,
  floating_limit_used_pct numeric not null,
  lot_limit_used_pct numeric not null,
  bid numeric,
  ask numeric,
  spread_points numeric,
  atr_m1 numeric,
  atr_m5 numeric,
  spread_atr_ratio numeric,
  rsi_m1 numeric,
  adx_m1 numeric,
  recent_move_5m numeric,
  recent_move_15m numeric,
  recent_move_60m numeric,
  news_block_active boolean not null default false,
  news_block_reason text,
  rollover_block_active boolean not null default false,
  day_worst_floating numeric not null,
  day_max_floating_limit_used_pct numeric not null,
  day_max_spread_points numeric,
  day_max_spread_atr_ratio numeric,
  day_min_margin_level numeric,
  day_worst_intraday_drawdown_pct numeric not null,
  sync_duration_ms integer not null
);

-- Vista privada de cistelles: totes les potes, costos i MAE/MFE de compte.
create or replace view basket_telemetry
with (security_invoker = true)
as
with grouped as (
  select
    account,
    basket_id,
    min(open_time) as open_time,
    max(close_time) as close_time,
    min(direction) as direction,
    count(*) as order_count,
    greatest(count(*) - 1, 0) as add_count,
    sum(lots) as total_lots,
    sum(coalesce(gross_profit, pnl)) as gross_profit,
    sum(coalesce(commission, 0)) as commission,
    sum(coalesce(swap, 0)) as swap,
    sum(coalesce(fee, 0)) as fee,
    case
      when sum(lots) > 0 then sum(coalesce(entry_slippage_points, 0) * lots) / sum(lots)
      else null
    end as avg_entry_slippage_points,
    case
      when sum(lots) > 0 then sum(coalesce(exit_slippage_points, 0) * lots) / sum(lots)
      else null
    end as avg_exit_slippage_points,
    sum(pnl) as net_pnl,
    min(bot_version_key) as bot_version_key
  from trades
  where basket_id is not null
  group by account, basket_id
)
select
  grouped.*,
  extract(epoch from (grouped.close_time - grouped.open_time))::bigint as duration_seconds,
  risk.mae,
  risk.mfe,
  risk.max_spread_points,
  risk.avg_spread_points,
  risk.starting_balance,
  risk.ending_balance,
  case
    when risk.starting_balance > 0 then risk.mae / risk.starting_balance * 100
    else null
  end as mae_pct,
  case
    when risk.starting_balance > 0 then risk.mfe / risk.starting_balance * 100
    else null
  end as mfe_pct
from grouped
left join lateral (
  select
    min(floating_pnl) as mae,
    max(floating_pnl) as mfe,
    max(spread_points) as max_spread_points,
    avg(spread_points) as avg_spread_points,
    (array_agg(balance order by recorded_at asc))[1] as starting_balance,
    (array_agg(balance order by recorded_at desc))[1] as ending_balance
  from (
    select
      account,
      recorded_at,
      floating_pnl,
      spread_points,
      balance
    from account_telemetry
    union all
    select
      risk_probes.account,
      risk_probes.recorded_at,
      risk_probes.floating_pnl,
      risk_probes.spread_points,
      account_telemetry.balance
    from risk_probes
    join lateral (
      select balance
      from account_telemetry
      where account_telemetry.account = risk_probes.account
        and account_telemetry.recorded_at <= risk_probes.recorded_at
      order by account_telemetry.recorded_at desc
      limit 1
    ) account_telemetry on true
  ) risk_points
  where risk_points.account = grouped.account
    and risk_points.recorded_at between grouped.open_time and grouped.close_time
) risk on true;

alter table bot_versions enable row level security;
alter table account_telemetry enable row level security;
alter table position_telemetry enable row level security;
alter table risk_probes enable row level security;
alter table market_telemetry enable row level security;
alter table raw_deals enable row level security;
alter table raw_orders enable row level security;
alter table bot_runtime_events enable row level security;
alter table economic_events enable row level security;
alter table sync_health enable row level security;
alter table telemetry_summary enable row level security;

drop policy if exists "public read telemetry_summary" on telemetry_summary;
create policy "public read telemetry_summary"
  on telemetry_summary for select using (true);

-- No es creen policies anon per a la telemetria profunda.
-- El sincronitzador i l'API privada fan servir service_role.

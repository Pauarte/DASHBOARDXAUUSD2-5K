-- Run this once in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/dkfnbamheyghbzppwxki/sql/new

create table if not exists trades (
  id bigint generated always as identity primary key,
  account text not null,
  symbol text not null default 'XAUUSD',
  direction text not null check (direction in ('BUY', 'SELL')),
  lots numeric not null,
  entry_price numeric not null,
  exit_price numeric not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  pnl numeric not null,
  exit_reason text not null,
  mt5_deal_id bigint,
  created_at timestamptz not null default now(),
  unique (account, mt5_deal_id)
);

create index if not exists trades_account_close_time_idx on trades (account, close_time);

create table if not exists open_positions (
  id bigint generated always as identity primary key,
  account text not null,
  symbol text not null default 'XAUUSD',
  direction text not null check (direction in ('BUY', 'SELL')),
  lots numeric not null,
  entry_price numeric not null,
  current_price numeric not null,
  open_time timestamptz not null,
  floating_pnl numeric not null,
  mt5_ticket bigint not null,
  updated_at timestamptz not null default now(),
  unique (account, mt5_ticket)
);

create table if not exists account_snapshots (
  account text primary key,
  balance numeric not null,
  equity numeric not null,
  currency text not null default 'USD',
  updated_at timestamptz not null default now()
);

-- One row per sync pass (never overwritten), so we can find the worst
-- floating P&L the account has ever been exposed to, and when it happened.
create table if not exists floating_pnl_snapshots (
  id bigint generated always as identity primary key,
  account text not null,
  floating_pnl numeric not null,
  equity numeric not null,
  balance numeric not null,
  recorded_at timestamptz not null default now()
);

create index if not exists floating_pnl_snapshots_account_recorded_idx
  on floating_pnl_snapshots (account, recorded_at);

create table if not exists analysis_reports (
  id bigint generated always as identity primary key,
  bot_id text not null,
  report_date date not null,
  period text not null check (period in ('daily', 'weekly', 'monthly')),
  title text not null,
  content text not null,
  source text not null default 'scheduled-chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, report_date, period)
);

create index if not exists analysis_reports_bot_date_idx
  on analysis_reports (bot_id, report_date desc);

-- Public dashboard uses the anon key: allow it to read, never to write.
-- The sync script uses the service_role key instead, which bypasses RLS.
alter table trades enable row level security;
alter table open_positions enable row level security;
alter table account_snapshots enable row level security;
alter table floating_pnl_snapshots enable row level security;
alter table analysis_reports enable row level security;

create policy "public read trades" on trades for select using (true);
create policy "public read open_positions" on open_positions for select using (true);
create policy "public read account_snapshots" on account_snapshots for select using (true);
create policy "public read floating_pnl_snapshots" on floating_pnl_snapshots for select using (true);
create policy "public read analysis_reports" on analysis_reports for select using (true);

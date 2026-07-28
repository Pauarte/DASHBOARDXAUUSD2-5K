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

-- Public dashboard uses the anon key: allow it to read, never to write.
-- The sync script uses the service_role key instead, which bypasses RLS.
alter table trades enable row level security;
alter table open_positions enable row level security;
alter table account_snapshots enable row level security;

create policy "public read trades" on trades for select using (true);
create policy "public read open_positions" on open_positions for select using (true);
create policy "public read account_snapshots" on account_snapshots for select using (true);

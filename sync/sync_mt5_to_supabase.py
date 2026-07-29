"""
MT5 -> Supabase sync script.

Runs continuously on the VPS, next to the already-open, already-logged-in
MT5 terminal for account 730432938, and writes XAUUSD trades/positions/
balance into Supabase so the dashboard shows real data.

See ../docs/SYNC_SCRIPT_SPEC.md for the full spec this implements.

Setup on the VPS:
    pip install supabase MetaTrader5 python-dotenv
    copy .env.example to .env and fill in the values
    python sync_mt5_to_supabase.py
"""

import datetime
import os
import time
from collections import defaultdict
from pathlib import Path

import MetaTrader5 as mt5
from dotenv import load_dotenv
from supabase import create_client

# Load .env from this script's own folder because Scheduled Tasks may use a
# different working directory.
load_dotenv(Path(__file__).resolve().parent / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
TERMINAL_PATH = os.environ["MT5_TERMINAL_PATH"]
ACCOUNT_LOGIN = int(os.environ["MT5_ACCOUNT"])

SYMBOL_FILTER = "XAUUSD"
POLL_SECONDS = 60
HISTORY_LOOKBACK_DAYS = 30

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def log(message: str) -> None:
    print(f"[{utc_now().isoformat(timespec='seconds')}] {message}", flush=True)


def server_utc_offset_seconds() -> float:
    """
    MT5 deal/position 'time' fields are Unix epoch numbers computed from the
    broker SERVER's clock, not true UTC — a well-known MT5 gotcha. Naively
    converting them with tz=utc silently mislabels server-local time as UTC
    (this account's server runs a few hours ahead of real UTC), which made
    every timestamp in the dashboard wrong. Measure the live offset between
    the server's current tick time and this machine's true UTC clock, and
    round to the nearest hour since broker offsets are always whole hours.
    """
    tick = mt5.symbol_info_tick(SYMBOL_FILTER)
    if tick is None or not tick.time:
        return 0
    raw_offset = tick.time - time.time()
    return round(raw_offset / 3600) * 3600


def to_utc_iso(epoch_seconds: float, offset_seconds: float) -> str:
    true_epoch = epoch_seconds - offset_seconds
    return datetime.datetime.fromtimestamp(true_epoch, tz=datetime.timezone.utc).isoformat()


def connect():
    mt5.shutdown()
    if not mt5.initialize(path=TERMINAL_PATH):
        raise RuntimeError(f"mt5.initialize failed: {mt5.last_error()}")
    account = mt5.account_info()
    if account is None:
        raise RuntimeError(f"account_info failed: {mt5.last_error()}")
    if account.login != ACCOUNT_LOGIN:
        raise RuntimeError(
            f"Wrong MT5 account: expected {ACCOUNT_LOGIN}, terminal has {account.login}"
        )
    return account


def ensure_connected():
    account = mt5.account_info()
    if account is None:
        return connect()
    if account.login != ACCOUNT_LOGIN:
        raise RuntimeError(
            f"Wrong MT5 account: expected {ACCOUNT_LOGIN}, terminal has {account.login}"
        )
    return account


def sync_closed_trades():
    offset = server_utc_offset_seconds()
    to_date = datetime.datetime.now()
    from_date = to_date - datetime.timedelta(days=HISTORY_LOOKBACK_DAYS)

    deals = mt5.history_deals_get(from_date, to_date)
    if deals is None:
        deals = ()

    # The account is dedicated to this bot. Track every XAUUSD position because
    # Bitget does not preserve the MT5 magic number reliably on every deal.
    by_position = defaultdict(list)
    for d in deals:
        if d.symbol != SYMBOL_FILTER:
            continue
        by_position[d.position_id].append(d)

    rows = []
    for position_id, position_deals in by_position.items():
        entries = [d for d in position_deals if d.entry == mt5.DEAL_ENTRY_IN]
        exits = [
            d
            for d in position_deals
            if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)
        ]
        if not entries or not exits:
            continue  # not a fully closed position
        entry_volume = sum(d.volume for d in entries)
        exit_volume = sum(d.volume for d in exits)
        if entry_volume <= 0 or exit_volume <= 0:
            continue
        entry_price = sum(d.price * d.volume for d in entries) / entry_volume
        exit_price = sum(d.price * d.volume for d in exits) / exit_volume

        open_time = min(d.time for d in entries)
        close_time = max(d.time for d in exits)
        pnl = sum(
            d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
            for d in position_deals
        )
        direction = "BUY" if entries[0].type == mt5.DEAL_TYPE_BUY else "SELL"
        exit_deal_id = max(exits, key=lambda d: (d.time, d.ticket)).ticket

        rows.append(
            {
                "account": str(ACCOUNT_LOGIN),
                "symbol": SYMBOL_FILTER,
                "direction": direction,
                "lots": exit_volume,
                "entry_price": entry_price,
                "exit_price": exit_price,
                "open_time": to_utc_iso(open_time, offset),
                "close_time": to_utc_iso(close_time, offset),
                "pnl": pnl,
                # TODO: refine once we know this bot's actual exit logic (TP/MANUAL/TIME).
                "exit_reason": "MANUAL",
                "mt5_deal_id": exit_deal_id,
            }
        )

    if rows:
        supabase.table("trades").upsert(rows, on_conflict="account,mt5_deal_id").execute()
    return len(rows)


def sync_open_positions(updated_at: str):
    offset = server_utc_offset_seconds()
    positions = mt5.positions_get(symbol=SYMBOL_FILTER) or ()

    live_tickets = [p.ticket for p in positions]
    rows = [
        {
            "account": str(ACCOUNT_LOGIN),
            "symbol": SYMBOL_FILTER,
            "direction": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "lots": p.volume,
            "entry_price": p.price_open,
            "current_price": p.price_current,
            "open_time": to_utc_iso(p.time, offset),
            "floating_pnl": p.profit + p.swap,
            "mt5_ticket": p.ticket,
            "updated_at": updated_at,
        }
        for p in positions
    ]

    query = supabase.table("open_positions").delete().eq("account", str(ACCOUNT_LOGIN))
    if live_tickets:
        query = query.not_.in_("mt5_ticket", live_tickets)
    query.execute()

    if rows:
        supabase.table("open_positions").upsert(rows, on_conflict="account,mt5_ticket").execute()
    return len(rows)


def sync_account_snapshot(account, updated_at: str):
    supabase.table("account_snapshots").upsert(
        {
            "account": str(ACCOUNT_LOGIN),
            "balance": account.balance,
            "equity": account.equity,
            "currency": account.currency,
            "updated_at": updated_at,
        },
        on_conflict="account",
    ).execute()


def record_floating_snapshot(account):
    positions = mt5.positions_get(symbol=SYMBOL_FILTER) or ()
    floating_pnl = sum(p.profit + p.swap for p in positions)

    # Append-only history (never upserted) so we can find the worst floating
    # P&L this account has ever been exposed to, and exactly when it happened.
    supabase.table("floating_pnl_snapshots").insert(
        {
            "account": str(ACCOUNT_LOGIN),
            "floating_pnl": floating_pnl,
            "equity": account.equity,
            "balance": account.balance,
        }
    ).execute()
    return floating_pnl


def main():
    log(f"Starting MT5 sync for account {ACCOUNT_LOGIN}; interval={POLL_SECONDS}s.")
    while True:
        pass_started = time.monotonic()
        try:
            account = ensure_connected()
            updated_at = utc_now().isoformat()
            closed_positions = sync_closed_trades()
            open_positions = sync_open_positions(updated_at)
            sync_account_snapshot(account, updated_at)
            floating_pnl = record_floating_snapshot(account)
            log(
                "Sync pass OK. "
                f"balance={account.balance:.2f} equity={account.equity:.2f} "
                f"closed={closed_positions} open={open_positions} "
                f"floating={floating_pnl:.2f}"
            )
        except Exception as exc:  # one bad pass must not kill the loop
            log(f"Sync pass failed: {exc!r}")

        elapsed = time.monotonic() - pass_started
        time.sleep(max(1, POLL_SECONDS - elapsed))


if __name__ == "__main__":
    main()

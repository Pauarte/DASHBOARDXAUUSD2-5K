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
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

import MetaTrader5 as mt5
from dotenv import load_dotenv
from supabase import create_client

# Load .env from this script's own folder, not the process's current
# working directory — the Scheduled Task (and the self-restart via
# os.execv below) may launch this from a different CWD, which made plain
# load_dotenv() silently find nothing and crash with KeyError.
load_dotenv(Path(__file__).resolve().parent / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
TERMINAL_PATH = os.environ["MT5_TERMINAL_PATH"]
ACCOUNT_LOGIN = int(os.environ["MT5_ACCOUNT"])
MAGIC_FILTER = int(os.environ["MT5_MAGIC_NUMBER"])

SYMBOL_FILTER = "XAUUSD"
POLL_SECONDS = 60
HISTORY_LOOKBACK_DAYS = 30

# Self-update: check GitHub for a newer version of this file every N passes,
# and if it changed, overwrite this file on disk and restart the process —
# so pushing a fix means the VPS picks it up on its own within a few
# minutes, no manual copy/paste or double-click needed.
SELF_UPDATE_URL = (
    "https://raw.githubusercontent.com/Pauarte/DASHBOARDXAUUSD2-5K/main/sync/sync_mt5_to_supabase.py"
)
SELF_UPDATE_EVERY_N_PASSES = 5
SELF_PATH = os.path.abspath(__file__)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


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


def sync_closed_trades():
    offset = server_utc_offset_seconds()
    to_date = datetime.datetime.now()
    from_date = to_date - datetime.timedelta(days=HISTORY_LOOKBACK_DAYS)

    deals = mt5.history_deals_get(from_date, to_date)
    if deals is None:
        deals = ()

    # Group by symbol only here — MT5 sometimes tags the closing deal with a
    # different (or zero) magic number than the opening deal, so filtering
    # every deal by MAGIC_FILTER can silently drop the exit leg and make a
    # fully closed position never show up. Magic is checked below, on the
    # entry deal only, since that's what identifies "this bot opened it".
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
        if entries[0].magic != MAGIC_FILTER:
            continue  # not opened by this bot

        entry_volume = sum(d.volume for d in entries)
        exit_volume = sum(d.volume for d in exits)
        entry_price = sum(d.price * d.volume for d in entries) / entry_volume
        exit_price = sum(d.price * d.volume for d in exits) / exit_volume

        open_time = min(d.time for d in entries)
        close_time = max(d.time for d in exits)
        pnl = sum(d.profit + d.commission + d.swap for d in position_deals)
        direction = "BUY" if entries[0].type == mt5.DEAL_TYPE_BUY else "SELL"
        exit_deal_id = max(exits, key=lambda d: d.time).ticket

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


def sync_open_positions():
    offset = server_utc_offset_seconds()
    positions = mt5.positions_get(symbol=SYMBOL_FILTER) or ()
    positions = [p for p in positions if p.magic == MAGIC_FILTER]

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
        }
        for p in positions
    ]

    query = supabase.table("open_positions").delete().eq("account", str(ACCOUNT_LOGIN))
    if live_tickets:
        query = query.not_.in_("mt5_ticket", live_tickets)
    query.execute()

    if rows:
        supabase.table("open_positions").upsert(rows, on_conflict="account,mt5_ticket").execute()


def sync_account_snapshot():
    account = mt5.account_info()
    if account is None:
        return
    supabase.table("account_snapshots").upsert(
        {
            "account": str(ACCOUNT_LOGIN),
            "balance": account.balance,
            "equity": account.equity,
            "currency": account.currency,
        },
        on_conflict="account",
    ).execute()


def record_floating_snapshot():
    account = mt5.account_info()
    if account is None:
        return

    positions = mt5.positions_get(symbol=SYMBOL_FILTER) or ()
    positions = [p for p in positions if p.magic == MAGIC_FILTER]
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


def check_for_update():
    try:
        with urllib.request.urlopen(SELF_UPDATE_URL, timeout=10) as resp:
            remote_code = resp.read()
    except Exception as exc:
        print(f"Update check failed (ignoring): {exc}")
        return

    with open(SELF_PATH, "rb") as f:
        local_code = f.read()

    if remote_code and remote_code != local_code:
        print("New version available — updating and restarting…")
        with open(SELF_PATH, "wb") as f:
            f.write(remote_code)
        os.execv(sys.executable, [sys.executable, SELF_PATH])


def main():
    connect()
    print(f"Connected to MT5 account {ACCOUNT_LOGIN}, syncing every {POLL_SECONDS}s.")
    pass_count = 0
    while True:
        try:
            sync_closed_trades()
            sync_open_positions()
            sync_account_snapshot()
            record_floating_snapshot()
            print("Sync pass OK.")
        except Exception as exc:  # one bad pass must not kill the loop
            print(f"Sync pass failed: {exc}")

        pass_count += 1
        if pass_count % SELF_UPDATE_EVERY_N_PASSES == 0:
            check_for_update()

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()

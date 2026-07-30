"""
Sincronitzador MT5 -> Supabase de només lectura.

Manté les taules compatibles del dashboard i, quan la migració de telemetria
està instal·lada, registra una auditoria privada completa per minut.
No importa cap mòdul del bot i no conté cap crida a order_send.
"""

from __future__ import annotations

import ast
import csv
import datetime
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import MetaTrader5 as mt5
from dotenv import load_dotenv
from supabase import create_client


SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR / ".env", override=True)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
TERMINAL_PATH = os.environ["MT5_TERMINAL_PATH"]
ACCOUNT_LOGIN = int(os.environ["MT5_ACCOUNT"])
MAGIC_FILTER = int(os.environ["MT5_MAGIC_NUMBER"])
SYMBOL_FILTER = os.getenv("MT5_SYMBOL", "XAUUSD").strip() or "XAUUSD"

POLL_SECONDS = max(10, int(os.getenv("SYNC_INTERVAL_SECONDS", "60")))
RISK_PROBE_SECONDS = max(5, int(os.getenv("RISK_PROBE_SECONDS", "5")))
INCREMENTAL_LOOKBACK_DAYS = 3
MADRID_TZ = ZoneInfo("Europe/Madrid")

BOT_ID = os.getenv("BOT_ID", "R2-A").strip() or "R2-A"
BOT_VERSION = os.getenv("BOT_VERSION", "R2-A spread/ATR 0.12 grid 2.25 cap 0.07").strip()
BOT_GIT_COMMIT = os.getenv("BOT_GIT_COMMIT", "").strip() or None
BOT_SOURCE_PATH = Path(os.getenv("BOT_SOURCE_PATH", "").strip()) if os.getenv("BOT_SOURCE_PATH") else None
BOT_RUNTIME_DIR = Path(os.getenv("BOT_RUNTIME_DIR", "").strip()) if os.getenv("BOT_RUNTIME_DIR") else None
BOT_NEWS_FILE = Path(os.getenv("BOT_NEWS_FILE", "").strip()) if os.getenv("BOT_NEWS_FILE") else None

REFERENCE_EQUITY = float(os.getenv("BOT_REFERENCE_EQUITY", "2500"))
RESERVE_PCT = float(os.getenv("BOT_RESERVE_PCT", "20"))
MAX_AUTO_SCALE = float(os.getenv("BOT_MAX_AUTO_SCALE", "400"))
BASE_LOT = float(os.getenv("BOT_BASE_LOT", "0.01"))
BASE_MAX_TOTAL_LOT = float(os.getenv("BOT_BASE_MAX_TOTAL_LOT", "0.07"))
BASE_MAX_FLOATING_LOSS = float(os.getenv("BOT_BASE_MAX_FLOATING_LOSS", "350"))
MAX_ORDERS = int(os.getenv("BOT_MAX_ORDERS", "8"))
GRID_STEP_USD = float(os.getenv("BOT_GRID_STEP_USD", "2.25"))
SPREAD_ATR_LIMIT = float(os.getenv("BOT_SPREAD_ATR_LIMIT", "0.12"))
NEWS_BLOCK_BEFORE_MINUTES = int(os.getenv("BOT_NEWS_BLOCK_BEFORE_MINUTES", "30"))
NEWS_BLOCK_AFTER_MINUTES = int(os.getenv("BOT_NEWS_BLOCK_AFTER_MINUTES", "60"))
ROLLOVER_BLOCK_MINUTES = int(os.getenv("BOT_ROLLOVER_BLOCK_MINUTES", "5"))

SELF_UPDATE_URL = (
    "https://raw.githubusercontent.com/Pauarte/"
    "DASHBOARDXAUUSD2-5K/main/sync/sync_mt5_to_supabase.py"
)
SELF_UPDATE_EVERY_N_PASSES = 3
SELF_PATH = os.path.abspath(__file__)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
advanced_telemetry_available: bool | None = None
first_history_pass = True


def utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def log(message: str) -> None:
    print(f"[{utc_now().isoformat(timespec='seconds')}] {message}", flush=True)


def finite(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def nullable_number(value: Any) -> float | None:
    number = finite(value, float("nan"))
    return number if math.isfinite(number) else None


def minute_bucket(value: datetime.datetime) -> str:
    return value.astimezone(datetime.timezone.utc).replace(second=0, microsecond=0).isoformat()


def probe_bucket(value: datetime.datetime) -> str:
    epoch = int(value.timestamp())
    rounded = epoch - (epoch % RISK_PROBE_SECONDS)
    return datetime.datetime.fromtimestamp(
        rounded, tz=datetime.timezone.utc
    ).isoformat()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(encoded)


def chunks(rows: list[dict[str, Any]], size: int = 500) -> Iterable[list[dict[str, Any]]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


def contains_order_send_call(source: bytes | str) -> bool:
    text = source.decode("utf-8") if isinstance(source, bytes) else source
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        if isinstance(function, ast.Attribute) and function.attr == "order_send":
            return True
        if isinstance(function, ast.Name) and function.id == "order_send":
            return True
    return False


def server_utc_offset_seconds() -> float:
    tick = mt5.symbol_info_tick(SYMBOL_FILTER)
    if tick is None or not tick.time:
        return 0.0
    raw_offset = tick.time - time.time()
    return round(raw_offset / 3600) * 3600


def to_utc_datetime(epoch_seconds: float, offset_seconds: float) -> datetime.datetime:
    return datetime.datetime.fromtimestamp(epoch_seconds - offset_seconds, tz=datetime.timezone.utc)


def to_utc_iso(epoch_seconds: float, offset_seconds: float) -> str:
    return to_utc_datetime(epoch_seconds, offset_seconds).isoformat()


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
    if not mt5.symbol_select(SYMBOL_FILTER, True):
        raise RuntimeError(f"symbol_select failed: {mt5.last_error()}")
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


def telemetry_schema_exists() -> bool:
    global advanced_telemetry_available
    if advanced_telemetry_available is not None:
        return advanced_telemetry_available
    try:
        supabase.table("telemetry_summary").select("account").limit(1).execute()
        advanced_telemetry_available = True
    except Exception as exc:
        advanced_telemetry_available = False
        log(f"Advanced telemetry disabled until migration is applied: {exc!r}")
    return advanced_telemetry_available


def config_payload() -> dict[str, Any]:
    return {
        "bot_id": BOT_ID,
        "version": BOT_VERSION,
        "magic": MAGIC_FILTER,
        "symbol": SYMBOL_FILTER,
        "reference_equity": REFERENCE_EQUITY,
        "reserve_pct": RESERVE_PCT,
        "max_auto_scale": MAX_AUTO_SCALE,
        "base_lot": BASE_LOT,
        "base_max_total_lot": BASE_MAX_TOTAL_LOT,
        "base_max_floating_loss": BASE_MAX_FLOATING_LOSS,
        "max_orders": MAX_ORDERS,
        "grid_step_usd": GRID_STEP_USD,
        "spread_atr_limit": SPREAD_ATR_LIMIT,
        "news_block_before_minutes": NEWS_BLOCK_BEFORE_MINUTES,
        "news_block_after_minutes": NEWS_BLOCK_AFTER_MINUTES,
        "rollover_block_minutes": ROLLOVER_BLOCK_MINUTES,
        "poll_seconds": POLL_SECONDS,
        "telemetry_schema": 1,
    }


def source_sha256() -> str:
    if BOT_SOURCE_PATH and BOT_SOURCE_PATH.is_file():
        return sha256_bytes(BOT_SOURCE_PATH.read_bytes())
    return ""


def register_bot_version(now_iso: str) -> str:
    payload = config_payload()
    config_hash = sha256_json(payload)
    source_hash = source_sha256()
    version_key = sha256_json(
        {"bot_id": BOT_ID, "config": config_hash, "source": source_hash}
    )[:24]
    row = {
        "account": str(ACCOUNT_LOGIN),
        "bot_id": BOT_ID,
        "magic": MAGIC_FILTER,
        "version_label": BOT_VERSION,
        "source_sha256": source_hash,
        "config_sha256": config_hash,
        "git_commit": BOT_GIT_COMMIT,
        "source_path_hint": BOT_SOURCE_PATH.name if BOT_SOURCE_PATH else None,
        "config_json": payload,
        "last_seen_at": now_iso,
    }
    supabase.table("bot_versions").upsert(
        row,
        on_conflict="account,bot_id,source_sha256,config_sha256",
    ).execute()
    return version_key


def history_bounds(offset: float, full: bool) -> tuple[datetime.datetime, datetime.datetime]:
    to_date = datetime.datetime.fromtimestamp(time.time() + offset, tz=datetime.timezone.utc)
    if full:
        return datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc), to_date
    return to_date - datetime.timedelta(days=INCREMENTAL_LOOKBACK_DAYS), to_date


def bot_deals(full: bool) -> tuple[list[Any], set[int], float]:
    offset = server_utc_offset_seconds()
    from_date, to_date = history_bounds(offset, full)
    history = mt5.history_deals_get(from_date, to_date)
    if history is None:
        raise RuntimeError(f"history_deals_get failed: {mt5.last_error()}")
    deals = list(history)
    symbol_deals = [deal for deal in deals if deal.symbol == SYMBOL_FILTER]
    bot_positions = {
        int(deal.position_id)
        for deal in symbol_deals
        if deal.entry == mt5.DEAL_ENTRY_IN and int(getattr(deal, "magic", 0)) == MAGIC_FILTER
    }
    return [deal for deal in symbol_deals if int(deal.position_id) in bot_positions], bot_positions, offset


def deal_exit_label(reason_code: int) -> str:
    if reason_code == getattr(mt5, "DEAL_REASON_TP", -9999):
        return "TP"
    manual_reasons = {
        getattr(mt5, "DEAL_REASON_CLIENT", -9991),
        getattr(mt5, "DEAL_REASON_MOBILE", -9992),
        getattr(mt5, "DEAL_REASON_WEB", -9993),
    }
    if reason_code in manual_reasons:
        return "MANUAL"
    return "BOT"


def assign_baskets(position_rows: list[dict[str, Any]]) -> None:
    ordered = sorted(position_rows, key=lambda row: (row["_open_epoch"], row["position_id"]))
    current_end = -1.0
    current_key = ""
    for row in ordered:
        if not current_key or row["_open_epoch"] > current_end + 5:
            current_key = f"B{row['position_id']}"
            current_end = row["_close_epoch"]
        else:
            current_end = max(current_end, row["_close_epoch"])
        row["basket_id"] = current_key


def requested_execution(
    deals: list[Any],
    orders_by_ticket: dict[int, Any],
    direction: str,
    entry: bool,
    point: float,
) -> tuple[float | None, float | None]:
    executions: list[tuple[float, float, float]] = []
    for deal in deals:
        order = orders_by_ticket.get(int(getattr(deal, "order", 0) or 0))
        requested = finite(getattr(order, "price_open", 0.0)) if order else 0.0
        volume = finite(getattr(deal, "volume", 0.0))
        if requested <= 0 or volume <= 0:
            continue
        executed = finite(getattr(deal, "price", 0.0))
        if entry:
            adverse_price = executed - requested if direction == "BUY" else requested - executed
        else:
            adverse_price = requested - executed if direction == "BUY" else executed - requested
        executions.append((requested, adverse_price, volume))

    total_volume = sum(volume for _, _, volume in executions)
    if total_volume <= 0:
        return None, None
    requested_price = sum(requested * volume for requested, _, volume in executions) / total_volume
    adverse_price = sum(slippage * volume for _, slippage, volume in executions) / total_volume
    return requested_price, adverse_price / point if point > 0 else None


def build_closed_trade_rows(
    deals: list[Any],
    orders_by_ticket: dict[int, Any],
    offset: float,
    version_key: str,
    point: float,
) -> list[dict[str, Any]]:
    by_position: dict[int, list[Any]] = defaultdict(list)
    for deal in deals:
        by_position[int(deal.position_id)].append(deal)

    prepared: list[dict[str, Any]] = []
    for position_id, position_deals in by_position.items():
        entries = [deal for deal in position_deals if deal.entry == mt5.DEAL_ENTRY_IN]
        exits = [
            deal
            for deal in position_deals
            if deal.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)
        ]
        if not entries or not exits:
            continue
        entry_volume = sum(finite(deal.volume) for deal in entries)
        exit_volume = sum(finite(deal.volume) for deal in exits)
        if entry_volume <= 0 or exit_volume <= 0:
            continue

        open_epoch = min(deal.time for deal in entries)
        close_epoch = max(deal.time for deal in exits)
        last_exit = max(exits, key=lambda deal: (deal.time, deal.ticket))
        gross_profit = sum(finite(deal.profit) for deal in position_deals)
        commission = sum(finite(deal.commission) for deal in position_deals)
        swap = sum(finite(deal.swap) for deal in position_deals)
        fee = sum(finite(getattr(deal, "fee", 0.0)) for deal in position_deals)
        first_entry = min(entries, key=lambda deal: (deal.time, deal.ticket))
        direction = "BUY" if first_entry.type == mt5.DEAL_TYPE_BUY else "SELL"
        entry_requested, entry_slippage = requested_execution(
            entries, orders_by_ticket, direction, True, point
        )
        exit_requested, exit_slippage = requested_execution(
            exits, orders_by_ticket, direction, False, point
        )

        prepared.append(
            {
                "account": str(ACCOUNT_LOGIN),
                "symbol": SYMBOL_FILTER,
                "direction": direction,
                "lots": exit_volume,
                "entry_price": sum(deal.price * deal.volume for deal in entries) / entry_volume,
                "exit_price": sum(deal.price * deal.volume for deal in exits) / exit_volume,
                "open_time": to_utc_iso(open_epoch, offset),
                "close_time": to_utc_iso(close_epoch, offset),
                "pnl": gross_profit + commission + swap + fee,
                "exit_reason": deal_exit_label(int(getattr(last_exit, "reason", 0))),
                "mt5_deal_id": int(last_exit.ticket),
                "position_id": position_id,
                "entry_deal_id": int(first_entry.ticket),
                "gross_profit": gross_profit,
                "commission": commission,
                "swap": swap,
                "fee": fee,
                "entry_requested_price": entry_requested,
                "exit_requested_price": exit_requested,
                "entry_slippage_points": entry_slippage,
                "exit_slippage_points": exit_slippage,
                "entry_reason_code": int(getattr(first_entry, "reason", 0)),
                "exit_reason_code": int(getattr(last_exit, "reason", 0)),
                "magic": MAGIC_FILTER,
                "comment": str(getattr(first_entry, "comment", "") or ""),
                "bot_version_key": version_key,
                "_open_epoch": open_epoch,
                "_close_epoch": close_epoch,
            }
        )

    assign_baskets(prepared)
    for row in prepared:
        row.pop("_open_epoch", None)
        row.pop("_close_epoch", None)
    return prepared


def sync_closed_trades(version_key: str, full: bool) -> tuple[int, int, int]:
    deals, bot_position_ids, offset = bot_deals(full)
    advanced = telemetry_schema_exists()
    from_date, to_date = history_bounds(offset, full)
    history_orders = mt5.history_orders_get(from_date, to_date)
    if history_orders is None:
        raise RuntimeError(f"history_orders_get failed: {mt5.last_error()}")
    orders = [
        order
        for order in history_orders
        if int(getattr(order, "magic", 0)) == MAGIC_FILTER
        or int(getattr(order, "position_id", 0)) in bot_position_ids
    ]
    orders_by_ticket = {int(order.ticket): order for order in orders}
    info = mt5.symbol_info(SYMBOL_FILTER)
    point = finite(getattr(info, "point", 0.01), 0.01) if info else 0.01
    rows = build_closed_trade_rows(
        deals, orders_by_ticket, offset, version_key, point
    )
    if rows:
        rows_to_store = rows
        if not advanced:
            basic_columns = {
                "account",
                "symbol",
                "direction",
                "lots",
                "entry_price",
                "exit_price",
                "open_time",
                "close_time",
                "pnl",
                "exit_reason",
                "mt5_deal_id",
            }
            rows_to_store = [
                {key: value for key, value in row.items() if key in basic_columns}
                for row in rows
            ]
        supabase.table("trades").upsert(
            rows_to_store, on_conflict="account,mt5_deal_id"
        ).execute()

    raw_deal_count = 0
    raw_order_count = 0
    if advanced:
        raw_rows = [
            {
                "account": str(ACCOUNT_LOGIN),
                "deal_ticket": int(deal.ticket),
                "order_ticket": int(getattr(deal, "order", 0) or 0),
                "position_id": int(deal.position_id),
                "deal_time": to_utc_iso(deal.time, offset),
                "symbol": str(deal.symbol or ""),
                "deal_type": int(deal.type),
                "entry_type": int(deal.entry),
                "reason_code": int(getattr(deal, "reason", 0)),
                "magic": int(getattr(deal, "magic", 0)),
                "volume": finite(deal.volume),
                "price": finite(deal.price),
                "commission": finite(deal.commission),
                "swap": finite(deal.swap),
                "profit": finite(deal.profit),
                "fee": finite(getattr(deal, "fee", 0.0)),
                "comment": str(getattr(deal, "comment", "") or ""),
                "external_id": str(getattr(deal, "external_id", "") or ""),
                "bot_version_key": version_key,
            }
            for deal in deals
        ]
        for batch in chunks(raw_rows):
            supabase.table("raw_deals").upsert(
                batch, on_conflict="account,deal_ticket"
            ).execute()
        raw_deal_count = len(raw_rows)

        order_rows = [
            {
                "account": str(ACCOUNT_LOGIN),
                "order_ticket": int(order.ticket),
                "position_id": int(getattr(order, "position_id", 0) or 0),
                "setup_time": to_utc_iso(order.time_setup, offset)
                if getattr(order, "time_setup", 0)
                else None,
                "done_time": to_utc_iso(order.time_done, offset)
                if getattr(order, "time_done", 0)
                else None,
                "order_type": int(order.type),
                "state_code": int(order.state),
                "reason_code": int(getattr(order, "reason", 0)),
                "magic": int(getattr(order, "magic", 0)),
                "volume_initial": finite(order.volume_initial),
                "volume_current": finite(order.volume_current),
                "requested_price": finite(order.price_open),
                "current_price": finite(order.price_current),
                "stop_limit_price": finite(getattr(order, "price_stoplimit", 0.0)),
                "sl": finite(order.sl),
                "tp": finite(order.tp),
                "comment": str(getattr(order, "comment", "") or ""),
                "external_id": str(getattr(order, "external_id", "") or ""),
                "bot_version_key": version_key,
            }
            for order in orders
        ]
        for batch in chunks(order_rows):
            supabase.table("raw_orders").upsert(
                batch, on_conflict="account,order_ticket"
            ).execute()
        raw_order_count = len(order_rows)

    return len(rows), raw_deal_count, raw_order_count


def current_positions() -> list[Any]:
    result = mt5.positions_get(symbol=SYMBOL_FILTER)
    if result is None:
        raise RuntimeError(f"positions_get failed: {mt5.last_error()}")
    positions = list(result)
    return [position for position in positions if int(position.magic) == MAGIC_FILTER]


def sync_open_positions(positions: list[Any], updated_at: str, offset: float) -> int:
    live_tickets = [int(position.ticket) for position in positions]
    rows = [
        {
            "account": str(ACCOUNT_LOGIN),
            "symbol": SYMBOL_FILTER,
            "direction": "BUY" if position.type == mt5.ORDER_TYPE_BUY else "SELL",
            "lots": finite(position.volume),
            "entry_price": finite(position.price_open),
            "current_price": finite(position.price_current),
            "open_time": to_utc_iso(position.time, offset),
            "floating_pnl": finite(position.profit) + finite(position.swap),
            "mt5_ticket": int(position.ticket),
            "updated_at": updated_at,
        }
        for position in positions
    ]
    query = supabase.table("open_positions").delete().eq("account", str(ACCOUNT_LOGIN))
    if live_tickets:
        query = query.not_.in_("mt5_ticket", live_tickets)
    query.execute()
    if rows:
        supabase.table("open_positions").upsert(
            rows, on_conflict="account,mt5_ticket"
        ).execute()
    return len(rows)


def sync_account_snapshot(account, updated_at: str) -> None:
    supabase.table("account_snapshots").upsert(
        {
            "account": str(ACCOUNT_LOGIN),
            "balance": finite(account.balance),
            "equity": finite(account.equity),
            "currency": str(account.currency),
            "updated_at": updated_at,
        },
        on_conflict="account",
    ).execute()


def record_floating_snapshot(account, positions: list[Any]) -> float:
    floating_pnl = sum(finite(position.profit) + finite(position.swap) for position in positions)
    supabase.table("floating_pnl_snapshots").insert(
        {
            "account": str(ACCOUNT_LOGIN),
            "floating_pnl": floating_pnl,
            "equity": finite(account.equity),
            "balance": finite(account.balance),
        }
    ).execute()
    return floating_pnl


def rates(timeframe: int, count: int = 150) -> list[Any]:
    values = mt5.copy_rates_from_pos(SYMBOL_FILTER, timeframe, 0, count)
    return list(values) if values is not None else []


def true_ranges(bars: list[Any]) -> list[float]:
    values: list[float] = []
    for index, bar in enumerate(bars):
        high = finite(bar["high"])
        low = finite(bar["low"])
        previous_close = finite(bars[index - 1]["close"]) if index else finite(bar["open"])
        values.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    return values


def atr(bars: list[Any], period: int = 14) -> float | None:
    values = true_ranges(bars)
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def rsi(bars: list[Any], period: int = 7) -> float | None:
    closes = [finite(bar["close"]) for bar in bars]
    if len(closes) <= period:
        return None
    changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
    recent = changes[-period:]
    gains = sum(max(change, 0.0) for change in recent) / period
    losses = sum(max(-change, 0.0) for change in recent) / period
    if losses == 0:
        return 100.0 if gains > 0 else 50.0
    relative_strength = gains / losses
    return 100 - (100 / (1 + relative_strength))


def adx(bars: list[Any], period: int = 14) -> float | None:
    if len(bars) < period * 2 + 1:
        return None
    trs = true_ranges(bars)
    plus_dm: list[float] = [0.0]
    minus_dm: list[float] = [0.0]
    for index in range(1, len(bars)):
        up = finite(bars[index]["high"]) - finite(bars[index - 1]["high"])
        down = finite(bars[index - 1]["low"]) - finite(bars[index]["low"])
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    dx_values: list[float] = []
    for end in range(period, len(bars) + 1):
        tr_sum = sum(trs[end - period : end])
        if tr_sum <= 0:
            continue
        plus_di = 100 * sum(plus_dm[end - period : end]) / tr_sum
        minus_di = 100 * sum(minus_dm[end - period : end]) / tr_sum
        denominator = plus_di + minus_di
        if denominator > 0:
            dx_values.append(100 * abs(plus_di - minus_di) / denominator)
    return sum(dx_values[-period:]) / period if len(dx_values) >= period else None


def recent_move(bars: list[Any], count: int) -> float | None:
    if not bars:
        return None
    subset = bars[-min(count, len(bars)) :]
    return max(finite(bar["high"]) for bar in subset) - min(
        finite(bar["low"]) for bar in subset
    )


def market_metrics(offset: float) -> dict[str, Any]:
    info = mt5.symbol_info(SYMBOL_FILTER)
    tick = mt5.symbol_info_tick(SYMBOL_FILTER)
    m1 = rates(mt5.TIMEFRAME_M1)
    m5 = rates(mt5.TIMEFRAME_M5)
    point = finite(getattr(info, "point", 0.01), 0.01) if info else 0.01
    bid = finite(getattr(tick, "bid", 0.0)) if tick else 0.0
    ask = finite(getattr(tick, "ask", 0.0)) if tick else 0.0
    spread_price = max(0.0, ask - bid)
    atr_m1 = atr(m1)
    atr_m5 = atr(m5)
    latest = m1[-1] if m1 else None
    tick_true_epoch = finite(getattr(tick, "time", 0.0)) - offset if tick else 0.0
    tick_age = max(0.0, time.time() - tick_true_epoch) if tick_true_epoch > 0 else None
    return {
        "bid": bid or None,
        "ask": ask or None,
        "spread_price": spread_price,
        "spread_points": spread_price / point if point > 0 else None,
        "tick_age_seconds": tick_age,
        "atr_m1": atr_m1,
        "atr_m5": atr_m5,
        "spread_atr_ratio": spread_price / atr_m1 if atr_m1 and atr_m1 > 0 else None,
        "rsi_m1": rsi(m1),
        "adx_m1": adx(m1),
        "recent_move_5m": recent_move(m1, 5),
        "recent_move_15m": recent_move(m1, 15),
        "recent_move_60m": recent_move(m1, 60),
        "latest_bar_range": finite(latest["high"]) - finite(latest["low"]) if latest is not None else None,
        "latest_bar_body": abs(finite(latest["close"]) - finite(latest["open"])) if latest is not None else None,
        "tick_volume": int(latest["tick_volume"]) if latest is not None else None,
        "real_volume": int(latest["real_volume"]) if latest is not None else None,
        "bar_open": finite(latest["open"]) if latest is not None else None,
        "bar_high": finite(latest["high"]) if latest is not None else None,
        "bar_low": finite(latest["low"]) if latest is not None else None,
        "bar_close": finite(latest["close"]) if latest is not None else None,
        "broker_bar_time": to_utc_iso(latest["time"], offset) if latest is not None else None,
        "point": point,
    }


def normalize_volume(value: float, info: Any) -> float:
    minimum = finite(getattr(info, "volume_min", 0.01), 0.01)
    maximum = finite(getattr(info, "volume_max", 100.0), 100.0)
    step = finite(getattr(info, "volume_step", 0.01), 0.01)
    bounded = max(minimum, min(maximum, value))
    normalized = int(bounded / step) * step
    return round(max(minimum, min(maximum, normalized)), 2)


def effective_limits(balance: float) -> dict[str, float]:
    info = mt5.symbol_info(SYMBOL_FILTER)
    lot_scale = max(1.0, min(balance / REFERENCE_EQUITY, MAX_AUTO_SCALE))
    money_scale = max(
        0.01,
        min(balance * max(0.0, 1.0 - RESERVE_PCT / 100.0) / REFERENCE_EQUITY, MAX_AUTO_SCALE),
    )
    base_lot = normalize_volume(BASE_LOT * lot_scale, info)
    max_lot = max(base_lot, normalize_volume(BASE_MAX_TOTAL_LOT * money_scale, info))
    return {
        "base_lot": base_lot,
        "max_total_lot": max_lot,
        "max_floating_loss": BASE_MAX_FLOATING_LOSS * money_scale,
    }


def madrid_day_bounds(now: datetime.datetime) -> tuple[str, str]:
    local_now = now.astimezone(MADRID_TZ)
    local_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        local_start.astimezone(datetime.timezone.utc).isoformat(),
        (local_start + datetime.timedelta(days=1)).astimezone(datetime.timezone.utc).isoformat(),
    )


def closed_pnl_today(now: datetime.datetime) -> float:
    start, end = madrid_day_bounds(now)
    response = (
        supabase.table("trades")
        .select("pnl")
        .eq("account", str(ACCOUNT_LOGIN))
        .gte("close_time", start)
        .lt("close_time", end)
        .execute()
    )
    return sum(finite(row["pnl"]) for row in (response.data or []))


def historical_risk_baselines(now: datetime.datetime, balance: float, equity: float, day_pnl: float) -> dict[str, float]:
    peak_response = (
        supabase.table("account_telemetry")
        .select("equity")
        .eq("account", str(ACCOUNT_LOGIN))
        .order("equity", desc=True)
        .limit(1)
        .execute()
    )
    historical_peak = finite(peak_response.data[0]["equity"]) if peak_response.data else equity
    equity_peak = max(equity, historical_peak)
    day_start, _ = madrid_day_bounds(now)
    day_response = (
        supabase.table("account_telemetry")
        .select("balance,equity")
        .eq("account", str(ACCOUNT_LOGIN))
        .gte("recorded_at", day_start)
        .order("recorded_at")
        .limit(1)
        .execute()
    )
    day_peak_response = (
        supabase.table("account_telemetry")
        .select("equity")
        .eq("account", str(ACCOUNT_LOGIN))
        .gte("recorded_at", day_start)
        .order("equity", desc=True)
        .limit(1)
        .execute()
    )
    day_start_balance = (
        finite(day_response.data[0]["balance"])
        if day_response.data
        else balance - day_pnl
    )
    day_peak_equity = max(
        equity,
        finite(day_peak_response.data[0]["equity"])
        if day_peak_response.data
        else equity,
        day_start_balance,
    )
    return {
        "equity_peak": equity_peak,
        "day_start_balance": day_start_balance,
        "day_peak_equity": day_peak_equity,
    }


def infer_news_file() -> Path | None:
    if BOT_NEWS_FILE and BOT_NEWS_FILE.is_file():
        return BOT_NEWS_FILE
    if BOT_SOURCE_PATH:
        candidate = BOT_SOURCE_PATH.parent / "noticias_xau.csv"
        if candidate.is_file():
            return candidate
    return None


def parse_local_news_time(value: str) -> datetime.datetime | None:
    try:
        parsed = datetime.datetime.fromisoformat(value.strip())
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=MADRID_TZ)
        return parsed.astimezone(datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def sync_news_events(now: datetime.datetime) -> tuple[bool, str | None]:
    news_file = infer_news_file()
    if not news_file:
        return False, None
    rows: list[dict[str, Any]] = []
    active_reason: str | None = None
    with news_file.open("r", encoding="utf-8-sig", newline="") as handle:
        for item in csv.DictReader(handle):
            event_time = parse_local_news_time(str(item.get("time", "")))
            if event_time is None:
                continue
            currency = str(item.get("currency", "")).strip().upper()
            impact = str(item.get("impact", "")).strip().upper()
            event_name = str(item.get("event", "")).strip()
            fingerprint = sha256_json(
                {
                    "time": event_time.isoformat(),
                    "currency": currency,
                    "impact": impact,
                    "event": event_name,
                }
            )
            rows.append(
                {
                    "account": str(ACCOUNT_LOGIN),
                    "event_time": event_time.isoformat(),
                    "currency": currency,
                    "impact": impact,
                    "event_name": event_name,
                    "source_hash": fingerprint,
                }
            )
            block_start = event_time - datetime.timedelta(minutes=NEWS_BLOCK_BEFORE_MINUTES)
            block_end = event_time + datetime.timedelta(minutes=NEWS_BLOCK_AFTER_MINUTES)
            if currency == "USD" and impact == "HIGH" and block_start <= now <= block_end:
                active_reason = f"{event_name} ({event_time.isoformat()})"
    if rows:
        supabase.table("economic_events").upsert(
            rows, on_conflict="account,source_hash"
        ).execute()
    return active_reason is not None, active_reason


def rollover_block_active(offset: float) -> bool:
    server_now = datetime.datetime.fromtimestamp(time.time() + offset, tz=datetime.timezone.utc)
    minute = server_now.hour * 60 + server_now.minute
    return minute < ROLLOVER_BLOCK_MINUTES or minute >= 1440 - ROLLOVER_BLOCK_MINUTES


def runtime_event_time(row: dict[str, Any]) -> str | None:
    for key in ("time", "close_time", "open_time", "timestamp", "date"):
        if row.get(key):
            parsed = parse_local_news_time(str(row[key]))
            if parsed:
                return parsed.isoformat()
    return None


def sync_runtime_events(version_key: str) -> int:
    if not BOT_RUNTIME_DIR or not BOT_RUNTIME_DIR.is_dir():
        return 0
    rows: list[dict[str, Any]] = []
    for path in sorted(BOT_RUNTIME_DIR.iterdir()):
        if not path.is_file() or path.stat().st_size > 25 * 1024 * 1024:
            continue
        name = path.name.lower()
        if name.endswith(".csv") and ("order" in name or "basket" in name):
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for item in csv.DictReader(handle):
                    payload = {str(key): value for key, value in item.items()}
                    rows.append(
                        {
                            "account": str(ACCOUNT_LOGIN),
                            "source_file": path.name,
                            "row_hash": sha256_json(payload),
                            "event_time": runtime_event_time(payload),
                            "payload": payload,
                            "bot_version_key": version_key,
                        }
                    )
        elif name.endswith(".json") and "state" in name:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
            rows.append(
                {
                    "account": str(ACCOUNT_LOGIN),
                    "source_file": path.name,
                    "row_hash": sha256_json(payload),
                    "event_time": utc_now().isoformat(),
                    "payload": payload,
                    "bot_version_key": version_key,
                }
            )
    for batch in chunks(rows):
        supabase.table("bot_runtime_events").upsert(
            batch, on_conflict="account,source_file,row_hash"
        ).execute()
    return len(rows)


def sync_advanced_telemetry(
    account: Any,
    positions: list[Any],
    market: dict[str, Any],
    now: datetime.datetime,
    offset: float,
    version_key: str,
    sync_duration_ms: int,
) -> dict[str, Any]:
    balance = finite(account.balance)
    equity = finite(account.equity)
    floating = sum(finite(position.profit) + finite(position.swap) for position in positions)
    total_lots = sum(finite(position.volume) for position in positions)
    limits = effective_limits(balance)
    day_pnl = closed_pnl_today(now)
    baselines = historical_risk_baselines(now, balance, equity, day_pnl)
    drawdown_amount = min(0.0, equity - baselines["equity_peak"])
    intraday_drawdown = min(0.0, equity - baselines["day_peak_equity"])
    news_active, news_reason = sync_news_events(now)
    rollover_active = rollover_block_active(offset)
    bucket = minute_bucket(now)
    terminal = mt5.terminal_info()
    floating_used = (
        max(0.0, -floating) / limits["max_floating_loss"] * 100
        if limits["max_floating_loss"] > 0
        else 0.0
    )
    lot_used = total_lots / limits["max_total_lot"] * 100 if limits["max_total_lot"] > 0 else 0.0
    summary_date = now.astimezone(MADRID_TZ).date().isoformat()

    account_row = {
        "account": str(ACCOUNT_LOGIN),
        "minute_bucket": bucket,
        "recorded_at": now.isoformat(),
        "bot_version_key": version_key,
        "balance": balance,
        "equity": equity,
        "profit": finite(account.profit),
        "margin": finite(account.margin),
        "margin_free": finite(account.margin_free),
        "margin_level": finite(account.margin_level),
        "currency": str(account.currency),
        "leverage": int(getattr(account, "leverage", 0) or 0),
        "trade_mode": int(getattr(account, "trade_mode", 0) or 0),
        "position_count": len(positions),
        "total_lots": total_lots,
        "floating_pnl": floating,
        "equity_peak": baselines["equity_peak"],
        "drawdown_amount": drawdown_amount,
        "drawdown_pct": drawdown_amount / baselines["equity_peak"] * 100
        if baselines["equity_peak"] > 0
        else 0.0,
        "day_start_balance": baselines["day_start_balance"],
        "day_closed_pnl": day_pnl,
        "intraday_drawdown_amount": intraday_drawdown,
        "intraday_drawdown_pct": intraday_drawdown / baselines["day_peak_equity"] * 100
        if baselines["day_peak_equity"] > 0
        else 0.0,
        "effective_base_lot": limits["base_lot"],
        "effective_max_total_lot": limits["max_total_lot"],
        "effective_max_floating_loss": limits["max_floating_loss"],
        "floating_limit_used_pct": floating_used,
        "lot_limit_used_pct": lot_used,
        "bid": market["bid"],
        "ask": market["ask"],
        "spread_price": market["spread_price"],
        "spread_points": market["spread_points"],
        "tick_age_seconds": market["tick_age_seconds"],
        "atr_m1": market["atr_m1"],
        "atr_m5": market["atr_m5"],
        "spread_atr_ratio": market["spread_atr_ratio"],
        "rsi_m1": market["rsi_m1"],
        "adx_m1": market["adx_m1"],
        "recent_move_5m": market["recent_move_5m"],
        "recent_move_15m": market["recent_move_15m"],
        "recent_move_60m": market["recent_move_60m"],
        "latest_bar_range": market["latest_bar_range"],
        "latest_bar_body": market["latest_bar_body"],
        "tick_volume": market["tick_volume"],
        "news_block_active": news_active,
        "news_block_reason": news_reason,
        "rollover_block_active": rollover_active,
        "server": str(account.server),
        "company": str(account.company),
        "terminal_build": int(getattr(terminal, "build", 0) or 0) if terminal else None,
    }
    supabase.table("account_telemetry").upsert(
        account_row, on_conflict="account,minute_bucket"
    ).execute()

    market_row = {
        "account": str(ACCOUNT_LOGIN),
        "symbol": SYMBOL_FILTER,
        "minute_bucket": bucket,
        "recorded_at": now.isoformat(),
        "broker_bar_time": market["broker_bar_time"],
        "open": market["bar_open"],
        "high": market["bar_high"],
        "low": market["bar_low"],
        "close": market["bar_close"],
        "tick_volume": market["tick_volume"],
        "real_volume": market["real_volume"],
        "bid": market["bid"],
        "ask": market["ask"],
        "spread_price": market["spread_price"],
        "spread_points": market["spread_points"],
        "atr_m1": market["atr_m1"],
        "atr_m5": market["atr_m5"],
        "spread_atr_ratio": market["spread_atr_ratio"],
        "rsi_m1": market["rsi_m1"],
        "adx_m1": market["adx_m1"],
        "recent_move_5m": market["recent_move_5m"],
        "recent_move_15m": market["recent_move_15m"],
        "recent_move_60m": market["recent_move_60m"],
    }
    supabase.table("market_telemetry").upsert(
        market_row, on_conflict="account,symbol,minute_bucket"
    ).execute()

    position_rows: list[dict[str, Any]] = []
    current_basket_id = (
        f"B{min(int(getattr(position, 'identifier', position.ticket) or position.ticket) for position in positions)}"
        if positions
        else None
    )
    for position in positions:
        direction = "BUY" if position.type == mt5.ORDER_TYPE_BUY else "SELL"
        entry_price = finite(position.price_open)
        current_price = finite(position.price_current)
        signed_move = current_price - entry_price if direction == "BUY" else entry_price - current_price
        distance = abs(current_price - entry_price)
        position_rows.append(
            {
                "account": str(ACCOUNT_LOGIN),
                "mt5_ticket": int(position.ticket),
                "position_id": int(getattr(position, "identifier", position.ticket) or position.ticket),
                "basket_id": current_basket_id,
                "minute_bucket": bucket,
                "recorded_at": now.isoformat(),
                "bot_version_key": version_key,
                "direction": direction,
                "lots": finite(position.volume),
                "entry_price": entry_price,
                "current_price": current_price,
                "open_time": to_utc_iso(position.time, offset),
                "age_seconds": max(
                    0,
                    int((now - to_utc_datetime(position.time, offset)).total_seconds()),
                ),
                "profit": finite(position.profit),
                "swap": finite(position.swap),
                "floating_pnl": finite(position.profit) + finite(position.swap),
                "sl": nullable_number(position.sl),
                "tp": nullable_number(position.tp),
                "distance_price": distance,
                "distance_points": distance / market["point"] if market["point"] > 0 else 0.0,
                "favorable_move_price": max(0.0, signed_move),
                "adverse_move_price": max(0.0, -signed_move),
                "magic": int(position.magic),
                "comment": str(getattr(position, "comment", "") or ""),
                "reason_code": int(getattr(position, "reason", 0) or 0),
                "spread_points": market["spread_points"],
            }
        )
    if position_rows:
        supabase.table("position_telemetry").upsert(
            position_rows, on_conflict="account,mt5_ticket,minute_bucket"
        ).execute()

    previous_summary_response = (
        supabase.table("telemetry_summary")
        .select(
            "summary_date,day_worst_floating,day_max_floating_limit_used_pct,"
            "day_max_spread_points,day_max_spread_atr_ratio,day_min_margin_level,"
            "day_worst_intraday_drawdown_pct"
        )
        .eq("account", str(ACCOUNT_LOGIN))
        .maybe_single()
        .execute()
    )
    previous = previous_summary_response.data or {}
    same_day = previous.get("summary_date") == summary_date

    def previous_number(name: str, fallback: float) -> float:
        return finite(previous.get(name), fallback) if same_day else fallback

    current_spread = nullable_number(market["spread_points"])
    current_spread_atr = nullable_number(market["spread_atr_ratio"])
    current_margin_level = finite(account.margin_level)

    summary = {
        "account": str(ACCOUNT_LOGIN),
        "bot_id": BOT_ID,
        "updated_at": now.isoformat(),
        "summary_date": summary_date,
        "bot_version_key": version_key,
        "balance": balance,
        "equity": equity,
        "floating_pnl": floating,
        "margin_free": finite(account.margin_free),
        "margin_level": finite(account.margin_level),
        "position_count": len(positions),
        "total_lots": total_lots,
        "drawdown_amount": drawdown_amount,
        "drawdown_pct": account_row["drawdown_pct"],
        "intraday_drawdown_amount": intraday_drawdown,
        "intraday_drawdown_pct": account_row["intraday_drawdown_pct"],
        "effective_base_lot": limits["base_lot"],
        "effective_max_total_lot": limits["max_total_lot"],
        "effective_max_floating_loss": limits["max_floating_loss"],
        "floating_limit_used_pct": floating_used,
        "lot_limit_used_pct": lot_used,
        "bid": market["bid"],
        "ask": market["ask"],
        "spread_points": market["spread_points"],
        "atr_m1": market["atr_m1"],
        "atr_m5": market["atr_m5"],
        "spread_atr_ratio": market["spread_atr_ratio"],
        "rsi_m1": market["rsi_m1"],
        "adx_m1": market["adx_m1"],
        "recent_move_5m": market["recent_move_5m"],
        "recent_move_15m": market["recent_move_15m"],
        "recent_move_60m": market["recent_move_60m"],
        "news_block_active": news_active,
        "news_block_reason": news_reason,
        "rollover_block_active": rollover_active,
        "day_worst_floating": min(
            floating, previous_number("day_worst_floating", floating)
        ),
        "day_max_floating_limit_used_pct": max(
            floating_used,
            previous_number("day_max_floating_limit_used_pct", floating_used),
        ),
        "day_max_spread_points": max(
            current_spread or 0.0,
            previous_number("day_max_spread_points", current_spread or 0.0),
        ),
        "day_max_spread_atr_ratio": max(
            current_spread_atr or 0.0,
            previous_number("day_max_spread_atr_ratio", current_spread_atr or 0.0),
        ),
        "day_min_margin_level": min(
            current_margin_level,
            previous_number("day_min_margin_level", current_margin_level),
        ),
        "day_worst_intraday_drawdown_pct": min(
            account_row["intraday_drawdown_pct"],
            previous_number(
                "day_worst_intraday_drawdown_pct",
                account_row["intraday_drawdown_pct"],
            ),
        ),
        "sync_duration_ms": sync_duration_ms,
    }
    supabase.table("telemetry_summary").upsert(summary, on_conflict="account").execute()
    return summary


def record_sync_health(
    run_id: str,
    started_at: datetime.datetime,
    status: str,
    duration_ms: int,
    counts: dict[str, int],
    version_key: str | None,
    error: Exception | None = None,
) -> None:
    if not telemetry_schema_exists():
        return
    try:
        supabase.table("sync_health").upsert(
            {
                "account": str(ACCOUNT_LOGIN),
                "run_id": run_id,
                "started_at": started_at.isoformat(),
                "finished_at": utc_now().isoformat(),
                "status": status,
                "duration_ms": duration_ms,
                "closed_positions": counts.get("closed", 0),
                "open_positions": counts.get("open", 0),
                "raw_deals": counts.get("raw_deals", 0),
                "raw_orders": counts.get("raw_orders", 0),
                "runtime_events": counts.get("runtime_events", 0),
                "error_type": type(error).__name__ if error else None,
                "error_message": str(error)[:1000] if error else None,
                "bot_version_key": version_key,
            },
            on_conflict="account,run_id",
        ).execute()
    except Exception as health_error:
        log(f"Could not record sync health: {health_error!r}")


def record_risk_probe() -> None:
    if not telemetry_schema_exists():
        return
    account = ensure_connected()
    positions = current_positions()
    if not positions:
        return
    now = utc_now()
    offset = server_utc_offset_seconds()
    info = mt5.symbol_info(SYMBOL_FILTER)
    tick = mt5.symbol_info_tick(SYMBOL_FILTER)
    point = finite(getattr(info, "point", 0.01), 0.01) if info else 0.01
    bid = finite(getattr(tick, "bid", 0.0)) if tick else 0.0
    ask = finite(getattr(tick, "ask", 0.0)) if tick else 0.0
    spread_points = max(0.0, ask - bid) / point if point > 0 else 0.0
    floating = sum(finite(position.profit) + finite(position.swap) for position in positions)
    total_lots = sum(finite(position.volume) for position in positions)
    limits = effective_limits(finite(account.balance))
    used_pct = (
        max(0.0, -floating) / limits["max_floating_loss"] * 100
        if limits["max_floating_loss"] > 0
        else 0.0
    )
    basket_id = (
        f"B{min(int(getattr(position, 'identifier', position.ticket) or position.ticket) for position in positions)}"
    )
    row = {
        "account": str(ACCOUNT_LOGIN),
        "basket_id": basket_id,
        "probe_bucket": probe_bucket(now),
        "recorded_at": now.isoformat(),
        "equity": finite(account.equity),
        "floating_pnl": floating,
        "margin_free": finite(account.margin_free),
        "margin_level": finite(account.margin_level),
        "position_count": len(positions),
        "total_lots": total_lots,
        "bid": bid or None,
        "ask": ask or None,
        "spread_points": spread_points,
        "effective_max_floating_loss": limits["max_floating_loss"],
        "floating_limit_used_pct": used_pct,
    }
    supabase.table("risk_probes").upsert(
        row, on_conflict="account,basket_id,probe_bucket"
    ).execute()

    existing_response = (
        supabase.table("telemetry_summary")
        .select(
            "summary_date,day_worst_floating,day_max_floating_limit_used_pct,"
            "day_max_spread_points"
        )
        .eq("account", str(ACCOUNT_LOGIN))
        .maybe_single()
        .execute()
    )
    existing = existing_response.data or {}
    today = now.astimezone(MADRID_TZ).date().isoformat()
    if existing.get("summary_date") == today:
        supabase.table("telemetry_summary").update(
            {
                "updated_at": now.isoformat(),
                "floating_pnl": floating,
                "equity": finite(account.equity),
                "margin_free": finite(account.margin_free),
                "margin_level": finite(account.margin_level),
                "position_count": len(positions),
                "total_lots": total_lots,
                "floating_limit_used_pct": used_pct,
                "bid": bid or None,
                "ask": ask or None,
                "spread_points": spread_points,
                "day_worst_floating": min(
                    floating, finite(existing.get("day_worst_floating"), floating)
                ),
                "day_max_floating_limit_used_pct": max(
                    used_pct,
                    finite(existing.get("day_max_floating_limit_used_pct"), used_pct),
                ),
                "day_max_spread_points": max(
                    spread_points,
                    finite(existing.get("day_max_spread_points"), spread_points),
                ),
            }
        ).eq("account", str(ACCOUNT_LOGIN)).execute()


def check_for_update() -> None:
    temporary_path = f"{SELF_PATH}.new"
    try:
        with urllib.request.urlopen(SELF_UPDATE_URL, timeout=10) as response:
            remote_code = response.read()
        with open(SELF_PATH, "rb") as handle:
            local_code = handle.read()
        if not remote_code or remote_code == local_code:
            return
        if b"def main(" not in remote_code or contains_order_send_call(remote_code):
            raise RuntimeError("downloaded update failed the read-only safety check")
        compile(remote_code, SELF_PATH, "exec")
        with open(temporary_path, "wb") as handle:
            handle.write(remote_code)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, SELF_PATH)
        log("Validated read-only update installed atomically; restarting.")
        os.execv(sys.executable, [sys.executable, SELF_PATH])
    except Exception as exc:
        try:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
        except OSError:
            pass
        log(f"Update check failed (ignored): {exc!r}")


def sync_pass() -> None:
    global first_history_pass
    started_at = utc_now()
    started_monotonic = time.monotonic()
    run_id = str(uuid.uuid4())
    counts = {"closed": 0, "open": 0, "raw_deals": 0, "raw_orders": 0, "runtime_events": 0}
    version_key: str | None = None
    try:
        account = ensure_connected()
        now = utc_now()
        offset = server_utc_offset_seconds()
        updated_at = now.isoformat()
        positions = current_positions()
        market = market_metrics(offset)

        if telemetry_schema_exists():
            version_key = register_bot_version(updated_at)
        else:
            version_key = sha256_json(config_payload())[:24]

        closed, raw_deals_count, raw_orders_count = sync_closed_trades(
            version_key, first_history_pass
        )
        first_history_pass = False
        counts.update(
            {
                "closed": closed,
                "raw_deals": raw_deals_count,
                "raw_orders": raw_orders_count,
            }
        )
        counts["open"] = sync_open_positions(positions, updated_at, offset)
        sync_account_snapshot(account, updated_at)
        floating_pnl = record_floating_snapshot(account, positions)

        if telemetry_schema_exists():
            counts["runtime_events"] = sync_runtime_events(version_key)
            elapsed_before_telemetry = int((time.monotonic() - started_monotonic) * 1000)
            sync_advanced_telemetry(
                account,
                positions,
                market,
                now,
                offset,
                version_key,
                elapsed_before_telemetry,
            )

        duration_ms = int((time.monotonic() - started_monotonic) * 1000)
        record_sync_health(
            run_id, started_at, "ok", duration_ms, counts, version_key
        )
        log(
            "Sync pass OK. "
            f"balance={finite(account.balance):.2f} equity={finite(account.equity):.2f} "
            f"closed={counts['closed']} open={counts['open']} floating={floating_pnl:.2f} "
            f"spread={finite(market['spread_points']):.1f} duration_ms={duration_ms}"
        )
    except Exception as exc:
        duration_ms = int((time.monotonic() - started_monotonic) * 1000)
        record_sync_health(
            run_id, started_at, "error", duration_ms, counts, version_key, exc
        )
        log(f"Sync pass failed: {exc!r}")


def main() -> None:
    if contains_order_send_call(Path(__file__).read_text(encoding="utf-8")):
        raise RuntimeError("Read-only safety check failed")
    connect()
    log(
        f"Starting read-only MT5 sync for account {ACCOUNT_LOGIN}; "
        f"interval={POLL_SECONDS}s."
    )
    pass_count = 0
    while True:
        pass_started = time.monotonic()
        sync_pass()
        pass_count += 1
        if pass_count % SELF_UPDATE_EVERY_N_PASSES == 0:
            check_for_update()
        elapsed = time.monotonic() - pass_started
        remaining = max(1.0, POLL_SECONDS - elapsed)
        deadline = time.monotonic() + remaining
        while time.monotonic() < deadline:
            time.sleep(min(RISK_PROBE_SECONDS, max(0.1, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                break
            try:
                record_risk_probe()
            except Exception as exc:
                log(f"Risk probe failed (ignored): {exc!r}")


if __name__ == "__main__":
    main()

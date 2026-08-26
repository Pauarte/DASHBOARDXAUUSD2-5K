"""Exportació forense en només lectura del demo Sell Guard 111668309.

No envia ordres ni modifica MT5. Genera un paquet local amb l'historial del
bot, context de mercat i informació del terminal per analitzar cada cistella.
"""

from __future__ import annotations

import csv
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import MetaTrader5 as mt5


TERMINAL = r"C:\Program Files\Meta Trader 5 bot 3\terminal64.exe"
EXPECTED_LOGIN = 111668309
SYMBOL = "XAUUSD"
MAGIC = 20260825501
OUTPUT = Path(r"C:\Users\Administrator\Desktop\EXPORT_DEMO_SELL_GUARD_111668309")
HISTORY_FROM = datetime(2026, 1, 1, tzinfo=timezone.utc)
TICK_LOOKBACK_DAYS = 14
M1_BARS = 100_000


def native(value: Any) -> Any:
    """Converteix valors de NumPy/MT5 a tipus serialitzables."""
    return value.item() if hasattr(value, "item") else value


def record(item: Any) -> dict[str, Any]:
    """Converteix una estructura MT5 a un diccionari pla."""
    return {key: native(value) for key, value in item._asdict().items()}


def records(items: Iterable[Any] | None) -> list[dict[str, Any]]:
    """Converteix una col·lecció MT5 sense avaluar arrays com booleans."""
    if items is None:
        return []
    return [record(item) for item in items]


def write_json(name: str, content: Any) -> None:
    (OUTPUT / name).write_text(
        json.dumps(content, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )


def write_csv(name: str, entries: list[dict[str, Any]]) -> None:
    path = OUTPUT / name
    if not entries:
        path.write_text("", encoding="utf-8")
        return
    fields = sorted({key for row in entries for key in row})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(entries)


def export_rates(name: str, timeframe: int, count: int) -> int:
    """Exporta OHLCV de MT5 per un timeframe; retorna el nombre de barres."""
    raw_rates = mt5.copy_rates_from_pos(SYMBOL, timeframe, 0, count)
    rows: list[dict[str, Any]] = []
    if raw_rates is not None:
        for rate in raw_rates:
            values = rate.tolist() if hasattr(rate, "tolist") else rate
            rows.append(
                {
                    "time": int(values[0]),
                    "open": float(values[1]),
                    "high": float(values[2]),
                    "low": float(values[3]),
                    "close": float(values[4]),
                    "tick_volume": int(values[5]),
                    "spread": int(values[6]),
                    "real_volume": int(values[7]),
                }
            )
    write_csv(name, rows)
    return len(rows)


def export_recent_ticks() -> int:
    """Exporta ticks Bid/Ask recents per estudiar spread i execució."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=TICK_LOOKBACK_DAYS)
    raw_ticks = mt5.copy_ticks_range(SYMBOL, start, end, mt5.COPY_TICKS_ALL)
    rows: list[dict[str, Any]] = []
    if raw_ticks is not None:
        for tick in raw_ticks:
            values = tick.tolist() if hasattr(tick, "tolist") else tick
            rows.append(
                {
                    "time": int(values[0]),
                    "bid": float(values[1]),
                    "ask": float(values[2]),
                    "last": float(values[3]),
                    "volume": float(values[4]),
                    "time_msc": int(values[5]),
                    "flags": int(values[6]),
                    "volume_real": float(values[7]),
                }
            )
    write_csv(f"ticks_{TICK_LOOKBACK_DAYS}d.csv", rows)
    return len(rows)


def copy_recent_terminal_logs(data_path: str) -> int:
    """Copia només logs recents del terminal, sense configuracions ni secrets."""
    destination = OUTPUT / "terminal_logs"
    destination.mkdir(exist_ok=True)
    roots = [Path(data_path) / "logs", Path(data_path) / "MQL5" / "Logs"]
    copied = 0
    cutoff = datetime.now().timestamp() - 31 * 24 * 60 * 60
    for root in roots:
        if not root.exists():
            continue
        for file_path in root.glob("*.log"):
            if file_path.stat().st_mtime < cutoff:
                continue
            shutil.copy2(file_path, destination / f"{root.name}_{file_path.name}")
            copied += 1
    return copied


def main() -> None:
    """Executa l'exportació forense del compte configurat, en només lectura."""
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if not mt5.initialize(path=TERMINAL):
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
    try:
        account = mt5.account_info()
        if account is None:
            raise RuntimeError(f"account_info failed: {mt5.last_error()}")
        if int(account.login) != EXPECTED_LOGIN:
            raise RuntimeError(
                f"Wrong account. Expected {EXPECTED_LOGIN}, got {account.login}"
            )

        # Alguns servidors MT5 etiqueten l'historial amb l'hora del broker
        # com si fos UTC. Un marge cap endavant evita excloure tancaments
        # acabats de produir; no modifica res del compte.
        to_date = datetime.now(timezone.utc) + timedelta(hours=6)
        all_deals = records(mt5.history_deals_get(HISTORY_FROM, to_date))
        all_orders = records(mt5.history_orders_get(HISTORY_FROM, to_date))
        all_positions = records(mt5.positions_get())

        bot_entry_positions = {
            int(row.get("position_id", 0))
            for row in all_deals
            if row.get("symbol") == SYMBOL
            and int(row.get("magic") or 0) == MAGIC
            and int(row.get("entry") or -1) == mt5.DEAL_ENTRY_IN
        }
        bot_deals = [
            row
            for row in all_deals
            if row.get("symbol") == SYMBOL
            and (
                int(row.get("magic") or 0) == MAGIC
                or int(row.get("position_id") or 0) in bot_entry_positions
            )
        ]
        bot_orders = [
            row
            for row in all_orders
            if row.get("symbol") == SYMBOL and int(row.get("magic") or 0) == MAGIC
        ]
        bot_positions = [
            row
            for row in all_positions
            if row.get("symbol") == SYMBOL and int(row.get("magic") or 0) == MAGIC
        ]
        xau_context_deals = [row for row in all_deals if row.get("symbol") == SYMBOL]

        tick = mt5.symbol_info_tick(SYMBOL)
        symbol_info = mt5.symbol_info(SYMBOL)
        terminal_info = mt5.terminal_info()

        write_json("account_info.json", record(account))
        write_json("terminal_info.json", record(terminal_info) if terminal_info else {})
        write_json("symbol_info.json", record(symbol_info) if symbol_info else {})
        write_json("tick.json", record(tick) if tick else {})
        write_csv("bot_deals.csv", bot_deals)
        write_csv("bot_orders.csv", bot_orders)
        write_csv("bot_open_positions.csv", bot_positions)
        write_csv("xau_account_context_deals.csv", xau_context_deals)

        m1_bars = export_rates("m1_rates.csv", mt5.TIMEFRAME_M1, M1_BARS)
        m5_bars = export_rates("m5_rates.csv", mt5.TIMEFRAME_M5, 30_000)
        h1_bars = export_rates("h1_rates.csv", mt5.TIMEFRAME_H1, 10_000)
        h4_bars = export_rates("h4_rates.csv", mt5.TIMEFRAME_H4, 5_000)
        ticks = export_recent_ticks()
        copied_logs = copy_recent_terminal_logs(record(terminal_info).get("data_path", "")) if terminal_info else 0

        write_json(
            "export_status.json",
            {
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "read_only": True,
                "login": int(account.login),
                "server": account.server,
                "symbol": SYMBOL,
                "magic": MAGIC,
                "bot_deals": len(bot_deals),
                "bot_orders": len(bot_orders),
                "bot_open_positions": len(bot_positions),
                "xau_context_deals": len(xau_context_deals),
                "m1_bars": m1_bars,
                "m5_bars": m5_bars,
                "h1_bars": h1_bars,
                "h4_bars": h4_bars,
                "recent_ticks": ticks,
                "terminal_logs": copied_logs,
                "tick_lookback_days": TICK_LOOKBACK_DAYS,
            },
        )
        print("EXPORT OK")
        print(f"Bot deals: {len(bot_deals)} | orders: {len(bot_orders)}")
        print(f"M1: {m1_bars} | ticks: {ticks} | logs: {copied_logs}")
        print(f"Output: {OUTPUT}")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()

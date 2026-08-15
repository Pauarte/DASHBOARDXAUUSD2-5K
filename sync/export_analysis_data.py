"""Exporta dades MT5 i Supabase per a una auditoria externa de només lectura."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Iterable

import MetaTrader5 as mt5
from supabase import create_client


SUPABASE_TABLES = (
    "account_snapshots",
    "account_telemetry",
    "analysis_daily_snapshots",
    "analysis_incidents",
    "bot_runtime_events",
    "bot_versions",
    "economic_events",
    "floating_pnl_snapshots",
    "market_telemetry",
    "open_positions",
    "position_telemetry",
    "raw_deals",
    "raw_orders",
    "risk_probes",
    "sync_health",
    "telemetry_summary",
    "trades",
)


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip('"').strip("'")
    return values


def json_value(value: Any) -> Any:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, tuple) and hasattr(value, "_asdict"):
        return {key: json_value(item) for key, item in value._asdict().items()}
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(json_value(value), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def named_rows(values: Iterable[Any] | None) -> list[dict[str, Any]]:
    if not values:
        return []
    return [json_value(value) for value in values]


def export_rates(symbol: str, output_path: Path) -> int:
    rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 100_000)
    if rates is None or len(rates) == 0:
        return 0
    columns = list(rates.dtype.names or [])
    if "time" in columns:
        columns.append("time_iso_utc")
    with gzip.open(output_path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for rate in rates:
            row = {
                column: json_value(rate[column])
                for column in rates.dtype.names or []
            }
            if "time" in row:
                row["time_iso_utc"] = dt.datetime.fromtimestamp(
                    int(row["time"]), tz=dt.timezone.utc
                ).isoformat()
            writer.writerow(row)
    return len(rates)


def copy_recent_logs(data_path: Path, output_dir: Path, days: int) -> int:
    cutoff = dt.datetime.now().timestamp() - (days * 86_400)
    copied = 0
    for source_dir in (data_path / "logs", data_path / "MQL5" / "Logs"):
        if not source_dir.exists():
            continue
        target_dir = output_dir / source_dir.relative_to(data_path)
        for source in source_dir.rglob("*.log"):
            try:
                if source.stat().st_mtime < cutoff:
                    continue
                relative = source.relative_to(source_dir)
                target = target_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                copied += 1
            except OSError:
                continue
    return copied


def export_mt5(env: dict[str, str], output_dir: Path, log_days: int) -> dict[str, Any]:
    terminal_path = env["MT5_TERMINAL_PATH"]
    expected_login = int(env.get("MT5_ACCOUNT") or env.get("MT5_LOGIN") or "0")
    symbol = env.get("MT5_SYMBOL", "XAUUSD")

    if not mt5.initialize(path=terminal_path):
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
    try:
        account = mt5.account_info()
        if account is None:
            raise RuntimeError(f"MT5 account_info failed: {mt5.last_error()}")
        if expected_login and int(account.login) != expected_login:
            raise RuntimeError(
                f"Wrong MT5 account: expected {expected_login}, detected {account.login}"
            )

        terminal = mt5.terminal_info()
        symbol_info = mt5.symbol_info(symbol)
        tick = mt5.symbol_info_tick(symbol)
        positions = mt5.positions_get() or ()
        history_from = dt.datetime(2000, 1, 1)
        history_to = dt.datetime.now() + dt.timedelta(days=2)
        deals = mt5.history_deals_get(history_from, history_to) or ()
        orders = mt5.history_orders_get(history_from, history_to) or ()

        write_json(output_dir / "account_info.json", account)
        write_json(output_dir / "terminal_info.json", terminal)
        write_json(output_dir / "symbol_info.json", symbol_info)
        write_json(output_dir / "symbol_tick.json", tick)
        write_json(output_dir / "open_positions.json", named_rows(positions))
        write_json(output_dir / "history_deals.json", named_rows(deals))
        write_json(output_dir / "history_orders.json", named_rows(orders))
        rate_count = export_rates(symbol, output_dir / "rates_M5.csv.gz")

        data_path = Path(str(getattr(terminal, "data_path", "")))
        log_count = (
            copy_recent_logs(data_path, output_dir / "terminal_logs", log_days)
            if data_path.exists()
            else 0
        )
        return {
            "login": int(account.login),
            "server": account.server,
            "symbol": symbol,
            "positions": len(positions),
            "deals": len(deals),
            "orders": len(orders),
            "m5_rates": rate_count,
            "terminal_logs": log_count,
            "terminal_path": terminal_path,
            "data_path": str(data_path),
        }
    finally:
        mt5.shutdown()


def export_supabase(env: dict[str, str], output_dir: Path) -> dict[str, Any]:
    client = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    result: dict[str, Any] = {}

    for table in SUPABASE_TABLES:
        output_path = output_dir / f"{table}.jsonl.gz"
        count = 0
        error: str | None = None
        try:
            with gzip.open(output_path, "wt", encoding="utf-8") as handle:
                offset = 0
                while True:
                    response = client.table(table).select("*").range(offset, offset + 999).execute()
                    rows = getattr(response, "data", None) or []
                    for row in rows:
                        handle.write(json.dumps(json_value(row), ensure_ascii=False) + "\n")
                    count += len(rows)
                    if len(rows) < 1000:
                        break
                    offset += len(rows)
        except Exception as exc:  # Continue exporting the remaining tables.
            error = repr(exc)
            if output_path.exists() and output_path.stat().st_size == 0:
                output_path.unlink()
        result[table] = {"rows": count, "error": error}
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--log-days", type=int, default=90)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    env = load_env(args.env_file)
    required = (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "MT5_TERMINAL_PATH",
    )
    missing = [name for name in required if not env.get(name)]
    if missing:
        raise RuntimeError(f"Missing required .env values: {', '.join(missing)}")

    status: dict[str, Any] = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "read_only": True,
        "secrets_exported": False,
    }
    try:
        mt5_dir = args.output / "mt5"
        mt5_dir.mkdir(exist_ok=True)
        status["mt5"] = export_mt5(env, mt5_dir, args.log_days)
    except Exception as exc:
        status["mt5_error"] = repr(exc)

    try:
        supabase_dir = args.output / "supabase"
        supabase_dir.mkdir(exist_ok=True)
        status["supabase"] = export_supabase(env, supabase_dir)
    except Exception as exc:
        status["supabase_error"] = repr(exc)

    write_json(args.output / "export_status.json", status)
    if status.get("mt5_error") or status.get("supabase_error"):
        print(json.dumps(status, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

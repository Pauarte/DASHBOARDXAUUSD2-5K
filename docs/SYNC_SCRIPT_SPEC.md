# MT5 → Supabase sync script — spec

Goal: a Python script that runs continuously on the VPS (next to the already-open,
already-logged-in MT5 terminal) and writes account 730432938's XAUUSD trades into
Supabase, so the dashboard at https://dashboard-pied-ten-19.vercel.app shows real data.

## Supabase project

- Project URL: `https://dkfnbamheyghbzppwxki.supabase.co`
- The script must use the **service_role** key, not the anon key. Get it from
  **Project Settings → API** in the Supabase dashboard. This key bypasses row-level
  security (RLS) so the script can write — the public dashboard only ever uses the
  read-only anon key.
- **Never commit the service_role key or put it in the frontend.** Keep it only in
  a local `.env` on the VPS, alongside the script.

```
pip install supabase MetaTrader5
```

```python
from supabase import create_client
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
```

## MT5 connection pattern (copied from the existing `collector.py`)

```python
import MetaTrader5 as mt5

mt5.initialize(path=TERMINAL_PATH)   # terminal already open & logged in, no password needed
account = mt5.account_info()
assert account.login == 730432938    # sanity check, fail loudly if wrong account

SYMBOL_FILTER = "XAUUSD"
MAGIC_FILTER = ...  # <-- fill in this bot's magic number from its source code
```

- Closed trades: `mt5.history_deals_get(from_date, to_date)`, filter by
  `d.symbol == SYMBOL_FILTER` and `d.magic == MAGIC_FILTER`, then **group deals by
  `d.position_id`** — each group with both an entry (`DEAL_ENTRY_IN`) and an exit
  (`DEAL_ENTRY_OUT` / `DEAL_ENTRY_OUT_BY`) deal is one fully closed position.
- Open positions: `mt5.positions_get()`, same symbol/magic filter.
- Balance/equity: `mt5.account_info()`.

**Important:** insert **one row per closed MT5 position** — do NOT pre-group
baskets (e.g. 3 positions this bot opened and closed together) into a single row.
The dashboard already does that grouping itself, by matching `close_time` across
rows — see `src/lib/stats.ts` → `groupIntoBaskets()`. If several positions close
in the same instant, just give them the exact same `close_time` and the frontend
will treat them as one trade for win-rate purposes automatically.

## Tables to write (schema already created — see `supabase/schema.sql`)

### `trades` — one row per fully closed MT5 position
| column | from |
|---|---|
| `account` | `"730432938"` (always this literal string) |
| `symbol` | `"XAUUSD"` |
| `direction` | `"BUY"` / `"SELL"` (from the entry deal's type) |
| `lots` | matched volume |
| `entry_price` | volume-weighted average of entry deal(s) |
| `exit_price` | volume-weighted average of exit deal(s) |
| `open_time` | earliest entry deal time |
| `close_time` | latest exit deal time (**same value for every leg of a basket**) |
| `pnl` | sum of `profit + commission + swap` across all deals in the position |
| `exit_reason` | `"TP"` / `"MANUAL"` / `"TIME"` — pick whichever fits this bot's own exit logic (no `SL`/`BE`, this bot has no fixed stop loss) |
| `mt5_deal_id` | the exit deal's ticket, so re-running the script upserts instead of duplicating (`unique(account, mt5_deal_id)`) |

Upsert with `on_conflict="account,mt5_deal_id"` so re-running the script is safe.

### `open_positions` — replace on every sync pass
| column | from |
|---|---|
| `account` | `"730432938"` |
| `mt5_ticket` | position ticket (`unique(account, mt5_ticket)`) |
| `direction`, `lots`, `entry_price` | from the position |
| `current_price` | `position.price_current` |
| `open_time` | `position.time` |
| `floating_pnl` | `position.profit + position.swap` |

Delete rows for this `account` that are no longer in `mt5.positions_get()` before
upserting the current ones, so closed positions disappear from the list.

### `account_snapshots` — single row per account, always upserted
| column | from |
|---|---|
| `account` | `"730432938"` |
| `balance` | `account_info().balance` |
| `equity` | `account_info().equity` |
| `currency` | `account_info().currency` |

## Suggested loop

Since the VPS runs 24/7, mirror `collector.py`'s own pattern: a `while True:` loop
with a `time.sleep(300)` (5 min) between passes, wrapped in try/except so one
failed pass doesn't kill the process.

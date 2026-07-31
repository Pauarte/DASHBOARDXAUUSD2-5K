import ast
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("sync_mt5_to_supabase.py")
MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260730_full_private_telemetry.sql"
)


class FakeSupabaseClient:
    pass


def load_sync_module():
    fake_mt5 = types.ModuleType("MetaTrader5")
    fake_mt5.DEAL_ENTRY_IN = 0
    fake_mt5.DEAL_ENTRY_OUT = 1
    fake_mt5.DEAL_ENTRY_OUT_BY = 2
    fake_mt5.DEAL_TYPE_BUY = 0
    fake_mt5.ORDER_TYPE_BUY = 0
    fake_mt5.symbol_info = lambda _symbol: types.SimpleNamespace(
        volume_min=0.01,
        volume_max=100.0,
        volume_step=0.01,
        point=0.01,
    )

    fake_dotenv = types.ModuleType("dotenv")
    fake_dotenv.load_dotenv = lambda *_args, **_kwargs: None

    fake_supabase = types.ModuleType("supabase")
    fake_supabase.create_client = lambda *_args, **_kwargs: FakeSupabaseClient()

    previous_modules = {
        name: sys.modules.get(name)
        for name in ("MetaTrader5", "dotenv", "supabase")
    }
    previous_env = {
        name: os.environ.get(name)
        for name in (
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "MT5_TERMINAL_PATH",
            "MT5_ACCOUNT",
            "MT5_MAGIC_NUMBER",
        )
    }
    try:
        sys.modules["MetaTrader5"] = fake_mt5
        sys.modules["dotenv"] = fake_dotenv
        sys.modules["supabase"] = fake_supabase
        os.environ.update(
            {
                "SUPABASE_URL": "https://example.invalid",
                "SUPABASE_SERVICE_ROLE_KEY": "test-only",
                "MT5_TERMINAL_PATH": r"C:\terminal64.exe",
                "MT5_ACCOUNT": "730432938",
                "MT5_MAGIC_NUMBER": "20260723122",
            }
        )
        spec = importlib.util.spec_from_file_location("telemetry_sync_test_module", SCRIPT_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module
    finally:
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
        for name, previous in previous_env.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous


class TelemetryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SCRIPT_PATH.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)
        cls.module = load_sync_module()

    def test_sync_is_read_only(self):
        called_names = {
            node.func.attr
            for node in ast.walk(self.tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        self.assertNotIn("order_send", called_names)

    def test_environment_is_loaded_from_script_directory(self):
        self.assertIn('SCRIPT_DIR = Path(__file__).resolve().parent', self.source)
        self.assertIn('load_dotenv(SCRIPT_DIR / ".env", override=True)', self.source)

    def test_effective_limits_match_active_bot(self):
        expected = {
            2500: (0.01, 0.05, 280.0),
            5000: (0.02, 0.11, 560.0),
            10000: (0.04, 0.22, 1120.0),
            200000: (0.8, 4.48, 22400.0),
        }
        for balance, values in expected.items():
            limits = self.module.effective_limits(balance)
            actual = (
                limits["base_lot"],
                limits["max_total_lot"],
                limits["max_floating_loss"],
            )
            self.assertEqual(actual, values)

    def test_slippage_sign_is_adverse_positive(self):
        order = types.SimpleNamespace(price_open=100.0)
        buy_entry = types.SimpleNamespace(order=1, price=100.2, volume=1.0)
        buy_exit = types.SimpleNamespace(order=2, price=99.8, volume=1.0)
        orders = {1: order, 2: order}
        _, entry_points = self.module.requested_execution(
            [buy_entry], orders, "BUY", True, 0.01
        )
        _, exit_points = self.module.requested_execution(
            [buy_exit], orders, "BUY", False, 0.01
        )
        self.assertAlmostEqual(entry_points, 20.0)
        self.assertAlmostEqual(exit_points, 20.0)

    def test_migration_contains_private_contract(self):
        migration = MIGRATION_PATH.read_text(encoding="utf-8")
        for table in (
            "account_telemetry",
            "position_telemetry",
            "risk_probes",
            "market_telemetry",
            "raw_deals",
            "raw_orders",
            "bot_runtime_events",
            "economic_events",
            "sync_health",
        ):
            self.assertIn(f"alter table {table} enable row level security", migration)
        self.assertIn("entry_slippage_points", migration)
        self.assertIn("exit_slippage_points", migration)


if __name__ == "__main__":
    unittest.main()

import asyncio
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "x-intelligence.py"
SPEC = importlib.util.spec_from_file_location("stock_daily_x_intelligence", MODULE_PATH)
assert SPEC and SPEC.loader
x_intelligence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(x_intelligence)


def create_account_db(path: Path, *, lock_until: datetime | None = None) -> None:
    locks = (
        "{}"
        if lock_until is None
        else '{"SearchTimeline":"%s"}'
        % lock_until.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    )
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE accounts (active BOOLEAN, locks TEXT, error_msg TEXT, cookies TEXT)"
        )
        connection.execute(
            "INSERT INTO accounts VALUES (1, ?, NULL, ?)",
            (locks, '{"auth_token":"verified"}'),
        )


class XIntelligenceTests(unittest.TestCase):
    def test_queue_state_reports_ready_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "accounts.db"
            create_account_db(db_path)
            state = x_intelligence.search_queue_state(
                db_path, datetime(2026, 8, 21, tzinfo=timezone.utc)
            )
        self.assertTrue(state["available"])
        self.assertEqual(state["active_count"], 1)
        self.assertEqual(state["authenticated_count"], 1)

    def test_sixty_second_cooldown_waits_then_recovers_once(self) -> None:
        start = datetime(2026, 8, 21, 22, 0, tzinfo=timezone.utc)
        clock = [start]
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "accounts.db"
            create_account_db(db_path, lock_until=start + timedelta(seconds=60))

            async def fake_sleep(seconds: float) -> None:
                clock[0] += timedelta(seconds=seconds)

            available, waited = asyncio.run(
                x_intelligence.wait_for_search_queue(
                    db_path,
                    sleep=fake_sleep,
                    now_provider=lambda: clock[0],
                )
            )
        self.assertTrue(available)
        self.assertTrue(waited)

    def test_long_cooldown_does_not_wait(self) -> None:
        start = datetime(2026, 8, 21, 22, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "accounts.db"
            create_account_db(db_path, lock_until=start + timedelta(seconds=90))
            available, waited = asyncio.run(
                x_intelligence.wait_for_search_queue(
                    db_path,
                    sleep=lambda _seconds: None,
                    now_provider=lambda: start,
                )
            )
        self.assertFalse(available)
        self.assertFalse(waited)

    def test_error_categories_are_distinct(self) -> None:
        cases = {
            "HTTP 401 Unauthorized": "auth_failed",
            "HTTP 403 Forbidden": "access_denied",
            "HTTP 429 Too Many Requests": "rate_limited",
            "NetworkError timed out": "network_error",
            'No account available for queue "SearchTimeline"': "cooldown",
        }
        for message, expected in cases.items():
            with self.subTest(message=message):
                self.assertEqual(
                    x_intelligence.classify_search_error(RuntimeError(message)),
                    expected,
                )

    def test_selected_post_requires_concrete_fact(self) -> None:
        promotion = (
            "Join us for our annual AI conference and visit our booth to meet the team "
            "and hear why the future is exciting for everyone in the ecosystem."
        )
        concrete = (
            "HBM4 production capacity will increase 30% after a new customer agreement, "
            "with volume shipments scheduled for the fourth quarter."
        )
        expert_opinion = (
            "I think this stock is a game changer and very bullish, with a possible 30% "
            "move even though no order or customer has been confirmed."
        )
        self.assertFalse(x_intelligence.is_selected_post(promotion, "first_party"))
        self.assertTrue(x_intelligence.is_selected_post(concrete, "specialist"))
        self.assertFalse(x_intelligence.is_selected_post(expert_opinion, "expert"))

    def test_extracts_structured_expanded_and_tco_urls(self) -> None:
        tweet = SimpleNamespace(
            links=[
                SimpleNamespace(
                    url="https://www.trendforce.com/presscenter/news/20260821-1.html",
                    tcourl="https://t.co/example",
                    text="trendforce.com/presscenter/news",
                )
            ]
        )
        urls = x_intelligence.extract_external_urls(tweet, "Details https://t.co/example")
        self.assertEqual(
            urls,
            [
                "https://www.trendforce.com/presscenter/news/20260821-1.html",
                "https://t.co/example",
            ],
        )


if __name__ == "__main__":
    unittest.main()

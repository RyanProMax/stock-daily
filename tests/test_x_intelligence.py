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
            (locks, '{"auth_token":"verified","ct0":"verified"}'),
        )


class XIntelligenceTests(unittest.TestCase):
    def chunk_runtime(self):
        def original(text):
            if "entry-client-logged-out" in text:
                raise RuntimeError("Logged-out X web app")
            if "/x-web/" in text:
                return ["modern-bundle"]
            raise RuntimeError("X web scripts not found")
        module = SimpleNamespace(
            get_scripts_list=original,
            ASSET_URL_RE=x_intelligence.re.compile(r"https://[\w.-]+/x-web/[\w./-]+\.js"),
            script_url=lambda name, digest: f"https://abs.twimg.com/responsive-web/client-web/{name}.{digest}.js",
        )
        x_intelligence.install_chunk_hash_compatibility(module)
        return module

    def test_legacy_chunk_hash_lengths_and_name_maps(self):
        module = self.chunk_runtime()
        urls = module.get_scripts_list('maps={1:"abcdef0",2:"0123456789abcdef",3:"deadbee"};names={1:"main",2:"ondemand.s",3:"other"}')
        self.assertEqual(urls, [
            "https://abs.twimg.com/responsive-web/client-web/main.abcdef0a.js",
            "https://abs.twimg.com/responsive-web/client-web/ondemand.s.0123456789abcdefa.js",
            "https://abs.twimg.com/responsive-web/client-web/other.deadbeea.js",
        ])
        self.assertEqual(module.get_scripts_list('2:"0123456789abcdef"'), ["https://abs.twimg.com/responsive-web/client-web/2.0123456789abcdefa.js"])

    def test_modern_and_logged_out_bundles_keep_original_checks(self):
        module = self.chunk_runtime()
        self.assertEqual(module.get_scripts_list('https://abs.twimg.com/x-web/assets/entry-client.js'), ["modern-bundle"])
        with self.assertRaisesRegex(RuntimeError, "Logged-out"):
            module.get_scripts_list('https://abs.twimg.com/x-web/assets/entry-client-logged-out.js')
        for text in ['challenge only', '1:"0123456789abcdef0"', '1:"ABCDEF0"']:
            with self.subTest(text=text), self.assertRaisesRegex(RuntimeError, "not found"):
                module.get_scripts_list(text)

    def test_partial_authentication_is_not_a_ready_search_account(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "accounts.db"
            create_account_db(db_path)
            with sqlite3.connect(db_path) as connection:
                connection.execute("UPDATE accounts SET cookies = ?", ('{"auth_token":"verified"}',))
            state = x_intelligence.search_queue_state(db_path)
        self.assertEqual(state["authenticated_count"], 0)
        self.assertFalse(state["available"])

    def test_discovery_distinguishes_empty_response_from_filtered_posts(self) -> None:
        reference = datetime(2026, 9, 29, 22, 0, tzinfo=timezone.utc)
        source = {"handle": "Analyst", "label": "Analyst", "authority": "expert", "markets": ["US"], "layers": []}
        valid = SimpleNamespace(id=123, date=reference - timedelta(hours=1), user=SimpleNamespace(username="Analyst"), rawContent="Bond valuation remains vulnerable because inflation and interest rates raise financing costs, while credit conditions offset some pressure on equity markets.")
        vague = SimpleNamespace(id=124, date=reference, user=SimpleNamespace(username="Analyst"), rawContent="Very bullish, this is a game changer. " * 4)

        class Api:
            def __init__(self, posts): self.posts = posts
            async def search(self, _query, limit):
                for post in self.posts: yield post

        stats = {"rawPostCount": 0, "filteredPostCount": 0}
        items = asyncio.run(x_intelligence.search_items(Api([valid, vague]), "query", 100, {"analyst": source}, reference - timedelta(hours=72), reference, stats))
        self.assertEqual(len(items), 1)
        self.assertEqual(stats, {"rawPostCount": 2, "filteredPostCount": 1})
        empty = {"rawPostCount": 0, "filteredPostCount": 0}
        asyncio.run(x_intelligence.search_items(Api([]), "query", 100, {"analyst": source}, reference - timedelta(hours=72), reference, empty))
        self.assertEqual(empty["rawPostCount"], 0)

    def test_specific_kol_mechanism_is_kept_without_numeric_filler(self) -> None:
        thesis = "I think demand growth and the inventory bottleneck affect pricing and margins; published orders and deliveries will determine whether earnings expectations can be sustained."
        self.assertTrue(x_intelligence.is_selected_post(thesis, "expert"))
        self.assertFalse(x_intelligence.is_selected_post("Very bullish, this could be huge and a game changer for all investors. " * 3, "expert"))
        self.assertTrue(x_intelligence.is_selected_post("Bond valuation remains vulnerable because inflation and interest rates raise financing costs, while credit conditions offset some of the pressure on equity markets.", "expert"))

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

    def test_swallowed_library_failures_are_not_reported_as_no_posts(self):
        failure = x_intelligence.library_failure_category('XClIdParseError: X web scripts not found; username=private-pool-name; queue=SearchTimeline')
        self.assertEqual(failure, "parser_error")
        self.assertEqual(x_intelligence.search_result_status(0, {failure}), "parser_error")
        self.assertEqual(x_intelligence.library_failure_category("XClIdAccountError: Logged-out X web app"), "auth_failed")
        self.assertIsNone(x_intelligence.library_failure_category("Unrelated note; username=login-reader; queue=SearchTimeline"))
        self.assertEqual(x_intelligence.search_result_status(0, set()), "empty_response")
        self.assertEqual(x_intelligence.search_result_status(104, set()), "ok")
        self.assertNotIn("private-pool-name", failure)

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

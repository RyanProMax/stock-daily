#!/usr/bin/env python3
"""Collect public AI-chain posts from a verified X allowlist."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
from importlib.metadata import PackageNotFoundError, version
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from typing import Any
from urllib.parse import urlparse


REQUIRED_TWSCRAPE_VERSION = (0, 20, 0)
MAX_COOLDOWN_WAIT_SECONDS = 75
SEARCH_WAIT_TIMEOUT_SECONDS = 80
COLLECTION_BUDGET_SECONDS = 100
MAX_POST_CHARACTERS = 6000
X_COLLECTOR_VERSION = "verified-public-x-source-groups-v3"
PROMOTION_PATTERN = re.compile(
    r"\b(?:register|join us|save the date|tune in|watch live|webinar|"
    r"visit (?:our |the )?booth|meet us|event lineup|sponsor(?:ed|ship)?|giveaway|bounty)\b|"
    r"报名|参会|峰会|论坛|直播|展位|大会日程|品牌活动",
    re.IGNORECASE,
)
VAGUE_OPINION_PATTERN = re.compile(
    r"\b(?:i think|i believe|in my opinion|could be huge|very bullish|very bearish|"
    r"game changer|must watch|to the moon)\b|我认为|个人观点|看好|看空|值得关注|"
    r"重大利好|颠覆性|想象空间|(?:ai|模型)(?:说|推算|测算|预测)",
    re.IGNORECASE,
)
CONCRETE_FACT_PATTERN = re.compile(
    r"\b(?:order|contract|agreement|customer|launch(?:ed|es|ing)?|unveil(?:ed|s)?|"
    r"introduc(?:e|ed|es|ing)|ship(?:ped|s|ping)?|deliver(?:ed|y|ies)|available|"
    r"availability|capacity|production|price|pricing|revenue|earnings|profit|guidance|"
    r"sales|demand|supply|inventory|benchmark|throughput|latency|bandwidth|yield|"
    r"investment|funding|acquisition|partnership|roadmap|forecast|estimate|"
    r"inflation|employment|payrolls|tariffs|treasury|bonds|credit|breadth|"
    r"positioning|options|volatility|valuation|interest rates)\b|"
    r"订单|合同|协议|客户|发布|推出|交付|出货|量产|产能|产量|价格|报价|营收|"
    r"收入|利润|业绩|指引|销量|需求|供应|库存|带宽|时延|良率|投资|融资|收购|"
    r"合作|路线图|预测|统计|通胀|就业|关税|国债|债券|信用|市场广度|期权|波动率|估值|利率|"
    r"成交|缩量|资金分流|获利了结|仓位拥挤|风险溢价",
    re.IGNORECASE,
)
NUMERIC_FACT_PATTERN = re.compile(
    r"(?:\$|¥|￥)?\d+(?:\.\d+)?(?:\s?%|\s?(?:billion|million|trillion|"
    r"gb|tb|pb|mw|gw|nm|bps?|亿美元|亿元|万元|万台|亿颗|万颗))",
    re.IGNORECASE,
)
CAUSAL_THESIS_PATTERN = re.compile(
    r"\b(?:because|due to|pricing|valuation|margin|cash flow|inventory|backlog|"
    r"bottleneck|supply constraint|demand growth|discount rate)\b|"
    r"由于|因为|估值|利润率|现金流|库存|订单积压|供给瓶颈|需求增长|贴现率|传导|"
    r"缩量|资金分流|获利了结|仓位拥挤|风险溢价",
    re.IGNORECASE,
)


def version_tuple(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    return tuple(int(part) if part.isdigit() else 0 for part in (parts + ["0", "0"])[:3])


def install_chunk_hash_compatibility(xclid: Any) -> None:
    """Apply upstream twscrape PR #328 locally for the pinned 0.20.0 runtime.

    This only reconstructs ordinary public script URLs from a received app
    page. The original modern-bundle and logged-out checks stay in force.
    No installed package, account, cookie, or challenge response is changed.
    """
    original = xclid.get_scripts_list

    def get_scripts_list(text: str) -> list[str]:
        if xclid.ASSET_URL_RE.search(text):
            return original(text)
        hashes = {
            match.group(1): match.group(2)
            for match in re.finditer(r'(\d+):"((?:[0-9a-f]{16}|[0-9a-f]{7}))"', text)
        }
        if not hashes:
            return original(text)
        names = {
            match.group(1): match.group(2)
            for match in re.finditer(r'(\d+):"([A-Za-z0-9_.-]+)"', text)
            if not re.fullmatch(r"(?:[0-9a-f]{16}|[0-9a-f]{7})", match.group(2))
        }
        return [
            xclid.script_url(names.get(chunk_id, chunk_id), hash_value + "a")
            for chunk_id, hash_value in hashes.items()
        ]

    xclid.get_scripts_list = get_scripts_list


def utc_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    return None


def compact_text(value: Any) -> str:
    return " ".join(str(value or "").replace("\x00", " ").split())[:900]


def complete_post_text(value: Any) -> str:
    # Keep later qualifications and denials. Oversized posts are refused below,
    # rather than turning their first 900 characters into the original opinion.
    return " ".join(str(value or "").replace("\x00", " ").split())


def author_handle(tweet: Any) -> str:
    user = getattr(tweet, "user", None)
    return str(getattr(user, "username", "") or "").strip("@")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--reference-time", required=True)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--limit", type=int, default=100)
    return parser.parse_args()


def search_queue_state(db_path: Path, now: datetime | None = None) -> dict[str, Any]:
    observed_at = now or datetime.now(timezone.utc)
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT active, locks, error_msg, cookies FROM accounts"
        ).fetchall()
    active_count = 0
    authenticated_count = 0
    available = False
    errors: list[str] = []
    next_available_at: datetime | None = None
    for active, raw_locks, error_message, raw_cookies in rows:
        if error_message:
            errors.append(compact_text(error_message))
        if not active:
            continue
        active_count += 1
        try:
            cookies = json.loads(raw_cookies or "{}")
        except json.JSONDecodeError:
            cookies = {}
        if not isinstance(cookies, dict) or not cookies.get("auth_token") or not cookies.get("ct0"):
            continue
        authenticated_count += 1
        try:
            locks = json.loads(raw_locks or "{}")
        except json.JSONDecodeError:
            locks = {}
        locked_until = utc_datetime(locks.get("SearchTimeline"))
        if locked_until is None or locked_until <= observed_at:
            available = True
            continue
        if next_available_at is None or locked_until < next_available_at:
            next_available_at = locked_until
    return {
        "account_count": len(rows),
        "active_count": active_count,
        "authenticated_count": authenticated_count,
        "available": available,
        "next_available_at": None if available else next_available_at,
        "errors": errors,
    }


def cooldown_seconds(state: dict[str, Any], now: datetime | None = None) -> float | None:
    next_available_at = state.get("next_available_at")
    if not isinstance(next_available_at, datetime):
        return None
    observed_at = now or datetime.now(timezone.utc)
    return max(0.0, (next_available_at - observed_at).total_seconds())


async def wait_for_search_queue(
    db_path: Path,
    *,
    max_wait_seconds: int = MAX_COOLDOWN_WAIT_SECONDS,
    sleep: Any = asyncio.sleep,
    now_provider: Any = lambda: datetime.now(timezone.utc),
) -> tuple[bool, bool]:
    """Return (available, waited) after one bounded cooldown recovery."""

    observed_at = now_provider()
    state = search_queue_state(db_path, observed_at)
    if state["available"]:
        return True, False
    wait_seconds = cooldown_seconds(state, observed_at)
    if wait_seconds is None or wait_seconds > max_wait_seconds:
        return False, False
    await sleep(wait_seconds + 0.25)
    return bool(search_queue_state(db_path, now_provider())["available"]), True


def classify_search_error(exc: BaseException) -> str:
    value = f"{exc.__class__.__name__}: {exc}".lower()
    if any(token in value for token in ("unauthorized", "authentication", "cookie", "login", "401")):
        return "auth_failed"
    if any(token in value for token in ("forbidden", "access denied", "403")):
        return "access_denied"
    if any(token in value for token in ("rate limit", "ratelimit", "too many requests", "429")):
        return "rate_limited"
    if "no account available" in value or "searchtimeline" in value:
        return "cooldown"
    if any(
        token in value
        for token in (
            "networkerror",
            "network error",
            "connectionerror",
            "connection error",
            "connecttimeout",
            "readtimeout",
            "timed out",
            "timeout",
            "temporary failure",
            "name or service not known",
        )
    ):
        return "network_error"
    return "search_error"


def library_failure_category(message: str) -> str | None:
    """Keep categories only; library messages can include private pool names."""
    message = message.split("; username=", 1)[0]
    if "XClIdParseError" in message:
        return "parser_error"
    if "XClIdAccountError" in message or "Missing authentication cookies" in message:
        return "auth_failed"
    category = classify_search_error(RuntimeError(message))
    return None if category == "search_error" else category


def search_result_status(raw_count: int, failures: set[str]) -> str:
    if raw_count:
        return "ok"
    for category in ("auth_failed", "access_denied", "rate_limited", "network_error", "parser_error", "cooldown"):
        if category in failures:
            return category
    return "empty_response"


def extract_external_urls(tweet: Any, text: str) -> list[str]:
    candidates: list[str] = []
    for link in getattr(tweet, "links", None) or []:
        for attribute in ("url", "tcourl", "text"):
            value = getattr(link, attribute, None)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                candidates.append(value)
    candidates.extend(re.findall(r"https?://[^\s)\]}>,]+", text))
    external: list[str] = []
    for value in candidates:
        hostname = (urlparse(value).hostname or "").lower()
        if hostname in {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}:
            continue
        if value not in external:
            external.append(value)
    return external[:4]


def is_selected_post(text: str, authority: str) -> bool:
    normalized = complete_post_text(text)
    # Chinese mechanisms need fewer characters than their English equivalents.
    minimum_length = 40 if re.search(r"[\u4e00-\u9fff]", normalized) else 90
    if len(normalized) < minimum_length or len(normalized) > MAX_POST_CHARACTERS:
        return False
    has_concrete_fact = bool(CONCRETE_FACT_PATTERN.search(normalized))
    has_numeric_fact = bool(NUMERIC_FACT_PATTERN.search(normalized))
    if PROMOTION_PATTERN.search(normalized) and not (has_concrete_fact and has_numeric_fact):
        return False
    if re.search(r"^(?:does anyone|anyone know|what do you think)|\?\s*$", normalized, re.IGNORECASE) and not (
        has_concrete_fact and has_numeric_fact
    ):
        return False
    if authority == "expert":
        # A specific mechanism can be useful without a number. It remains an
        # attributed opinion until the report corroborates its factual premise.
        return has_concrete_fact and (
            (has_numeric_fact and not VAGUE_OPINION_PATTERN.search(normalized))
            or bool(CAUSAL_THESIS_PATTERN.search(normalized))
        ) and not PROMOTION_PATTERN.search(normalized)
    return has_concrete_fact or has_numeric_fact


def unavailable(status: str, reason: str) -> dict[str, Any]:
    return {"status": status, "reason": reason, "items": [], "collectorVersion": X_COLLECTOR_VERSION}


async def search_items(
    api: Any,
    query: str,
    limit: int,
    source_by_handle: dict[str, dict[str, Any]],
    start_time: datetime,
    reference_time: datetime,
    diagnostics: dict[str, Any] | None = None,
    accepted_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = accepted_items if accepted_items is not None else []
    tweets = api.search(query, limit=max(1, limit))
    try:
        async for tweet in tweets:
            if diagnostics is not None:
                diagnostics["rawPostCount"] = diagnostics.get("rawPostCount", 0) + 1
            handle = author_handle(tweet)
            source = source_by_handle.get(handle.lower())
            created_at = utc_datetime(getattr(tweet, "date", None))
            tweet_id = str(getattr(tweet, "id", "") or "").strip()
            text = complete_post_text(
                getattr(tweet, "rawContent", None) or getattr(tweet, "text", None)
            )
            if (
                source is None
                or created_at is None
                or not tweet_id
                or not is_selected_post(text, str(source["authority"]))
                or created_at < start_time
                or created_at > reference_time
            ):
                if diagnostics is not None:
                    diagnostics["filteredPostCount"] = diagnostics.get("filteredPostCount", 0) + 1
                continue
            items.append(
                {
                    "title": f"@{source['handle']}：{text[:64]}",
                    "facts": text,
                    "textComplete": True,
                    "originalTextLength": len(text),
                    "url": f"https://x.com/{source['handle']}/status/{tweet_id}",
                    "source": source["label"],
                    "sourceLabel": source["label"],
                    "publishedAt": created_at.isoformat().replace("+00:00", "Z"),
                    "regions": source["markets"],
                    "platform": "x",
                    "authority": source["authority"],
                    "authorHandle": source["handle"],
                    "aiLayers": source["layers"],
                    "_outboundUrls": extract_external_urls(tweet, text),
                    "_canonicalDomains": source.get("canonicalDomains", []),
                    "_sourceId": f"x:{source['handle']}",
                    "_tier": (
                        "official"
                        if source["authority"] == "first_party"
                        else "publisher"
                        if source["authority"] == "specialist"
                        else "expert"
                    ),
                }
            )
    finally:
        close = getattr(tweets, "aclose", None)
        if close is not None:
            await close()
    return items


def authority_queries(sources: list[dict[str, Any]], start_time: datetime, reference_time: datetime) -> list[dict[str, Any]]:
    groups = []
    # The single mixed latest-results cap allowed frequent promotional accounts
    # to exhaust discovery before expert/specialist opinions were even seen.
    for authority in ("expert", "specialist", "first_party"):
        selected = [source for source in sources if source["authority"] == authority]
        if not selected:
            continue
        authors = " OR ".join(f"from:{source['handle']}" for source in selected)
        query = (f"({authors}) since:{start_time.date().isoformat()} "
                 f"until:{(reference_time + timedelta(days=1)).date().isoformat()} "
                 "-filter:replies -filter:retweets")
        groups.append({"authority": authority, "sources": selected, "query": query})
    return groups


async def search_authority_groups(api: Any, sources: list[dict[str, Any]], start_time: datetime,
                                  reference_time: datetime, limit: int, *, deadline: float,
                                  library_failures: set[str] | None = None) -> dict[str, Any]:
    items, groups = [], []
    loop = asyncio.get_running_loop()
    observed_failures = library_failures if library_failures is not None else set()
    for group in authority_queries(sources, start_time, reference_time):
        stats = {"authority": group["authority"], "sourceCount": len(group["sources"]),
                 "query": group["query"], "rawPostCount": 0, "filteredPostCount": 0,
                 "attempted": False}
        remaining = deadline - loop.time()
        if remaining <= 0:
            stats["status"] = "deadline_exceeded"
            groups.append(stats)
            continue
        observed_failures.clear()
        stats["attempted"] = True
        selected: list[dict[str, Any]] = []
        try:
            await asyncio.wait_for(search_items(
                api, group["query"], limit,
                {source["handle"].lower(): source for source in group["sources"]},
                start_time, reference_time, stats, selected,
            ), timeout=min(30, remaining))
            stats["status"] = ("partial" if observed_failures and stats["rawPostCount"] else
                               search_result_status(stats["rawPostCount"], observed_failures))
        except asyncio.TimeoutError:
            stats["status"] = "network_error"
        except Exception as exc:
            stats["status"] = classify_search_error(exc)
        # A later page failure does not erase already received original posts.
        # The group remains incomplete even when those leads survive.
        items.extend(selected)
        stats["limitMayRestrictCoverage"] = stats["rawPostCount"] >= max(1, limit)
        groups.append(stats)
    raw_count = sum(group["rawPostCount"] for group in groups)
    incomplete = [group for group in groups if group["status"] not in {"ok", "empty_response"}]
    status = "partial" if incomplete and raw_count else ("ok" if raw_count else "empty_response")
    if incomplete and not raw_count:
        categories = {group["status"] for group in incomplete}
        status = search_result_status(0, categories)
        if status == "empty_response":
            status = "search_error"
    return {"items": items, "status": status, "queryGroups": groups,
            "rawPostCount": raw_count,
            "filteredPostCount": sum(group["filteredPostCount"] for group in groups)}


async def collect(args: argparse.Namespace) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + COLLECTION_BUDGET_SECONDS
    try:
        installed_version = version("twscrape")
    except PackageNotFoundError:
        installed_version = "0.0.0"
    if version_tuple(installed_version) != REQUIRED_TWSCRAPE_VERSION:
        return unavailable(
            "dependency_missing",
            f"configured Python interpreter requires twscrape 0.20.0; found {installed_version}",
        )
    if os.environ.get("TWS_HTTP_BACKEND") != "curl" or shutil.which("curl") is None:
        return unavailable("dependency_missing", "curl HTTP backend is unavailable")
    try:
        from twscrape import API
        from twscrape import xclid
        from twscrape.logger import logger
        install_chunk_hash_compatibility(xclid)
    except Exception as exc:
        return unavailable("dependency_missing", f"twscrape import failed: {exc.__class__.__name__}")

    config_path = Path(args.config)
    try:
        sources = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return unavailable("config_missing", "X source allowlist is unavailable")
    required_source_fields = {"handle", "label", "authority", "markets", "layers", "canonicalDomains"}
    if (
        not isinstance(sources, list)
        or not sources
        or any(
            not isinstance(source, dict)
            or not required_source_fields.issubset(source)
            or source["authority"] not in {"first_party", "specialist", "expert"}
            for source in sources
        )
    ):
        return unavailable("config_missing", "X source allowlist is invalid")
    reference_time = utc_datetime(args.reference_time)
    if reference_time is None:
        return unavailable("config_missing", "invalid reference time")
    start_time = reference_time - timedelta(hours=max(1, args.hours))
    db_path = Path(
        os.environ.get(
            "STOCK_DAILY_TWSCRAPE_DB",
            str(Path.home() / ".agent-fabric/state/stock-kol-intel/twscrape/accounts.db"),
        )
    )
    if not db_path.exists():
        return unavailable("config_missing", "X account pool is not configured")
    state = search_queue_state(db_path)
    if state["account_count"] == 0 or state["active_count"] == 0:
        pool_error = RuntimeError(" ".join(state["errors"]))
        status = classify_search_error(pool_error) if state["errors"] else "config_missing"
        if status == "search_error":
            status = "auth_failed"
        return unavailable(status, "X account pool has no active account")
    if state["authenticated_count"] == 0:
        return unavailable("auth_failed", "X account pool has no authenticated account")
    queue_available, waited_for_cooldown = await wait_for_search_queue(db_path)
    if not queue_available:
        return unavailable("cooldown", "X public search queue remains locked beyond the recovery window")

    library_failures: set[str] = set()

    def observe_failure(message: Any) -> None:
        category = library_failure_category(message.record["message"])
        if category is not None:
            library_failures.add(category)

    api = API(str(db_path), proxy=os.environ.get("TWSCRAPE_PROXY") or None,
              wait_timeout=SEARCH_WAIT_TIMEOUT_SECONDS, wait_interval=1)
    observer = logger.add(observe_failure, level="WARNING")
    try:
        collected = await search_authority_groups(
            api, sources, start_time, reference_time, args.limit,
            deadline=deadline, library_failures=library_failures,
        )
    finally:
        logger.remove(observer)
    items = collected.pop("items")
    unique = {item["url"]: item for item in items}
    return {
        **collected,
        "collectorVersion": X_COLLECTOR_VERSION,
        "sourceCount": len(sources),
        "candidateCount": len(unique),
        "recoveredFromCooldown": waited_for_cooldown,
        "items": sorted(unique.values(), key=lambda item: item["publishedAt"], reverse=True),
    }


def main() -> None:
    args = parse_arguments()
    result = asyncio.run(collect(args))
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

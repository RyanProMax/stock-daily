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
PROMOTION_PATTERN = re.compile(
    r"\b(?:register|join us|save the date|tune in|watch live|webinar|conference|"
    r"booth|keynote|meet us|event lineup|sponsor(?:ed|ship)?|giveaway|bounty)\b|"
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
    r"investment|funding|acquisition|partnership|roadmap|forecast|estimate)\b|"
    r"订单|合同|协议|客户|发布|推出|交付|出货|量产|产能|产量|价格|报价|营收|"
    r"收入|利润|业绩|指引|销量|需求|供应|库存|带宽|时延|良率|投资|融资|收购|"
    r"合作|路线图|预测|统计",
    re.IGNORECASE,
)
NUMERIC_FACT_PATTERN = re.compile(
    r"(?:\$|¥|￥)?\d+(?:\.\d+)?(?:\s?%|\s?(?:billion|million|trillion|"
    r"gb|tb|pb|mw|gw|nm|bps?|亿美元|亿元|万元|万台|亿颗|万颗))",
    re.IGNORECASE,
)


def version_tuple(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    return tuple(int(part) if part.isdigit() else 0 for part in (parts + ["0", "0"])[:3])


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
        if cookies:
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
    normalized = compact_text(text)
    if len(normalized) < 90:
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
        return has_concrete_fact and has_numeric_fact and not VAGUE_OPINION_PATTERN.search(normalized)
    return has_concrete_fact or has_numeric_fact


def unavailable(status: str, reason: str) -> dict[str, Any]:
    return {"status": status, "reason": reason, "items": []}


async def search_items(
    api: Any,
    query: str,
    limit: int,
    source_by_handle: dict[str, dict[str, Any]],
    start_time: datetime,
    reference_time: datetime,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    tweets = api.search(query, limit=max(1, limit))
    try:
        async for tweet in tweets:
            handle = author_handle(tweet)
            source = source_by_handle.get(handle.lower())
            created_at = utc_datetime(getattr(tweet, "date", None))
            tweet_id = str(getattr(tweet, "id", "") or "").strip()
            text = compact_text(
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
                continue
            items.append(
                {
                    "title": f"@{source['handle']}：{text[:64]}",
                    "facts": text,
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


async def collect(args: argparse.Namespace) -> dict[str, Any]:
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

    source_by_handle = {str(item["handle"]).lower(): item for item in sources}
    handles = [str(item["handle"]) for item in sources]
    author_query = " OR ".join(f"from:{handle}" for handle in handles)
    query = (
        f"({author_query}) since:{start_time.date().isoformat()} "
        f"until:{(reference_time + timedelta(days=1)).date().isoformat()} "
        "-filter:replies -filter:retweets"
    )
    items: list[dict[str, Any]] = []
    for attempt in range(2):
        api = API(
            str(db_path),
            proxy=os.environ.get("TWSCRAPE_PROXY") or None,
            wait_timeout=SEARCH_WAIT_TIMEOUT_SECONDS,
            wait_interval=1,
        )
        try:
            items = await search_items(
                api,
                query,
                args.limit,
                source_by_handle,
                start_time,
                reference_time,
            )
            break
        except Exception as exc:
            post_state = search_queue_state(db_path)
            if post_state["active_count"] == 0:
                pool_error = RuntimeError(" ".join(post_state["errors"]))
                status = classify_search_error(pool_error)
                if status == "search_error":
                    status = "auth_failed"
            else:
                status = classify_search_error(exc)
                remaining_cooldown = cooldown_seconds(post_state)
                if (
                    status in {"network_error", "cooldown"}
                    and remaining_cooldown is not None
                    and remaining_cooldown > MAX_COOLDOWN_WAIT_SECONDS
                ):
                    status = "rate_limited"
            if attempt == 0 and status in {"network_error", "cooldown"}:
                queue_available, waited = await wait_for_search_queue(db_path)
                waited_for_cooldown = waited_for_cooldown or waited
                if queue_available:
                    continue
            return unavailable(status, f"X public search failed: {exc.__class__.__name__}")

    unique = {item["url"]: item for item in items}
    return {
        "status": "ok",
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

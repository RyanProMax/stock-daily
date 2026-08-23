#!/usr/bin/env python3
"""Collect public AI-chain posts from a verified X allowlist."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import aclosing
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any


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


def search_queue_available(db_path: Path) -> bool:
    now = datetime.now(timezone.utc)
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT active, locks FROM accounts WHERE active = 1"
        ).fetchall()
    for active, raw_locks in rows:
        if not active:
            continue
        try:
            locks = json.loads(raw_locks or "{}")
        except json.JSONDecodeError:
            locks = {}
        locked_until = utc_datetime(locks.get("SearchTimeline"))
        if locked_until is None or locked_until <= now:
            return True
    return False


async def collect(args: argparse.Namespace) -> dict[str, Any]:
    try:
        from twscrape import API
    except Exception as exc:
        return {"status": "unavailable", "reason": f"twscrape unavailable: {exc}", "items": []}

    config_path = Path(args.config)
    sources = json.loads(config_path.read_text(encoding="utf-8"))
    reference_time = utc_datetime(args.reference_time)
    if reference_time is None:
        return {"status": "unavailable", "reason": "invalid reference time", "items": []}
    start_time = reference_time - timedelta(hours=max(1, args.hours))
    db_path = Path(
        os.environ.get(
            "STOCK_DAILY_TWSCRAPE_DB",
            str(Path.home() / ".agent-fabric/state/stock-kol-intel/twscrape/accounts.db"),
        )
    )
    if not db_path.exists():
        return {"status": "unavailable", "reason": "X account pool is not configured", "items": []}
    if not search_queue_available(db_path):
        return {
            "status": "unavailable",
            "reason": "X public search queue is temporarily unavailable",
            "items": [],
        }

    source_by_handle = {str(item["handle"]).lower(): item for item in sources}
    handles = [str(item["handle"]) for item in sources]
    author_query = " OR ".join(f"from:{handle}" for handle in handles)
    query = (
        f"({author_query}) since:{start_time.date().isoformat()} "
        f"until:{(reference_time + timedelta(days=1)).date().isoformat()} "
        "-filter:replies -filter:retweets"
    )
    api = API(str(db_path), proxy=os.environ.get("TWSCRAPE_PROXY") or None)
    items: list[dict[str, Any]] = []
    try:
        async with aclosing(api.search(query, limit=max(1, args.limit))) as tweets:
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
                    or len(text) < 90
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
    except Exception as exc:
        return {
            "status": "unavailable",
            "reason": f"X public search unavailable: {exc.__class__.__name__}",
            "items": [],
        }

    unique = {item["url"]: item for item in items}
    return {
        "status": "ok",
        "sourceCount": len(sources),
        "candidateCount": len(unique),
        "items": sorted(unique.values(), key=lambda item: item["publishedAt"], reverse=True),
    }


def main() -> None:
    args = parse_arguments()
    result = asyncio.run(collect(args))
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

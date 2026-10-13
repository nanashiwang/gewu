"""Read an existing public status feed; never probe providers or accept URLs.

This is provider-wide incident context, not API uptime or scoring evidence.
Only reviewed links leave this module; remote text and URLs are not rendered.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import httpx

FEED_URL = "https://study8677.github.io/ai-status-hub/last_run.json"
HUB_URL = "https://study8677.github.io/ai-status-hub/"
MAX_AGE = timedelta(minutes=30)
CACHE_SECONDS = 300
MAX_BYTES = 256 * 1024
SOURCES = {
    "openai": {"service": "OpenAI", "url": "https://status.openai.com/", "scope": "OpenAI 综合服务通告，包含非 API 产品；需在原站核对受影响组件。"},
    "anthropic": {"service": "Claude", "url": "https://status.claude.com/", "scope": "Claude 综合服务通告，包含网页、控制台与 API；不代表所选接口一定受影响。"},
    "google": {"service": "Gemini", "url": "https://status.cloud.google.com/", "scope": "聚合源仅覆盖 Google Cloud / Vertex Gemini 相关事件，不代表 AI Studio / Gemini Developer API。", "extra_url": "https://aistudio.google.com/status", "extra_label": "Gemini API 官方状态"},
    "xai": {"service": "Grok", "url": "https://status.x.ai/", "scope": "xAI 官方综合服务通告，具体受影响模型与接口以原站为准。"},
}
LABELS = {"ok": "来源未报告异常", "warn": "来源报告部分异常", "critical": "来源报告严重异常", "unknown": "状态未知"}
_lock = threading.Lock()
_cached: object = None
_cached_at = float("-inf")


def _recent(value: object, now: datetime) -> bool:
    if not isinstance(value, str):
        return False
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.tzinfo is not None and timedelta(0) <= now - stamp <= MAX_AGE
    except (ValueError, OverflowError):
        return False


def status_snapshot(payload: object, *, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    valid = (isinstance(payload, dict) and payload.get("schema_version") == "1.0"
             and _recent(payload.get("generated_at"), now) and isinstance(payload.get("services"), list))
    result = {"source_name": "AI Status Hub", "source_url": HUB_URL, "providers": {}}
    for vendor, source in SOURCES.items():
        rows = [r for r in payload["services"] if isinstance(r, dict) and r.get("service") == source["service"]] if valid else []
        row = rows[0] if len(rows) == 1 else {}
        fresh = _recent(row.get("time"), now)
        # Source URL is verified, never followed. Reject credentials/query/path changes.
        source_url = row.get("source_url")
        trusted = isinstance(source_url, str) and source_url in {source["url"], source["url"].rstrip("/")}
        level = row.get("level")
        available = fresh and trusted and not row.get("error") and isinstance(level, str) and level in LABELS
        state = level if available else "unknown"
        result["providers"][vendor] = {
            **source, "state": state, "label": LABELS[state],
            "checked_at": row["time"] if available else None,
            "note": "厂商综合通告，仅供排查；不参与格物评分。" if available else "外部数据缺失、过期或读取失败，请查看原站；不代表厂商故障。",
        }
    return result


def _fetch() -> object:
    deadline = time.monotonic() + 8
    with httpx.Client(timeout=4, follow_redirects=False, trust_env=False) as client:
        with client.stream("GET", FEED_URL, headers={"Accept": "application/json"}) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > MAX_BYTES or time.monotonic() > deadline:
                    raise ValueError("status feed too large")
            import json
            return json.loads(data)


def cached_status() -> dict:
    """Demand driven, one bounded read per TTL; no timer or background worker."""
    global _cached, _cached_at
    if not _lock.acquire(blocking=False):
        return status_snapshot(_cached)
    try:
        if time.monotonic() - _cached_at >= CACHE_SECONDS:
            try:
                _cached = _fetch()
            except (httpx.HTTPError, ValueError, RecursionError):
                _cached = None
            _cached_at = time.monotonic()
        # Re-evaluate freshness even when serving a cached successful response.
        return status_snapshot(_cached)
    finally:
        _lock.release()

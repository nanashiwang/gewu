"""Bounded, attributed market-price reference sourced from Oken's public API.

Price facts are deliberately kept separate from Gewu's first-party quality
evidence.  Every request targets a fixed allowlisted URL; callers cannot turn
this module into an SSRF proxy.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx


OKEN_DOMAIN = "www.oken.ai"
OKEN_WEBSITE_URL = "https://www.oken.ai/zh"
OKEN_API_BASE = (
    "https://gateway.oken.ai/v4/services/"
    "jiazhi-aipolymerization/api/v1"
)

_BILLING_METHODS = (
    (1, "usage", "按量"),
    (2, "count", "按次"),
    (3, "video_size", "按视频尺寸"),
    (4, "av_duration", "按音视频时长"),
)
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_ITEMS_PER_METHOD = 300
_MAX_VARIANTS = 500
_CACHE_TTL_SECONDS = 300.0
_FAILURE_TTL_SECONDS = 30.0
_DISPLAY_TIMEZONE = timezone(timedelta(hours=8))


@dataclass(frozen=True)
class MarketModelPrice:
    model: str
    company: str
    billing_method: int
    abilities: tuple[str, ...]
    minimum_price: float | None
    input_price: float | None
    output_price: float | None
    cache_read_price: float | None
    best_discount: float | None
    official_input_price: float | None
    official_output_price: float | None
    provider_count: int
    published_at: str | None
    is_new: bool = False
    is_hot: bool = False

    @property
    def billing_key(self) -> str:
        return next(
            (key for number, key, _ in _BILLING_METHODS if number == self.billing_method),
            "unknown",
        )

    @property
    def billing_label(self) -> str:
        return next(
            (label for number, _, label in _BILLING_METHODS if number == self.billing_method),
            "其他",
        )

    @property
    def display_price(self) -> float | None:
        return self.input_price if self.billing_method == 1 else self.minimum_price


@dataclass(frozen=True)
class MarketPricing:
    prices: tuple[MarketModelPrice, ...]
    captured_at: str
    source_url: str = OKEN_WEBSITE_URL

    @property
    def model_count(self) -> int:
        return len({item.model.casefold() for item in self.prices})

    @property
    def variant_count(self) -> int:
        return len(self.prices)

    @property
    def companies(self) -> tuple[str, ...]:
        return tuple(sorted({item.company for item in self.prices}, key=str.casefold))

    @property
    def abilities(self) -> tuple[str, ...]:
        return tuple(sorted({tag for item in self.prices for tag in item.abilities}))

    @property
    def billing_counts(self) -> tuple[tuple[str, str, int], ...]:
        return tuple(
            (key, label, sum(item.billing_method == number for item in self.prices))
            for number, key, label in _BILLING_METHODS
        )


def _clean_text(value: Any, *, maximum: int = 120) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:maximum]


def _price(value: Any) -> float | None:
    """Normalize Oken prices: -1 means free, zero/missing means unavailable."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < -1 or parsed > 10_000_000:
        return None
    if parsed == -1:
        return -1.0
    return parsed if parsed > 0 else None


def _discount(value: Any) -> float | None:
    parsed = _price(value)
    return parsed if parsed is not None and 0 < parsed <= 10 else None


def _positive_int(value: Any, *, maximum: int = 100_000) -> int:
    if type(value) is not int or not 0 <= value <= maximum:
        return 0
    return value


def _flag(value: Any) -> bool:
    return value is True or (type(value) is int and value == 1)


def _tags(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    result: list[str] = []
    for raw in value[:20]:
        tag = _clean_text(raw, maximum=24).replace("|", "")
        if tag and tag not in result:
            result.append(tag)
    return tuple(result)


def _date(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.strip().split())
    if len(text) != 10:
        return None
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None
    return text


def parse_market_pricing(payloads: dict[int, Any], *, captured_at: str) -> MarketPricing:
    """Validate all billing feeds while preserving Oken's directory order.

    Oken's default model table is curated rather than globally price-sorted.
    Each billing feed therefore keeps its upstream order; optional price/date
    sorting is a presentation concern and must never compare unlike units.
    """
    prices: list[MarketModelPrice] = []
    seen: set[tuple[str, int]] = set()

    for method, _, _ in _BILLING_METHODS:
        payload = payloads.get(method)
        if (
            not isinstance(payload, dict)
            or type(payload.get("code")) is not int
            or payload.get("code") != 0
        ):
            raise ValueError(f"billing feed {method} is not successful")
        data = payload.get("data")
        raw_items = data.get("list") if isinstance(data, dict) else None
        if not isinstance(raw_items, list):
            raise ValueError(f"billing feed {method} has no list")

        for raw in raw_items[:_MAX_ITEMS_PER_METHOD]:
            if not isinstance(raw, dict):
                continue
            model = _clean_text(raw.get("sku_name"))
            company = _clean_text(raw.get("company"), maximum=48) or "其他"
            raw_method = raw.get("pricing_method")
            if not model or type(raw_method) is not int or raw_method != method:
                continue
            key = (model.casefold(), method)
            if key in seen:
                continue
            seen.add(key)

            minimum = raw.get("min_price_info")
            official = raw.get("official_price_info")
            minimum = minimum if isinstance(minimum, dict) else {}
            official = official if isinstance(official, dict) else {}
            prices.append(
                MarketModelPrice(
                    model=model,
                    company=company,
                    billing_method=method,
                    abilities=_tags(raw.get("sku_tags")),
                    minimum_price=_price(minimum.get("min_price")),
                    input_price=_price(minimum.get("input_price")),
                    output_price=_price(minimum.get("output_price")),
                    cache_read_price=_price(minimum.get("cache_read_price")),
                    best_discount=_discount(raw.get("best_discount")),
                    official_input_price=_price(official.get("input_price")),
                    official_output_price=_price(official.get("output_price")),
                    provider_count=_positive_int(raw.get("manufacturer_num")),
                    published_at=_date(raw.get("publish_at")),
                    is_new=_flag(raw.get("is_new")),
                    is_hot=_flag(raw.get("is_hot")),
                )
            )
            if len(prices) > _MAX_VARIANTS:
                raise ValueError("combined pricing feed is too large")

    if not prices:
        raise ValueError("pricing feed has no valid rows")
    captured = _clean_text(captured_at, maximum=40)
    if not captured:
        raise ValueError("captured_at is required")
    return MarketPricing(
        prices=tuple(prices),
        captured_at=captured,
    )


async def _fetch_method(client: httpx.AsyncClient, method: int) -> tuple[int, Any]:
    body = bytearray()
    async with client.stream(
        "GET",
        f"{OKEN_API_BASE}/models",
        params={
            "site": "cn",
            "locale": "zh-CN",
            "page": 1,
            "page_size": _MAX_ITEMS_PER_METHOD,
            "company": -1,
            "series_code": -1,
            "pricing_method": method,
            "model_ability": -1,
        },
        headers={"Accept": "application/json", "User-Agent": "Gewu-Market-Pricing/1.0"},
    ) as response:
        response.raise_for_status()
        if "application/json" not in response.headers.get("content-type", "").lower():
            raise ValueError("pricing response is not JSON")
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > _MAX_RESPONSE_BYTES:
                raise ValueError("pricing response is too large")
    return method, json.loads(body)


_cached_at = 0.0
_cached_value: MarketPricing | None = None
_cached_error = False


async def get_market_pricing() -> MarketPricing | None:
    """Fetch all public billing feeds concurrently, cache briefly, fail closed."""
    global _cached_at, _cached_value, _cached_error
    now = time.monotonic()
    ttl = _FAILURE_TTL_SECONDS if _cached_error else _CACHE_TTL_SECONDS
    if _cached_at and now - _cached_at < ttl:
        return _cached_value

    try:
        timeout = httpx.Timeout(8.0, connect=3.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            results = await asyncio.gather(*(
                _fetch_method(client, method) for method, _, _ in _BILLING_METHODS
            ))
        captured_at = datetime.now(_DISPLAY_TIMEZONE).isoformat(timespec="seconds")
        value = parse_market_pricing(dict(results), captured_at=captured_at)
    except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError):
        _cached_at = now
        _cached_value = None
        _cached_error = True
        return None

    _cached_at = now
    _cached_value = value
    _cached_error = False
    return value

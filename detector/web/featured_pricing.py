"""Public, explicitly disclosed pricing feed for the featured relay.

Quality evidence and commercial information deliberately live in different
models.  This module only reads an allowlisted public endpoint; callers cannot
turn it into an SSRF proxy by supplying a URL.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any

import httpx


FEATURED_DOMAIN = "nan.meta-api.vip"
FEATURED_WEBSITE_URL = f"https://{FEATURED_DOMAIN}"
FEATURED_PRICING_URL = f"{FEATURED_WEBSITE_URL}/api/pricing"

_MAX_RESPONSE_BYTES = 512 * 1024
_MAX_MODELS = 250
_CACHE_TTL_SECONDS = 300.0
_FAILURE_TTL_SECONDS = 30.0


@dataclass(frozen=True)
class FeaturedModelPrice:
    model: str
    vendor: str
    model_ratio: float | None
    completion_ratio: float | None
    cache_ratio: float | None
    groups: tuple[str, ...]
    endpoints: tuple[str, ...]
    quota_type: int = 0
    model_price: float | None = None

    @property
    def billing_key(self) -> str:
        return "request" if self.quota_type == 1 else "token"

    @property
    def billing_label(self) -> str:
        return "按次" if self.quota_type == 1 else "按量"


@dataclass(frozen=True)
class FeaturedPricing:
    models: tuple[FeaturedModelPrice, ...]
    group_ratios: tuple[tuple[str, float], ...]
    captured_at: str | None
    source_url: str = FEATURED_PRICING_URL

    @property
    def vendors(self) -> tuple[str, ...]:
        return tuple(sorted({item.vendor for item in self.models}, key=str.lower))

    @property
    def endpoint_types(self) -> tuple[str, ...]:
        return tuple(sorted({endpoint for item in self.models for endpoint in item.endpoints}))

    @property
    def token_model_count(self) -> int:
        return sum(item.quota_type == 0 for item in self.models)

    @property
    def request_model_count(self) -> int:
        return sum(item.quota_type == 1 for item in self.models)


def _clean_text(value: Any, *, maximum: int = 100) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:maximum]


def _finite_nonnegative(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0 or parsed > 1_000_000:
        return None
    return parsed


def _string_tuple(value: Any, *, maximum: int = 12) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    result: list[str] = []
    for item in value[:maximum]:
        text = _clean_text(item, maximum=48)
        if text and text not in result:
            result.append(text)
    return tuple(result)


def parse_featured_pricing(payload: Any) -> FeaturedPricing:
    """Validate and bound the third-party-shaped JSON before rendering it."""
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ValueError("pricing payload is not successful")

    vendors: dict[int, str] = {}
    for vendor in payload.get("vendors", []):
        if not isinstance(vendor, dict) or isinstance(vendor.get("id"), bool):
            continue
        vendor_id = vendor.get("id")
        name = _clean_text(vendor.get("name"), maximum=48)
        if isinstance(vendor_id, int) and name:
            vendors[vendor_id] = name

    models: list[FeaturedModelPrice] = []
    seen: set[str] = set()
    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise ValueError("pricing payload has no model list")
    for item in raw_models[:_MAX_MODELS]:
        if not isinstance(item, dict):
            continue
        model = _clean_text(item.get("model_name"), maximum=120)
        if not model or model in seen:
            continue
        seen.add(model)
        vendor_id = item.get("vendor_id")
        vendor = vendors.get(vendor_id, "其他") if isinstance(vendor_id, int) else "其他"
        raw_quota_type = item.get("quota_type")
        quota_type = (
            raw_quota_type
            if type(raw_quota_type) is int and raw_quota_type in (0, 1)
            else 0
        )
        models.append(
            FeaturedModelPrice(
                model=model,
                vendor=vendor,
                quota_type=quota_type,
                model_ratio=_finite_nonnegative(item.get("model_ratio")),
                model_price=_finite_nonnegative(item.get("model_price")),
                completion_ratio=_finite_nonnegative(item.get("completion_ratio")),
                cache_ratio=_finite_nonnegative(item.get("cache_ratio")),
                groups=_string_tuple(item.get("enable_groups")),
                endpoints=_string_tuple(item.get("supported_endpoint_types")),
            )
        )

    group_ratios: list[tuple[str, float]] = []
    raw_groups = payload.get("group_ratio")
    if isinstance(raw_groups, dict):
        for raw_name, raw_ratio in list(raw_groups.items())[:50]:
            name = _clean_text(raw_name, maximum=48)
            ratio = _finite_nonnegative(raw_ratio)
            if name and ratio is not None:
                group_ratios.append((name, ratio))

    captured_at = _clean_text(payload.get("time_ratio_at"), maximum=64) or None
    return FeaturedPricing(
        models=tuple(sorted(models, key=lambda item: (item.vendor.lower(), item.model.lower()))),
        group_ratios=tuple(sorted(group_ratios, key=lambda item: item[0].lower())),
        captured_at=captured_at,
    )


_cached_at = 0.0
_cached_value: FeaturedPricing | None = None
_cached_error = False


async def get_featured_pricing() -> FeaturedPricing | None:
    """Fetch the fixed public feed with a small cache and fail closed."""
    global _cached_at, _cached_value, _cached_error
    now = time.monotonic()
    ttl = _FAILURE_TTL_SECONDS if _cached_error else _CACHE_TTL_SECONDS
    if _cached_at and now - _cached_at < ttl:
        return _cached_value

    try:
        timeout = httpx.Timeout(5.0, connect=3.0)
        body = bytearray()
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                FEATURED_PRICING_URL,
                headers={"Accept": "application/json", "User-Agent": "Gewu-Pricing/1.0"},
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if "application/json" not in content_type:
                    raise ValueError("pricing response is not JSON")
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE_BYTES:
                        raise ValueError("pricing response is too large")
        value = parse_featured_pricing(json.loads(body))
    except (httpx.HTTPError, ValueError, TypeError):
        _cached_at = now
        _cached_value = None
        _cached_error = True
        return None

    _cached_at = now
    _cached_value = value
    _cached_error = False
    return value

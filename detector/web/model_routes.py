"""Public, read-only third-party route comparison; never Gewu scoring input."""
from __future__ import annotations

import asyncio
import json
import math
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

import httpx

from .market_pricing import OKEN_API_BASE

MAX_ROWS = 200
MAX_RESPONSE_ROWS = 1000
MAX_BYTES = 3 * 1024 * 1024
CACHE_SIZE = 32
_cache: OrderedDict[tuple[str, int], tuple[float, dict | None]] = OrderedDict()


def comparison_url(model: str, billing: int) -> str:
    return '/leaderboard/models/compare?' + urlencode({'model': model, 'billing': billing})


def text(value: object, limit: int = 160) -> str:
    return ' '.join(value.split())[:limit] if isinstance(value, str) else ''


def number(value: object, *, maximum: float = 10_000_000) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        result = float(value)
    except (ValueError, OverflowError):
        return None
    return result if math.isfinite(result) and 0 <= result <= maximum else None


def price(values: object) -> float | None:
    # These are supplier CNY prices per million tokens (unlike catalogue prices).
    # A singleton is a comparable amount; ranges / tiered units remain explicit.
    if not isinstance(values, list) or len(values) != 1:
        return None
    return number(values[0])


def parse_routes(payload: object, model: str, billing: int) -> dict:
    if not isinstance(payload, dict) or type(payload.get('code')) is not int or payload['code'] != 0:
        raise ValueError('supplier source failed')
    data = payload.get('data')
    if not isinstance(data, dict) or not isinstance(data.get('list'), list):
        raise ValueError('supplier source changed')
    raw_rows = data['list']
    total = data.get('total')
    if type(total) is not int or total < len(raw_rows) or len(raw_rows) > MAX_RESPONSE_ROWS:
        raise ValueError('invalid supplier count')
    rows, seen = [], set()
    for raw in raw_rows:
        if not isinstance(raw, dict):
            raise ValueError('invalid supplier row')
        if text(raw.get('model_name')) != model or type(raw.get('pricing_method')) is not int or raw['pricing_method'] != billing:
            raise ValueError('source returned another model or billing method')
        route_id = raw.get('id')
        if type(route_id) is not int or route_id <= 0 or route_id in seen:
            raise ValueError('duplicate or invalid route')
        seen.add(route_id)
        shop = text(raw.get('shop_name'))
        if not shop:
            raise ValueError('missing platform')
        official = type(raw.get('is_official')) is int and raw['is_official'] == 1
        grade = text(raw.get('sort_level'), 10)
        grade = grade if grade in ('S', 'A', 'B', 'C') and not official else ''
        observed_at = text(raw.get('response_at'), 40)
        stability_note = text(raw.get('response_text'), 500)
        stability = number(raw.get('stability'), maximum=100) if observed_at and stability_note else None
        latency = number(raw.get('response_time')) if observed_at else None
        if latency == 0:
            latency = None
        identity = raw.get('identity_passed')
        identity_label = '基准模型' if official else ({1: '通过', 2: '不通过'}.get(identity, '暂无检测') if type(identity) is int else '暂无检测')
        rows.append({
            'id': route_id, 'shop': shop, 'group': text(raw.get('group_name')) or '未提供分组',
            'official': official, 'grade': grade, 'identity': identity_label,
            'token_label': text(raw.get('cache_label'), 40) or ('标准消耗' if official else '暂无检测'),
            'input': price(raw.get('min_input_price')) if billing == 1 else None,
            'output': price(raw.get('min_output_price')) if billing == 1 else None,
            'cache': price(raw.get('min_cache_price')) if billing == 1 else None,
            'count_price': price(raw.get('min_count_price')) if billing == 2 else None,
            'price_note': text(raw.get('input_price_display') if billing == 1 else raw.get('count_price_display'), 180),
            'stability': stability, 'stability_note': stability_note, 'latency': latency,
            'tps': number(raw.get('tps')) if observed_at else None, 'observed_at': observed_at,
            'endpoint': text(raw.get('check_endpoints'), 250),
            'rank': len(rows),
        })
    return {'rows': rows, 'total': total, 'partial': total > len(rows),
            'shops': sorted({row['shop'] for row in rows}),
            'source_url': 'https://www.oken.ai/zh/model-detail/' + quote(model, safe='') + '?' + urlencode({'pricing_method': billing}),
            'captured_at': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')}


async def _load_model_routes(model: str, billing: int) -> dict | None:
    if not model or len(model) > 160 or billing not in (1, 2, 3, 4):
        return None
    key = (model, billing)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached and now < cached[0]:
        _cache.move_to_end(key)
        return cached[1]

    async def fetch():
        async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=3), follow_redirects=False, trust_env=False) as client:
            async with client.stream('GET', OKEN_API_BASE + '/suppliers', params={
                'site': 'cn', 'locale': 'zh-CN', 'sku_name': model,
                'pricing_method': billing, 'pricing_type': billing, 'page': 1, 'page_size': MAX_ROWS,
            }, headers={'Accept': 'application/json', 'User-Agent': 'Gewu-Model-Comparison/1.0'}) as response:
                response.raise_for_status()
                if 'application/json' not in response.headers.get('content-type', '').lower():
                    raise ValueError('not JSON')
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BYTES:
                        raise ValueError('too large')
        return parse_routes(json.loads(body), model, billing)
    try:
        value = await asyncio.wait_for(fetch(), timeout=12)
    except (httpx.HTTPError, ValueError, TypeError, RecursionError, asyncio.TimeoutError):
        value = None
    _cache[key] = (time.monotonic() + (300 if value is not None else 30), value)
    _cache.move_to_end(key)
    while len(_cache) > CACHE_SIZE:
        _cache.popitem(last=False)
    return value


# Futures share the owning request's work; no detached polling or fetch tasks.
_inflight: dict[tuple, asyncio.Future] = {}
MAX_INFLIGHT = 8


async def get_model_routes(model: str, billing: int) -> dict | None:
    if not model or len(model) > 160 or billing not in (1, 2, 3, 4):
        return None
    cached = _cache.get((model, billing))
    if cached and time.monotonic() < cached[0]:
        _cache.move_to_end((model, billing))
        return cached[1]
    loop = asyncio.get_running_loop()
    key = (loop, model, billing)
    if key in _inflight:
        return await asyncio.shield(_inflight[key])
    if len(_inflight) >= MAX_INFLIGHT:
        return None
    future = loop.create_future()
    _inflight[key] = future
    result = None
    try:
        result = await _load_model_routes(model, billing)
        return result
    finally:
        # An owner disconnect leaves followers with an explicit unavailable result.
        future.set_result(result)
        _inflight.pop(key, None)

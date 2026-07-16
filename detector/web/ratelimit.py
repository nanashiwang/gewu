"""Per-IP sliding-window rate limiter.

In-memory (deque per IP) — adequate for a single-uvicorn-worker deployment.
If we ever scale to multiple workers, swap the backend for Redis.

Used to shield endpoints that take a base_url + api_key from being abused as
key-scanning oracles. Cheap reads (probe) get a permissive limit; expensive
operations (detect — burns tokens, shared upstream quota) get a stricter
one.
"""

from __future__ import annotations

import time
from collections import deque

# {ip: deque of monotonic timestamps for hits inside the longest window we care about}
_HITS: dict[str, deque[float]] = {}
_LAST_SEEN: dict[str, float] = {}
_MAX_BUCKETS = 10_000
_BUCKET_TTL_S = 7200.0


def _prune_buckets(now: float, *, reserve: int = 0) -> None:
    stale = [key for key, seen in _LAST_SEEN.items() if now - seen > _BUCKET_TTL_S]
    for key in stale:
        _HITS.pop(key, None)
        _LAST_SEEN.pop(key, None)
    overflow = len(_HITS) + reserve - _MAX_BUCKETS
    if overflow > 0:
        oldest = sorted(_LAST_SEEN, key=_LAST_SEEN.get)[:overflow]
        for key in oldest:
            _HITS.pop(key, None)
            _LAST_SEEN.pop(key, None)


def check_rate(ip: str, *, limit: int, window_s: float) -> tuple[bool, float]:
    """Return ``(allowed, retry_after_seconds)`` for one hit on this IP.

    Sliding-window: counts hits in the trailing ``window_s`` seconds. If the
    count is at or above ``limit``, the call is denied and ``retry_after``
    tells the caller how many seconds until the oldest in-window hit expires.

    A `True` return implicitly records the hit.
    """
    now = time.monotonic()
    _prune_buckets(now, reserve=0 if ip in _HITS else 1)
    bucket = _HITS.setdefault(ip, deque())
    _LAST_SEEN[ip] = now
    cutoff = now - window_s
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        retry = bucket[0] + window_s - now
        return False, max(retry, 0.1)
    bucket.append(now)
    # Opportunistic shrink: avoid unbounded memory if many one-off IPs hit
    # us. Cap each bucket at ``limit + 5`` recent entries.
    if len(bucket) > limit + 5:
        for _ in range(len(bucket) - (limit + 5)):
            bucket.popleft()
    return True, 0.0


def reset() -> None:
    """Test helper — wipe all buckets."""
    _HITS.clear()
    _LAST_SEEN.clear()

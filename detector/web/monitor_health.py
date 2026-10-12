"""Cached operational view; detailed targets require internal auth."""
import threading
import time
from pathlib import Path

from relay_detector.monitor_health import health_snapshot

_lock = threading.Lock()
_cached: dict | None = None
_cached_root: Path | None = None
_cached_at = 0.0


def cached_monitor_health(root: Path) -> dict:
    global _cached, _cached_at, _cached_root
    with _lock:
        if _cached is None or root != _cached_root or time.monotonic() - _cached_at >= 60:
            try:
                _cached = {**health_snapshot(root), "available": True}
            except (OSError, ValueError):
                _cached = {"available": False, "summary": {}, "targets": []}
            _cached_root, _cached_at = root, time.monotonic()
        return _cached

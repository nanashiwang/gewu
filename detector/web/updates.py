"""Attributed public news snapshots. Reading the page never triggers a fetch."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

import httpx

SOURCE_URL = "https://www.zzstan.com/market"
SOURCE_NAME = "中转神探"
MAX_BYTES = 3 * 1024 * 1024
MAX_ITEMS = 200
SEED = Path(__file__).parent / "data" / "updates.json"
CST = timezone(timedelta(hours=8))


def _date(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("missing timestamp")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("ambiguous timestamp")
    return stamp.astimezone(timezone.utc)


def _text(value: object, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError("invalid news text")
    return value.strip()


def _source_link(value: object) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        return ""
    try:
        u = urlsplit(value)
        # Links only; no crawling of posts, images or arbitrary remote URLs.
        hosts = ("x.com", "twitter.com", "openai.com", "anthropic.com", "blog.google", "deepmind.google", "x.ai")
        if (u.scheme == "https" and u.hostname and not u.username and not u.password
                and u.port in (None, 443) and not any(c.isspace() for c in value)
                and not any(c in value for c in "\\\r\n")
                and any(u.hostname == h or u.hostname.endswith("." + h) for h in hosts)):
            return value
    except ValueError:
        pass
    return ""


def _item(row: object) -> dict:
    if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= 0:
        raise ValueError("invalid news id")
    return {
        "id": row["id"],
        "title": _text(row.get("title"), 300),
        "content": _text(row.get("content"), 5000),
        "category_name": _text(row.get("category_name"), 50),
        "posted_at": _date(row.get("posted_at")).isoformat(),
        "source_url": _source_link(row.get("source_url")),
    }


class _FlightScripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.inside = False
        self.current: list[str] = []
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.inside = True
            self.current = []

    def handle_data(self, data):
        if self.inside:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag != "script" or not self.inside:
            return
        self.inside = False
        match = re.fullmatch(r"self\.__next_f\.push\((\[.*\])\);?", "".join(self.current).strip(), re.S)
        if match:
            try:
                part = json.loads(match[1])
            except ValueError:
                return
            if isinstance(part, list) and len(part) == 2 and part[0] == 1 and isinstance(part[1], str):
                self.parts.append(part[1])


def parse_page(html: str) -> list[dict]:
    if len(html.encode("utf-8")) > MAX_BYTES:
        raise ValueError("source page too large")
    parser = _FlightScripts()
    parser.feed(html)
    payload = "".join(parser.parts)
    candidates = []
    for match in re.finditer(r'"latestUpdates"\s*:', payload):
        try:
            rows, _ = json.JSONDecoder().raw_decode(payload[match.end():].lstrip())
        except ValueError:
            continue
        if isinstance(rows, list):
            candidates.append(rows)
    # Fail closed on a changed/empty source, rather than replacing good history.
    if len(candidates) != 1 or not 1 <= len(candidates[0]) <= MAX_ITEMS:
        raise ValueError("source news structure changed or empty")
    items = [_item(row) for row in candidates[0]]
    if len({item["id"] for item in items}) != len(items):
        raise ValueError("duplicate source ids")
    return sorted(items, key=lambda item: item["posted_at"], reverse=True)


def fetch_page() -> str:
    deadline = time.monotonic() + 20
    with httpx.Client(timeout=8, follow_redirects=False, trust_env=False) as client:
        with client.stream("GET", SOURCE_URL, headers={
            "User-Agent": "GeWu-News/1.0", "Accept-Language": "zh-CN,zh;q=0.9",
        }) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > MAX_BYTES or time.monotonic() > deadline:
                    raise ValueError("source read limit exceeded")
    return data.decode("utf-8")


def storage_dir() -> Path:
    return Path(os.environ.get("GEWU_JOBS_DIR") or "/opt/gewu-detector/web_data/jobs") / ".updates"


def _read(path: Path) -> dict:
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("snapshot too large")
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("invalid snapshot")
    if not isinstance(data.get("items"), list) or len(data["items"]) > MAX_ITEMS:
        raise ValueError("invalid snapshot items")
    data["items"] = [_item(row) for row in data["items"]]
    _date(data["last_success_at"])
    return data


def load_snapshot(directory: Path | None = None) -> dict:
    directory = directory if directory is not None else storage_dir()
    try:
        data = _read(directory / "snapshot.json")
        data["seed"] = False
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        data = _read(SEED)
        data["seed"] = True
    return data


def _write(path: Path, data: dict) -> None:
    fd, temp = tempfile.mkstemp(prefix=".updates-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def sync_once(*, limit: int = MAX_ITEMS, directory: Path | None = None) -> int:
    if not 1 <= limit <= MAX_ITEMS:
        raise ValueError("invalid item limit")
    directory = directory if directory is not None else storage_dir()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "sync.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        data = load_snapshot(directory)
        now = datetime.now(timezone.utc).isoformat()
        try:
            incoming = parse_page(fetch_page())[:limit]
        except (httpx.HTTPError, ValueError, RecursionError):
            data.update(last_attempt_at=now, last_error="source_unavailable")
            _write(directory / "snapshot.json", data)
            return 1
        merged = {item["id"]: item for item in data["items"]}
        merged.update({item["id"]: item for item in incoming})
        items = sorted(merged.values(), key=lambda item: item["posted_at"], reverse=True)[:MAX_ITEMS]
        _write(directory / "snapshot.json", {
            "version": 1, "last_success_at": now, "last_attempt_at": now,
            "last_error": None, "items": items,
        })
    return 0


def page_data(directory: Path | None = None) -> dict:
    data = load_snapshot(directory)
    stamp = _date(data["last_success_at"])
    data["stale"] = datetime.now(timezone.utc) - stamp > timedelta(hours=36)
    data["updated_label"] = stamp.astimezone(CST).strftime("%Y年%m月%d日 %H:%M")
    data["source_name"], data["source_url"] = SOURCE_NAME, SOURCE_URL
    for row in data["items"]:
        row["date_label"] = _date(row["posted_at"]).astimezone(CST).strftime("%Y年%m月%d日 %H:%M")
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="同步中转神探公开动态，执行一次后退出")
    parser.add_argument("--limit", type=int, default=MAX_ITEMS)
    args = parser.parse_args()
    result = sync_once(limit=args.limit)
    print("动态同步完成" if result == 0 else "动态同步失败，保留已有内容")
    raise SystemExit(result)

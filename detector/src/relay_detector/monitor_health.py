"""Local operational health for scheduled monitors, separate from quality scores.

Only allowlisted metadata is persisted. No keys, key fingerprints, endpoint
paths, response bodies or raw exceptions belong in this store or its API.
Historical operator reports bootstrap the view without making upstream calls.
"""
from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import secrets
from typing import Iterator

from .core.assessment import assess_report
from .core.evidence_errors import contains_auth_failure
from .monitor import normalize_target_id

LABELS = {
    "valid": "已取得有效检测证据",
    "authentication": "监测凭据鉴权失败",
    "rate_limit": "上游限流",
    "model_unavailable": "目标模型不可用",
    "timeout": "检测超时",
    "incomplete": "检测证据未完成",
    "configuration": "监测配置不可用",
    "execution": "监测执行中断",
}
FIELDS = {"target_id", "protocol", "model", "mode", "last_attempt_at", "last_valid_at",
          "consecutive_failures", "failure_kind", "next_attempt_at", "last_report_id"}
MAX_HISTORY = 5000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def _read(path: Path) -> dict | None:
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def classify_report(report: dict) -> str:
    rows = [r for r in report.get("results", []) if isinstance(r, dict)]
    if contains_auth_failure(rows):
        return "authentication"
    if assess_report(report)["score_usable"]:
        return "valid"
    # Do not classify a model's response_text or self-description as an error.
    text = "\n".join([str(report.get("run_error") or ""), *[str(r.get("error") or "") for r in rows]]).lower()
    if re.search(r"\b429\b|rate.?limit|too many requests", text):
        return "rate_limit"
    if re.search(r"model[_ ](?:not[_ ](?:found|available))|unknown model|no such model", text):
        return "model_unavailable"
    if re.search(r"timeout|timed out|超时", text):
        return "timeout"
    return "incomplete"


def next_state(previous: dict, *, target_id: str, protocol: str, model: str, mode: str,
               kind: str, observed_at: datetime, report_id: str | None = None) -> dict:
    if any(previous.get(key) != value for key, value in (("protocol", protocol), ("model", model[:160]), ("mode", mode))):
        previous = {}  # A different model/mode must not inherit a successful baseline.
    failures = 0 if kind == "valid" else min(int(previous.get("consecutive_failures", 0)) + 1, 1000000)
    # A rejected credential cannot improve by hammering it. Other transient
    # failures have a shorter backoff; timers retain their own normal cadence.
    base = 6 * 3600 if kind in {"authentication", "configuration"} else 15 * 60
    delay = min(base * 2 ** min(max(failures - 1, 0), 7), 24 * 3600)
    return {
        "target_id": normalize_target_id(target_id), "protocol": protocol,
        "model": model[:160], "mode": mode,
        "last_attempt_at": observed_at.isoformat(),
        "last_valid_at": observed_at.isoformat() if kind == "valid" else previous.get("last_valid_at"),
        "consecutive_failures": failures, "failure_kind": kind,
        "next_attempt_at": (observed_at + timedelta(seconds=delay)).isoformat() if failures else None,
        "last_report_id": report_id,
    }


def _valid_state(value: dict | None, target: str) -> bool:
    return bool(value and set(value) == FIELDS and value.get("target_id") == target
                and value.get("failure_kind") in LABELS
                and type(value.get("consecutive_failures")) is int
                and 0 <= value["consecutive_failures"] <= 1000000
                and parse_time(value.get("last_attempt_at"))
                and (value.get("last_valid_at") is None or parse_time(value["last_valid_at"]))
                and (value.get("next_attempt_at") is None or parse_time(value["next_attempt_at"]))
                and value.get("protocol") in {"anthropic", "openai", "gemini"}
                and value.get("mode") in {"quick", "standard", "full"}
                and isinstance(value.get("model"), str) and len(value["model"]) <= 160
                and (value.get("last_report_id") is None or re.fullmatch(r"[A-Za-z0-9_-]{8,64}", str(value["last_report_id"]))))


def historical_states(root: Path, now: datetime) -> tuple[dict[str, dict], bool]:
    paths = []
    for directory in (root, *(root / p for p in ("anthropic", "openai", "gemini"))):
        if directory.is_symlink():
            continue
        paths.extend(p for p in directory.glob("monitor-*.json") if not p.is_symlink())
    paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    grouped: dict[str, list[tuple[datetime, Path, dict]]] = defaultdict(list)
    for path in paths[:MAX_HISTORY]:
        report = _read(path)
        if not report:
            continue
        evidence = report.get("ranking_evidence") or {}
        if not isinstance(evidence, dict) or evidence.get("source") != "operator_monitor" or evidence.get("review_status") != "approved":
            continue
        target = evidence.get("verification_reference")
        try:
            target = normalize_target_id(target) if isinstance(target, str) else ""
        except ValueError:
            continue
        stamp = parse_time(report.get("timestamp"))
        if not target or not stamp or stamp > now or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", path.stem):
            continue
        if report.get("protocol") not in {"anthropic", "openai", "gemini"} or report.get("mode") not in {"quick", "standard", "full"}:
            continue
        if not isinstance(report.get("target_model"), str) or not isinstance(report.get("results"), list):
            continue
        grouped[target].append((stamp, path, report))
    states = {}
    for target, items in grouped.items():
        state: dict = {}
        for stamp, path, report in sorted(items, key=lambda item: (item[0], item[1].name)):
            state = next_state(state, target_id=target, protocol=report["protocol"], model=report["target_model"],
                               mode=report["mode"], kind=classify_report(report), observed_at=stamp, report_id=path.stem)
        states[target] = state
    return states, len(paths) > MAX_HISTORY


def load_states(root: Path, now: datetime | None = None) -> tuple[dict[str, dict], bool]:
    now = now or _now()
    states, limited = historical_states(root, now)
    directory = root / ".monitor_health"
    if not directory.is_symlink():
        for path in directory.glob("*.json"):
            value = _read(path)
            if not _valid_state(value, path.stem):
                raise ValueError("monitor health record unavailable")
            current = states.get(path.stem)
            if current is None or parse_time(value["last_attempt_at"]) >= parse_time(current["last_attempt_at"]):
                states[path.stem] = value
    else:
        raise ValueError("monitor health directory must not be a symlink")
    return states, limited


def save_state(root: Path, state: dict) -> None:
    target = normalize_target_id(state["target_id"])
    if not _valid_state(state, target):
        raise ValueError("invalid monitor health state")
    directory = root / ".monitor_health"
    if directory.is_symlink():
        raise ValueError("monitor health directory must not be a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / f"{target}.json"
    temporary = directory / f".{target}.{secrets.token_hex(8)}.tmp"
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def monitor_lock(root: Path, target: str) -> Iterator[None]:
    import fcntl
    target = normalize_target_id(target)
    directory = root / ".monitor_health"
    if directory.is_symlink():
        raise ValueError("monitor health directory must not be a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(directory / f"{target}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def health_snapshot(root: Path, now: datetime | None = None) -> dict:
    now = now or _now()
    states, limited = load_states(root, now)
    targets = []
    for state in sorted(states.values(), key=lambda s: s["target_id"]):
        until = parse_time(state.get("next_attempt_at"))
        targets.append({**state, "label": LABELS[state["failure_kind"]],
                        "cooling": bool(until and until > now)})
    latest = max((s["last_attempt_at"] for s in targets), default=None)
    last_valid = max((s["last_valid_at"] for s in targets if s["last_valid_at"]), default=None)
    failed = sum(s["failure_kind"] != "valid" for s in targets)
    summary = {"recorded_targets": len(targets), "blocked_targets": failed,
               "cooling_targets": sum(s["cooling"] for s in targets),
               "last_attempt_at": latest, "last_valid_at": last_valid,
               "history_limited": limited, "generated_at": now.isoformat()}
    return {"summary": summary, "targets": targets}

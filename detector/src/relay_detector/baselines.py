"""Offline baseline inventory with explicit, hash-bound operator review.

An upstream status page cannot calibrate detection scores. Merely declaring an
official base_url in a report is insufficient: approval lives in a separate,
operator-controlled manifest, never in a submitted report.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .core.comparison_guard import comparison_reasons
from .core.scoring_policy import SCORING_VERSION, PROBE_VERSION
from .wire_apis import WIRE_APIS, resolve_wire_api

ROOT = Path(__file__).resolve().parents[2] / "data/baselines"
OFFICIAL = {
    "anthropic": {"https://api.anthropic.com"},
    "openai": {"https://api.openai.com/v1"},
    "gemini": {"https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta/openai"},
}


def _read(path: Path) -> tuple[bytes, dict]:
    if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("invalid baseline file")
    content = path.read_bytes()
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("baseline must be an object")
    return content, value


def inspect_baseline(path: Path, root: Path = ROOT) -> dict:
    """Return safe metadata and reasons, never prompts, tokens or local paths."""
    name = path.relative_to(root).as_posix()
    info = {"file": name, "state": "invalid", "reasons": [], "reference": "not_available"}
    try:
        if any((root / part).is_symlink() for part in (Path(name), *Path(name).parents)):
            raise ValueError("symlink baseline path")
        content, data = _read(path)
        digest = hashlib.sha256(content).hexdigest()
        try:
            _, manifest = _read(root / "approvals.json")
            approvals = manifest.get("approvals") if manifest.get("version") == 1 else None
            approval = approvals.get(name, {}) if isinstance(approvals, dict) else {}
        except (OSError, ValueError):
            approval = {}
        protocol = data.get("protocol")
        origin = str(data.get("base_url", "")).rstrip("/")
        reviewed = (isinstance(protocol, str) and origin in OFFICIAL.get(protocol, set())
                    and isinstance(approval, dict) and approval.get("sha256") == digest
                    and approval.get("source_url") == origin)
        reasons = [] if reviewed else ["未通过独立来源审核（文件哈希与官方端点）"]
        if data.get("scoring_version") != SCORING_VERSION or data.get("probe_version") != PROBE_VERSION:
            reasons.append("评分或探针版本与当前检测器不一致")
        reasons.extend(comparison_reasons(data, data))
        info.update(state="unavailable" if reasons else "available", reasons=list(dict.fromkeys(reasons)),
                    sha256=digest,
                    timestamp=data.get("timestamp") if isinstance(data.get("timestamp"), str) else None,
                    protocol=protocol, wire_api=data.get("wire_api"), mode=data.get("mode"),
                    model=data.get("target_model") if isinstance(data.get("target_model"), str) else None)
        if not reasons:
            info["reference"] = f"{name}#sha256:{digest[:12]}"
        return info
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        info["reasons"] = ["文件不可读或格式无效"]
        return info


def baseline_status(protocol: str, model: str, mode: str, wire_api: str | None = None, *, report: dict | None = None, root: Path = ROOT) -> dict:
    missing = {"state": "missing", "reference": "not_available", "reasons": ["没有同模型、同深度的已审核基线"]}
    if not isinstance(protocol, str) or protocol not in OFFICIAL or not isinstance(mode, str) or mode not in {"quick", "standard", "full"} or not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", model):
        return missing
    try:
        wire = resolve_wire_api(protocol, wire_api)
    except (ValueError, TypeError):
        return missing
    directory = root / protocol / wire
    paths = sorted(directory.glob(f"{model}_{mode}_*.json"), reverse=True)
    paths += [directory / f"{model}_{mode}.json", root / protocol / f"{model}_{mode}.json", root / f"{model}_{mode}.json"]
    fallback = missing
    for path in paths:
        if not path.is_file() or path.parent.is_symlink():
            continue
        info = inspect_baseline(path, root)
        fallback = info
        if info["state"] != "available":
            continue
        try:
            content, data = _read(path)
        except (OSError, ValueError):
            return missing
        if hashlib.sha256(content).hexdigest() != info["sha256"]:
            return missing
        if any(data.get(k) != v for k, v in {"protocol": protocol, "target_model": model, "mode": mode}.items()) or resolve_wire_api(protocol, data.get("wire_api")) != wire:
            info.update(state="incompatible", reference="not_available", reasons=["模型、协议、接口或深度不匹配"])
        elif report is not None and (reasons := comparison_reasons(data, report)):
            info.update(state="incompatible", reference="not_available", reasons=reasons)
        if info["state"] == "available":
            return info
    return fallback


def baseline_inventory(root: Path = ROOT) -> list[dict]:
    paths = sorted(root.glob("*.json")) + sorted(root.glob("*/*.json")) + sorted(root.glob("*/*/*.json"))
    return [inspect_baseline(path, root) for path in paths if path.name != "approvals.json" and not path.parent.is_symlink()]


def official_comparison(report: dict, root: Path = ROOT) -> dict:
    """A fresh, offline view; never change the saved report or ranking score."""
    info = baseline_status(report.get("protocol"), report.get("target_model"),
                           report.get("mode"), report.get("wire_api"), report=report, root=root)
    if info["state"] != "available":
        return {**info, "rows": []}
    try:
        content, baseline = _read(root / info["file"])
        if hashlib.sha256(content).hexdigest() != info["sha256"]:
            raise ValueError("baseline changed")
        current = {row["name"]: row for row in report["results"]}
        rows = []
        for row in baseline["results"]:
            if row.get("evidence_role", "scored") != "scored" or row["weight"] <= 0 or row.get("status") == "skip":
                continue
            other = current[row["name"]]
            rows.append({"name": row["name"], "label": other.get("display_name") or row["name"],
                         "official_score": row["score"], "current_score": other["score"],
                         "official_status": row.get("status"), "current_status": other.get("status"),
                         "delta": round(other["score"] - row["score"], 2)})
        sampled_at = datetime.fromisoformat(baseline["timestamp"].replace("Z", "+00:00"))
        return {**info, "rows": rows, "source_url": baseline["base_url"],
                "sampled_at": sampled_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                "wire_label": WIRE_APIS[resolve_wire_api(baseline["protocol"], baseline.get("wire_api"))]["label"]}
    except (OSError, ValueError, KeyError, TypeError):
        return {"state": "unavailable", "reasons": ["基线读取或一致性校验失败"], "rows": []}

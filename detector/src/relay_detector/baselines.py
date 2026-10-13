"""Offline baseline inventory with explicit, hash-bound operator review.

An upstream status page cannot calibrate detection scores. Merely declaring an
official base_url in a report is insufficient: approval lives in a separate,
operator-controlled manifest, never in a submitted report.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .core.comparison_guard import comparison_reasons
from .core.scoring_policy import SCORING_VERSION, PROBE_VERSION
from .wire_apis import resolve_wire_api

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
                    model=data.get("target_model") if isinstance(data.get("target_model"), str) else None)
        if not reasons:
            info["reference"] = f"{path.name}#sha256:{digest[:12]}"
        return info
    except (OSError, ValueError, TypeError, KeyError):
        info["reasons"] = ["文件不可读或格式无效"]
        return info


def baseline_status(protocol: str, model: str, mode: str, wire_api: str | None = None, *, report: dict | None = None, root: Path = ROOT) -> dict:
    missing = {"state": "missing", "reference": "not_available", "reasons": ["没有同模型、同深度的已审核基线"]}
    if protocol not in OFFICIAL or mode not in {"quick", "standard", "full"} or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", model):
        return missing
    wire = resolve_wire_api(protocol, wire_api)
    paths = [root / protocol / f"{model}_{mode}.json", root / f"{model}_{mode}.json"]
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
    paths = sorted(root.glob("*.json")) + sorted(root.glob("*/*.json"))
    return [inspect_baseline(path, root) for path in paths if path.name != "approvals.json" and not path.parent.is_symlink()]

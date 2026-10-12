"""Fail closed before calculating baseline differences; no historical rewrites."""
from datetime import datetime, timedelta, timezone
import math
from collections.abc import Mapping

from .assessment import assess_report
from .scoring_policy import SCORING_VERSION, LEGACY_SCORING_VERSION
from ..wire_apis import resolve_wire_api

MAX_BASELINE_AGE_DAYS = 30


def comparison_reasons(baseline: Mapping, relay: Mapping, *, now: datetime | None = None) -> list[str]:
    reasons = []
    now = now or datetime.now(timezone.utc)
    if not isinstance(baseline, Mapping) or not isinstance(relay, Mapping):
        return ["基线和检测报告必须是 JSON 对象"]
    for field, label in (("protocol", "协议"), ("target_model", "模型"), ("mode", "检测深度"), ("scoring_version", "评分版本"), ("probe_version", "探针版本")):
        left, right = baseline.get(field), relay.get(field)
        if not isinstance(left, str) or not left.strip() or not isinstance(right, str) or not right.strip():
            reasons.append(f"缺少{label}，不能确认可比性")
        elif left != right:
            reasons.append(f"{label}不同")
    for item in (baseline, relay):
        if item.get("mode") not in ("quick", "standard", "full"):
            reasons.append("检测深度信息无效")
        if item.get("scoring_version") not in (SCORING_VERSION, LEGACY_SCORING_VERSION):
            reasons.append("评分版本未识别")
    try:
        if resolve_wire_api(baseline.get("protocol"), baseline.get("wire_api")) != resolve_wire_api(relay.get("protocol"), relay.get("wire_api")):
            reasons.append("请求接口不同")
    except (ValueError, TypeError, KeyError):
        reasons.append("请求接口信息无效")
    profiles = []
    for label, report in (("基线", baseline), ("检测报告", relay)):
        try:
            timestamp = datetime.fromisoformat(str(report.get("timestamp", "")).replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("timezone required")
            age = now - timestamp.astimezone(timezone.utc)
            if age < timedelta(0):
                reasons.append(f"{label}采样时间在未来")
            elif age > timedelta(days=MAX_BASELINE_AGE_DAYS):
                reasons.append(f"{label}采样已超过 {MAX_BASELINE_AGE_DAYS} 天")
        except (ValueError, TypeError, OverflowError):
            reasons.append(f"{label}缺少有效且带时区的采样时间")
        rows = report.get("results")
        valid = isinstance(rows, list) and bool(rows) and all(isinstance(row, Mapping) for row in rows)
        if valid:
            names = [row.get("name") for row in rows]
            valid = all(isinstance(name, str) and name for name in names) and len(set(names)) == len(names)
            valid = valid and all(isinstance(row.get(key), (int, float)) and not isinstance(row.get(key), bool) and math.isfinite(row[key]) and row[key] >= 0 and (key != "score" or row[key] <= 100) for row in rows for key in ("score", "weight"))
        if not valid or not assess_report(report)["score_usable"]:
            reasons.append(f"{label}证据不完整或无效")
            profiles.append(None)
            continue
        profile = {row["name"]: row["weight"] for row in rows if row.get("evidence_role", "scored") == "scored" and row.get("status") != "skip" and row["weight"] > 0}
        profiles.append(profile)
        denominator = sum(profile.values())
        expected = sum(row["score"] * profile.get(row["name"], 0) for row in rows) / denominator if denominator else None
        if expected is None or abs(expected - report["total_score"]) > 0.01:
            reasons.append(f"{label}总分与保存的计分项不一致")
    if len(profiles) == 2 and profiles[0] != profiles[1]:
        reasons.append("实际计分项目或权重不同（包括选测项目）")
    return list(dict.fromkeys(reasons))

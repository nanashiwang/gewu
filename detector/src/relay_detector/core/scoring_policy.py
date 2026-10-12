"""Versioned evidence policy. Historical reports are never re-scored on read."""

import statistics

LEGACY_SCORING_VERSION = "weighted-v1"
SCORING_VERSION = "evidence-v2"
PROBE_VERSION = "2026-10-12-calibration-1"
OBSERVATION_DETECTORS = frozenset({"identity", "behavioral_signature", "knowledge"})


def sampling_observation(tokens: list[int]) -> dict:
    """Completion lengths describe this sample, not model provenance."""
    valid = all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in tokens)
    return {
        "stability_label": "observation_only" if valid else "usage_unavailable",
        "stability_cv": round(statistics.pstdev(tokens) / statistics.mean(tokens), 3) if valid and len(tokens) > 1 else None,
        "stability_note": "长度波动仅作观察，不参与质量评分，也不能据此判断换模。",
    }


def scoring_label(version: str | None) -> str:
    if version == SCORING_VERSION:
        return "证据评分 v2"
    if not version or version == LEGACY_SCORING_VERSION:
        return "历史评分 v1（保留原分）"
    return "未知评分版本"

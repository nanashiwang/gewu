"""Evidence boundaries shared by JSON, HTML, images, CLI and ranking.

Scores remain reproducible using the historical weighting formula. A score is
only publishable when the core probe completed and no execution error occurred.
Neither a model name, self description nor copied metadata authenticates a model.
"""
from __future__ import annotations

from collections.abc import Mapping
import math
from .evidence_errors import contains_auth_failure

CORE_DETECTORS = {
    "anthropic": frozenset({"identity"}),
    "openai": frozenset({"basic_request"}),
    "gemini": frozenset({"basic_request"}),
}


def assess_report(report: Mapping) -> dict:
    raw = report.get("results") or []
    rows = [row for row in raw if isinstance(row, Mapping)] if isinstance(raw, list) else []
    counts = {status: sum(row.get("status") == status for row in rows)
              for status in ("pass", "fail", "error", "skip")}
    protocol = report.get("protocol") or "anthropic"
    required = CORE_DETECTORS.get(protocol, frozenset())
    core = [row for row in rows if row.get("name") in required]
    core_complete = bool(required) and required.issubset({
        row.get("name") for row in core if row.get("status") in {"pass", "fail"}
    })
    known_statuses = isinstance(raw, list) and sum(counts.values()) == len(rows) == len(raw)
    score = report.get("total_score")
    valid_score = isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score) and 0 <= score <= 100
    blocked = bool(report.get("run_error") or contains_auth_failure(rows))
    usable = bool(valid_score and core_complete and known_statuses and not counts["error"] and not blocked and not any(row.get("error") for row in rows))
    state = "invalid" if blocked else "complete" if usable else "incomplete"
    headline = "检测无效，暂不计分" if state == "invalid" else "证据不足，暂不计分" if not usable else "已测项目通过" if report.get("verdict") == "passed" and not counts["fail"] else "存在异常，需复核"
    availability = "未确认"
    if core_complete:
        availability = "已测通" if all(row.get("status") == "pass" for row in core) else "已返回响应，存在异常"
    if blocked:
        availability = "本次检测受阻"

    signature = next((row for row in rows if row.get("name") == "thinking_signature"), {})
    details = signature.get("details") or {}
    strong = protocol == "anthropic" and signature.get("status") == "pass" and isinstance(details, Mapping) and all(
        details.get(key) is True for key in (
            "signature_roundtrip_accepted", "tampered_signature_rejected", "tampered_rejection_verified",
        )
    )
    return {
        "version": 1, "state": state, "score_usable": usable,
        "headline": headline, "counts": counts,
        "availability": {"label": availability, "detail": "只说明本次账号、模型与入口的请求情况，不代表长期可用率。"},
        "capability": {"label": f"{counts['pass']} 项通过 · {counts['fail']} 项异常", "detail": f"{counts['error']} 项执行错误，{counts['skip']} 项跳过。未测或未完成的能力不作结论。"},
        "identity": {
            "level": "signature_roundtrip" if strong else "unconfirmed",
            "label": "签名往返对照通过" if strong else "未证实具体模型身份",
            "detail": "原始块回放通过且篡改块被明确拒绝，属于协议证据；不证明具体模型版本，也不是本地公钥验签。" if strong else "模型自述、名称、响应字段和高分都可被模仿，不能单独作为真伪证明。",
        },
    }

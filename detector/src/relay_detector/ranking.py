"""Public-ranking trust boundary and report approval helpers."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from . import __version__
from .core.models import Mode, Protocol, RankingEvidence


APPROVED_RANKING_SOURCES = frozenset({
    "operator_monitor",
    "manual_review",
    "site_owner_verified",
})

RANKING_SOURCE_LABELS = {
    "operator_monitor": "运营方定时监测",
    "manual_review": "人工审核",
    "site_owner_verified": "站点所有者验证",
    "user_submission": "用户自测",
}

_CORE_DETECTORS = {
    "anthropic": frozenset({"identity"}),
    "openai": frozenset({"basic_request"}),
    "gemini": frozenset({"basic_request"}),
}

_AUTH_ERROR_PATTERNS = (
    re.compile(r"\b(?:401|403)\b"),
    re.compile(r"authentication[_ -]?error", re.IGNORECASE),
    re.compile(r"unauthori[sz]ed", re.IGNORECASE),
    re.compile(r"invalid.{0,24}api.{0,8}key", re.IGNORECASE),
    re.compile(r"incorrect.{0,24}api.{0,8}key", re.IGNORECASE),
    re.compile(r"bad key", re.IGNORECASE),
    re.compile(r"鉴权|认证失败|无效.{0,12}(?:密钥|key)", re.IGNORECASE),
)


def detector_version() -> str:
    """Return a deploy-specific release id when available, package version otherwise."""
    return os.environ.get("GEWU_RELEASE_ID", "").strip() or __version__


def baseline_reference(protocol: str | Protocol, model: str, mode: str | Mode) -> str:
    """Return a reproducible baseline filename + content hash, or an honest sentinel."""
    protocol_value = protocol.value if isinstance(protocol, Protocol) else str(protocol)
    mode_value = mode.value if isinstance(mode, Mode) else str(mode)
    detector_root = Path(__file__).resolve().parents[2]
    baseline_root = detector_root / "data" / "baselines"
    candidates = [
        baseline_root / protocol_value / f"{model}_{mode_value}.json",
        baseline_root / protocol_value / f"{model}_full.json",
        baseline_root / f"{model}_{mode_value}.json",
        baseline_root / f"{model}_full.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        except OSError:
            continue
        return f"{path.name}#sha256:{digest}"
    return "not_available"


def unreviewed_ranking_evidence(
    protocol: str | Protocol,
    model: str,
    mode: str | Mode,
) -> RankingEvidence:
    """Metadata for user/CLI self-tests: shareable, but never ranking evidence."""
    return RankingEvidence(
        eligible=False,
        source="user_submission",
        review_status="unreviewed",
        detector_version=detector_version(),
        baseline_version=baseline_reference(protocol, model, mode),
    )


def approved_ranking_evidence(
    protocol: str | Protocol,
    model: str,
    mode: str | Mode,
    *,
    source: str,
    reviewer: str,
    verification_reference: str | None = None,
    reviewed_at: datetime | None = None,
) -> RankingEvidence:
    """Create attributable approval metadata for a trusted evidence source."""
    normalized_source = source.strip().lower()
    if normalized_source not in APPROVED_RANKING_SOURCES:
        raise ValueError("ranking source is not approved")
    normalized_reviewer = reviewer.strip()
    if not normalized_reviewer or len(normalized_reviewer) > 100:
        raise ValueError("reviewer must be 1-100 characters")
    reference = (verification_reference or "").strip() or None
    if reference is not None and len(reference) > 500:
        raise ValueError("verification reference must be at most 500 characters")
    return RankingEvidence(
        eligible=True,
        source=normalized_source,
        review_status="approved",
        detector_version=detector_version(),
        baseline_version=baseline_reference(protocol, model, mode),
        reviewed_at=reviewed_at or datetime.now(timezone.utc),
        reviewer=normalized_reviewer,
        verification_reference=reference,
    )


def _collect_error_text(value: Any, output: list[str]) -> None:
    """Collect transport/auth error fields without scanning model response text."""
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized_key = str(key).lower()
            if normalized_key in {
                "error",
                "error_message",
                "message",
                "response_body",
                "status",
                "status_code",
            }:
                if isinstance(child, (str, int)):
                    output.append(str(child))
                else:
                    _collect_error_text(child, output)
            elif isinstance(child, (Mapping, list, tuple)):
                _collect_error_text(child, output)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _collect_error_text(child, output)


def _contains_auth_failure(results: list[dict[str, Any]]) -> bool:
    text_parts: list[str] = []
    for result in results:
        error = result.get("error")
        if isinstance(error, str):
            text_parts.append(error)
        _collect_error_text(result.get("details"), text_parts)
    text = "\n".join(text_parts)
    return any(pattern.search(text) for pattern in _AUTH_ERROR_PATTERNS)


def assess_ranking_eligibility(report: Mapping[str, Any]) -> tuple[bool, str]:
    """Fail closed unless trust metadata and detector evidence are both valid."""
    evidence = report.get("ranking_evidence")
    if not isinstance(evidence, Mapping):
        return False, "missing_ranking_evidence"
    if evidence.get("eligible") is not True:
        return False, "not_approved"
    if evidence.get("review_status") != "approved":
        return False, "review_not_approved"
    if evidence.get("source") not in APPROVED_RANKING_SOURCES:
        return False, "untrusted_source"
    if not str(evidence.get("detector_version") or "").strip():
        return False, "missing_detector_version"
    if not str(evidence.get("baseline_version") or "").strip():
        return False, "missing_baseline_version"
    if not str(evidence.get("reviewer") or "").strip():
        return False, "missing_reviewer"
    if not str(evidence.get("reviewed_at") or "").strip():
        return False, "missing_review_time"
    if evidence.get("source") == "site_owner_verified" and not str(
        evidence.get("verification_reference") or ""
    ).strip():
        return False, "missing_owner_verification"

    if str(report.get("run_error") or "").strip():
        return False, "run_error"
    protocol = str(report.get("protocol") or "")
    required = _CORE_DETECTORS.get(protocol)
    if required is None:
        return False, "unsupported_protocol"
    if not str(report.get("base_url") or "").strip():
        return False, "missing_base_url"
    if not str(report.get("target_model") or "").strip():
        return False, "missing_target_model"
    try:
        datetime.fromisoformat(str(report.get("timestamp") or "").replace("Z", "+00:00"))
    except ValueError:
        return False, "invalid_timestamp"
    try:
        score = float(report.get("total_score"))
    except (TypeError, ValueError):
        return False, "invalid_score"
    if not math.isfinite(score) or not 0 <= score <= 100:
        return False, "invalid_score"

    raw_results = report.get("results")
    if not isinstance(raw_results, list) or not raw_results:
        return False, "missing_results"
    results = [row for row in raw_results if isinstance(row, dict)]
    if not results:
        return False, "missing_results"
    if _contains_auth_failure(results):
        return False, "authentication_failure"

    completed_core = {
        str(row.get("name") or "")
        for row in results
        if row.get("status") in {"pass", "fail"}
    }
    if not required.issubset(completed_core):
        return False, "core_probe_incomplete"
    return True, "eligible"


def update_report_approval(
    path: Path,
    *,
    source: str,
    reviewer: str,
    verification_reference: str | None = None,
) -> dict[str, Any]:
    """Atomically approve an existing report, refusing invalid evidence."""
    report = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise ValueError("report must be a JSON object")
    existing = report.get("ranking_evidence")
    if not isinstance(existing, Mapping):
        raise ValueError("report lacks capture provenance; run a fresh detection")
    captured_detector_version = str(existing.get("detector_version") or "").strip()
    captured_baseline_version = str(existing.get("baseline_version") or "").strip()
    if not captured_detector_version or not captured_baseline_version:
        raise ValueError("report capture provenance is incomplete; run a fresh detection")
    approved = approved_ranking_evidence(
        str(report.get("protocol") or ""),
        str(report.get("target_model") or ""),
        str(report.get("mode") or ""),
        source=source,
        reviewer=reviewer,
        verification_reference=verification_reference,
    ).model_dump(mode="json")
    # Approval must preserve what generated the evidence.  Recomputing these
    # values at review time would falsely attribute an old report to new code.
    approved["detector_version"] = captured_detector_version
    approved["baseline_version"] = captured_baseline_version
    report["ranking_evidence"] = approved
    eligible, reason = assess_ranking_eligibility(report)
    if not eligible:
        raise ValueError(f"report is not eligible for ranking: {reason}")
    _atomic_write_report(path, report)
    return report


def revoke_report_approval(path: Path, *, reviewer: str, reason: str) -> dict[str, Any]:
    """Atomically remove a report from rankings while retaining its audit trail."""
    normalized_reviewer = reviewer.strip()
    normalized_reason = reason.strip()
    if not normalized_reviewer or len(normalized_reviewer) > 100:
        raise ValueError("reviewer must be 1-100 characters")
    if not normalized_reason or len(normalized_reason) > 500:
        raise ValueError("reason must be 1-500 characters")
    report = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise ValueError("report must be a JSON object")
    old = report.get("ranking_evidence")
    evidence = dict(old) if isinstance(old, Mapping) else {}
    evidence.update({
        "schema_version": 1,
        "eligible": False,
        "review_status": "rejected",
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "reviewer": normalized_reviewer,
        "review_note": normalized_reason,
    })
    report["ranking_evidence"] = evidence
    _atomic_write_report(path, report)
    return report


def _atomic_write_report(path: Path, report: Mapping[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary.replace(path)

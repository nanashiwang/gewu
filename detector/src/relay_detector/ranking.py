"""Public-ranking trust boundary and report approval helpers."""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from . import __version__
from .core.models import Mode, Protocol, RankingEvidence
from .core.assessment import CORE_DETECTORS, assess_report
from .core.scoring_policy import SCORING_VERSION
from .model_catalog import is_generic_chat


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

_CORE_DETECTORS = CORE_DETECTORS

from .core.evidence_errors import contains_auth_failure as _contains_auth_failure


def detector_version() -> str:
    """Return a deploy-specific release id when available, package version otherwise."""
    return os.environ.get("GEWU_RELEASE_ID", "").strip() or __version__


def baseline_reference(protocol: str | Protocol, model: str, mode: str | Mode, *, report: Mapping | None = None) -> str:
    """Return a reproducible baseline filename + content hash, or an honest sentinel."""
    from .baselines import baseline_status
    protocol_value = protocol.value if isinstance(protocol, Protocol) else str(protocol)
    mode_value = mode.value if isinstance(mode, Mode) else str(mode)
    try:
        return baseline_status(protocol_value, model, mode_value,
                               report.get("wire_api") if report is not None else None,
                               report=report, root=Path(__file__).resolve().parents[2] / "data/baselines")["reference"]
    except (ValueError, TypeError, OSError):
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


def assess_ranking_eligibility(report: Mapping[str, Any]) -> tuple[bool, str]:
    """Fail closed unless trust metadata and detector evidence are both valid."""
    if "_web_access" in report:
        return False, "private_report"
    if report.get("wire_api") == "responses":
        return False, "responses_capability_only"
    if report.get("wire_api") in {"interactions", "generate_content"}:
        return False, "gemini_native_capability_only"
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
    if report.get("scoring_version") == SCORING_VERSION and evidence.get("baseline_version") == "not_available":
        return False, "uncalibrated_scoring_version"
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
    if not isinstance(report.get("base_url"), str) or not report["base_url"].strip():
        return False, "missing_base_url"
    try:
        endpoint = urlsplit(report["base_url"])
        if (
            endpoint.scheme not in {"http", "https"} or not endpoint.hostname
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
        ):
            return False, "invalid_base_url"
        endpoint.port
    except ValueError:
        return False, "invalid_base_url"
    if not str(report.get("target_model") or "").strip():
        return False, "missing_target_model"
    if protocol == "openai" and is_generic_chat(str(report["target_model"])):
        return False, "basic_compatibility_only"
    try:
        captured_at = datetime.fromisoformat(str(report.get("timestamp") or "").replace("Z", "+00:00"))
        if captured_at.tzinfo is None:
            return False, "invalid_timestamp"
        if captured_at > datetime.now(timezone.utc) + timedelta(minutes=5):
            return False, "future_timestamp"
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
    if not assess_report(report)["score_usable"]:
        return False, "incomplete_evidence"
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

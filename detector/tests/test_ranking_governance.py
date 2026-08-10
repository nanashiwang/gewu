from __future__ import annotations

import json
from pathlib import Path

import pytest

from relay_detector.ranking import (
    assess_ranking_eligibility,
    revoke_report_approval,
    update_report_approval,
)


def _report() -> dict:
    return {
        "base_url": "https://relay.example/v1",
        "protocol": "openai",
        "target_model": "gpt-test",
        "mode": "quick",
        "timestamp": "2026-08-10T00:00:00Z",
        "total_score": 82.0,
        "verdict": "passed",
        "run_error": None,
        "results": [
            {"name": "basic_request", "status": "pass", "details": {}},
            {"name": "protocol", "status": "pass", "details": {}},
        ],
    }


def _approved() -> dict:
    return {
        "schema_version": 1,
        "eligible": True,
        "source": "manual_review",
        "review_status": "approved",
        "detector_version": "test-build",
        "baseline_version": "not_available",
        "reviewed_at": "2026-08-10T01:00:00Z",
        "reviewer": "reviewer-1",
    }


def _unreviewed() -> dict:
    return {
        **_approved(),
        "eligible": False,
        "source": "user_submission",
        "review_status": "unreviewed",
        "reviewed_at": None,
        "reviewer": None,
    }


def test_ranking_fails_closed_for_legacy_and_user_submissions():
    report = _report()
    assert assess_ranking_eligibility(report) == (False, "missing_ranking_evidence")

    report["ranking_evidence"] = {**_approved(), "source": "user_submission"}
    assert assess_ranking_eligibility(report) == (False, "untrusted_source")


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"run_error": "quota exhausted"}, "run_error"),
        ({"results": []}, "missing_results"),
        ({"results": [{"name": "protocol", "status": "pass"}]}, "core_probe_incomplete"),
        ({"results": [{"name": "basic_request", "status": "error", "error": "HTTP 401 bad key"}]}, "authentication_failure"),
        ({"results": [{"name": "basic_request", "status": "fail", "details": {"error": "403 unauthorized"}}]}, "authentication_failure"),
    ],
)
def test_invalid_evidence_never_becomes_rankable(changes: dict, reason: str):
    report = {**_report(), **changes, "ranking_evidence": _approved()}
    assert assess_ranking_eligibility(report) == (False, reason)


def test_valid_approved_evidence_is_rankable():
    report = {**_report(), "ranking_evidence": _approved()}
    assert assess_ranking_eligibility(report) == (True, "eligible")


def test_approval_is_atomic_and_refuses_invalid_report(tmp_path: Path):
    path = tmp_path / "report.json"
    invalid = {
        **_report(),
        "run_error": "invalid run",
        "ranking_evidence": _unreviewed(),
    }
    path.write_text(json.dumps(invalid), encoding="utf-8")

    with pytest.raises(ValueError, match="run_error"):
        update_report_approval(
            path,
            source="manual_review",
            reviewer="reviewer-1",
        )

    assert json.loads(path.read_text(encoding="utf-8")) == invalid


def test_approve_then_revoke_preserves_report_and_audit_state(tmp_path: Path):
    path = tmp_path / "report.json"
    path.write_text(json.dumps({
        **_report(),
        "ranking_evidence": _unreviewed(),
    }), encoding="utf-8")

    approved = update_report_approval(
        path,
        source="site_owner_verified",
        reviewer="reviewer-1",
        verification_reference="dns-txt:ticket-123",
    )
    assert assess_ranking_eligibility(approved) == (True, "eligible")
    assert approved["ranking_evidence"]["source"] == "site_owner_verified"
    assert approved["ranking_evidence"]["detector_version"] == "test-build"
    assert approved["ranking_evidence"]["baseline_version"] == "not_available"

    revoked = revoke_report_approval(
        path,
        reviewer="reviewer-2",
        reason="detector regression under investigation",
    )
    assert assess_ranking_eligibility(revoked) == (False, "not_approved")
    assert revoked["ranking_evidence"]["review_status"] == "rejected"
    assert revoked["ranking_evidence"]["review_note"] == "detector regression under investigation"
    assert revoked["base_url"] == _report()["base_url"]


def test_legacy_report_cannot_be_relabelled_as_current_build(tmp_path: Path):
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(_report()), encoding="utf-8")

    with pytest.raises(ValueError, match="fresh detection"):
        update_report_approval(
            path,
            source="manual_review",
            reviewer="reviewer-1",
        )

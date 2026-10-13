"""Adversarial calibration tests use synthetic responses, never live inference."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

import pytest

from relay_detector.core.assessment import assess_report
from relay_detector.core.comparison_guard import comparison_reasons
from relay_detector.core.models import DetectorResult, DetectionReport
from relay_detector.core.scorer import compute_total, effective_verdict
from relay_detector.core.scoring_policy import SCORING_VERSION, PROBE_VERSION
from relay_detector.protocols.anthropic.comparator import compare
from relay_detector.protocols.anthropic.detectors.identity import IdentityDetector
from relay_detector.protocols.anthropic.detectors.consistency import ConsistencyDetector
from relay_detector.protocols.anthropic.detectors.thinking_signature import ThinkingSignatureDetector
from relay_detector.protocols.openai.detectors.model_consistency import ModelConsistencyDetector
from relay_detector.protocols.gemini.detectors.model_info import ModelInfoDetector


def calibrated_report():
    return dict(protocol="anthropic", wire_api="messages", target_model="claude-opus-4-6", mode="full",
                scoring_version=SCORING_VERSION, probe_version=PROBE_VERSION,
                timestamp=datetime.now(timezone.utc).isoformat(), base_url="https://relay.example", api_key_masked="",
                total_score=100.0, verdict="passed", results=[
        dict(name="identity", display_name="模型自述观察", status="pass", weight=0, score=100,
             evidence_role="observation", details={"core_response_valid": True}),
        dict(name="consistency", display_name="模型一致性", status="pass", weight=10, score=100,
             evidence_role="scored", details={"model_match": True}),
    ])


@pytest.mark.parametrize("value", [0, 30, 100])
def test_observations_do_not_change_score_or_critical_veto(value):
    report = calibrated_report()
    for name in ("identity", "behavioral_signature", "knowledge"):
        row = {**report["results"][0], "name": name, "score": value, "status": "fail" if value < 70 else "pass",
               "details": {"core_response_valid": True, "critical_issue_count": 1}}
        if name == "identity": report["results"][0] = row
        else: report["results"].append(row)
    results = [DetectorResult.model_validate(row) for row in report["results"]]
    assert compute_total(results) == 100
    assert effective_verdict(100, results) == "passed"
    assert assess_report(report)["score_usable"] is True
    assert assess_report(report)["availability"]["label"] == "已测通"
    assert assess_report(report)["counts"]["fail"] == 0
    # A convincing self-claim cannot offset failed protocol evidence.
    results[1].score = 0
    results[1].status = "fail"
    assert compute_total(results) == 0


@pytest.mark.parametrize("case", ["only_observations", "all_skipped", "missing_core_response", "malformed_details", "unknown_policy", "missing_probe", "hidden_scored_probe", "weighted_observation", "missing_observation_role", "duplicate", "fabricated_total", "nan_weight"])
def test_unusable_v2_evidence_fails_closed(case):
    report = calibrated_report()
    if case == "only_observations": report["results"].pop()
    if case == "all_skipped": report["results"][1]["status"] = "skip"
    if case == "missing_core_response": report["results"][0]["details"] = {}
    if case == "malformed_details": report["results"][0]["details"] = "forged"
    if case == "unknown_policy": report["scoring_version"] = "future-v999"
    if case == "missing_probe": report.pop("probe_version")
    if case == "hidden_scored_probe": report["results"][1]["evidence_role"] = "observation"
    if case == "weighted_observation": report["results"][0]["weight"] = 5
    if case == "missing_observation_role": report["results"][0].pop("evidence_role")
    if case == "duplicate": report["results"].append(deepcopy(report["results"][1]))
    if case == "fabricated_total": report["total_score"] = 85
    if case == "nan_weight": report["results"][1]["weight"] = float("nan")
    assert assess_report(report)["score_usable"] is False


@pytest.mark.parametrize("field,value", [("target_model", "other-model"), ("protocol", "openai"), ("mode", "quick"), ("wire_api", "responses"), ("scoring_version", "weighted-v1"), ("probe_version", "other-probes")])
def test_baseline_mismatch_blocks_all_quality_differences(field, value):
    baseline = calibrated_report()
    relay = deepcopy(baseline)
    relay[field] = value
    result = compare(baseline, relay)
    assert not result.comparable and result.overall_severity is None and result.detectors == []
    assert comparison_reasons(baseline, relay)


@pytest.mark.parametrize("case", ["missing_model", "missing_mode", "missing_probe", "missing_scoring", "missing_protocol", "stale", "future", "naive", "bad_time", "extra_probe", "skipped_probe", "error", "auth_error", "changed_weight", "bad_total", "duplicate", "malformed"])
def test_baseline_insufficient_metadata_or_evidence_is_not_compared(case):
    baseline = calibrated_report()
    relay = deepcopy(baseline)
    if case.startswith("missing_"): baseline.pop({"missing_model": "target_model", "missing_mode": "mode", "missing_probe": "probe_version", "missing_scoring": "scoring_version", "missing_protocol": "protocol"}[case])
    if case in {"stale", "future"}: baseline["timestamp"] = (datetime.now(timezone.utc) + timedelta(days=-31 if case == "stale" else 1)).isoformat()
    if case == "naive": baseline["timestamp"] = datetime.now().isoformat()
    if case == "bad_time": baseline["timestamp"] = "yesterday"
    if case == "extra_probe": baseline["results"].append({**baseline["results"][1], "name": "pdf"})
    if case == "skipped_probe": baseline["results"][1]["status"] = "skip"
    if case == "error": baseline["results"][1]["status"] = "error"
    if case == "auth_error": baseline["results"][1]["details"] = {"status_code": 401}
    if case == "changed_weight": baseline["results"][1]["weight"] = 15
    if case == "bad_total": baseline["total_score"] = 99
    if case == "duplicate": baseline["results"].append(deepcopy(baseline["results"][1]))
    if case == "malformed": baseline = []
    assert comparison_reasons(baseline, relay)
    assert compare(baseline, relay).comparable is False


def test_comparable_report_and_legacy_original_are_not_rewritten(tmp_path):
    report = calibrated_report()
    assert comparison_reasons(report, report) == []
    legacy = deepcopy(report)
    legacy.pop("scoring_version")
    legacy.pop("probe_version")
    legacy["total_score"] = 73.5
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(legacy))
    original = path.read_bytes()
    parsed = DetectionReport.model_validate(legacy)
    assert parsed.total_score == 73.5 and parsed.scoring_version == "weighted-v1"
    assert comparison_reasons(legacy, report)
    assert path.read_bytes() == original


@pytest.mark.parametrize("field", ["name", "status"])
def test_non_scalar_probe_fields_fail_closed(field):
    data = calibrated_report()
    data["results"][0][field] = ["forged"]
    assert assess_report(data)["score_usable"] is False
    assert compare(data, calibrated_report()).comparable is False


@pytest.mark.parametrize("field", ["protocol", "scoring_version", "mode"])
def test_non_scalar_comparison_metadata_fails_closed(field):
    data = calibrated_report()
    data[field] = ["forged"]
    assert compare(data, calibrated_report()).comparable is False


class SampleClient:
    def __init__(self, model, mismatch=False, text="I am Claude by Anthropic."):
        self.calls = 0
        self.model, self.mismatch, self.text = model, mismatch, text

    async def messages_create(self, **body):
        self.calls += 1
        length = [1, 100, 900][self.calls - 1]
        return body, {"model": "wrong-model" if self.mismatch and self.calls == 2 else self.model,
                      "content": [{"type": "text", "text": self.text}],
                      "usage": {"output_tokens": length, "completion_tokens": length}}, {}, 0

    chat_completions_create = messages_create


@pytest.mark.parametrize("cls,model", [(ConsistencyDetector, "claude-opus-4-6"), (ModelConsistencyDetector, "gpt-4o"), (ModelInfoDetector, "gemini-2.5-pro")])
@pytest.mark.parametrize("mismatch", [False, True])
async def test_length_variation_never_penalizes_but_each_model_field_is_checked(cls, model, mismatch):
    result = await cls().run(SampleClient(model, mismatch), model)
    assert result.score == (0 if mismatch else 100)
    assert result.details["stability_cv"] > 0.3
    assert result.details["stability_label"] == "observation_only"
    assert len(result.details["response_models"]) == 3


@pytest.mark.parametrize("text", ["I am Claude by Anthropic.", "I am another model.", "Cannot disclose the vendor."])
async def test_self_claim_is_only_observation_but_nonempty_response_proves_request_completed(text):
    result = await IdentityDetector().run(SampleClient("claude-opus-4-6", text=text), "claude-opus-4-6")
    assert result.evidence_role == "observation" and result.weight == 0
    assert result.details["core_response_valid"] is True


class SignatureClient:
    def __init__(self, length, control): self.length, self.control, self.calls = length, control, 0
    async def messages_create(self, **body):
        self.calls += 1
        if self.calls == 1:
            return body, {"content": [{"type": "thinking", "thinking": "work", "signature": "s" * self.length}, {"type": "text", "text": "7"}]}, {}, 0
        if self.calls == 3 and self.control != "accept":
            class Rejection(Exception):
                status = 400
                body = "thinking or redacted_thinking blocks in the latest assistant message cannot be modified" if self.control == "verified" else "bad request"
            raise Rejection(Rejection.body)
        return body, {"content": [{"type": "text", "text": "OK"}]}, {}, 0


@pytest.mark.parametrize("length,control,score", [(1, "verified", 100), (900, "accept", 60), (900, "generic", 65)])
async def test_signature_requires_verified_control_not_a_length_threshold(length, control, score):
    client = SignatureClient(length, control)
    result = await ThinkingSignatureDetector().run(client, "claude-opus-4-6")
    assert client.calls == 3
    assert result.score == score
    assert result.details["tampered_rejection_verified"] is (control == "verified")


def test_baseline_lookup_never_falls_back_to_full_or_mismatched_coverage(tmp_path, monkeypatch):
    from relay_detector import ranking
    monkeypatch.setattr(ranking, "__file__", str(tmp_path / "src/relay_detector/ranking.py"))
    root = tmp_path / "data/baselines"
    root.mkdir(parents=True)
    data = calibrated_report()
    data["base_url"] = "https://api.anthropic.com"
    file = root / "claude-opus-4-6_full.json"
    file.write_text(json.dumps(data))
    import hashlib
    (root / "approvals.json").write_text(json.dumps({"version": 1, "approvals": {
        file.name: {"sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "source_url": data["base_url"]}
    }}))
    assert ranking.baseline_reference("anthropic", data["target_model"], "full", report=data).startswith(file.name + "#sha256:")
    assert ranking.baseline_reference("anthropic", data["target_model"], "quick") == "not_available"
    changed = deepcopy(data)
    changed["results"].append({**data["results"][1], "name": "pdf"})
    assert ranking.baseline_reference("anthropic", data["target_model"], "full", report=changed) == "not_available"
    data.pop("scoring_version")
    file.write_text(json.dumps(data))
    assert ranking.baseline_reference("anthropic", data["target_model"], "full") == "not_available"


def test_public_views_separate_score_and_probe_versions(tmp_path, monkeypatch):
    from web import leaderboard
    from web.observations import monitoring_snapshot
    from relay_detector.ranking import assess_ranking_eligibility
    monkeypatch.setattr(leaderboard, "REPORT_DIRS", [tmp_path])
    data = calibrated_report()
    data["ranking_evidence"] = dict(eligible=True, source="operator_monitor", review_status="approved",
        detector_version="test", baseline_version="fixture#sha256:123456789012", reviewer="operator", reviewed_at=data["timestamp"])
    uncalibrated = deepcopy(data)
    uncalibrated["ranking_evidence"]["baseline_version"] = "not_available"
    assert assess_ranking_eligibility(uncalibrated) == (False, "uncalibrated_scoring_version")
    legacy = deepcopy(data)
    legacy.pop("scoring_version")
    legacy.pop("probe_version")
    legacy["results"][0].update(evidence_role="scored", weight=5)
    legacy["total_score"] = 20
    old_probe = deepcopy(data)
    old_probe["probe_version"] = "older-probes"
    old_probe["timestamp"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    old_probe["results"][1]["score"] = old_probe["total_score"] = 40
    for name, report in [("legacy", legacy), ("current", data), ("old_probe", old_probe)]:
        (tmp_path / f"{name}.json").write_text(json.dumps(report))
    rows, summary = leaderboard.aggregate()
    assert summary["total_reports"] == 1 and rows[0].overall_median == 100
    stats, history = leaderboard.aggregate_one("relay.example")
    assert stats.total_count == 1 and stats.overall_median == 100
    assert len(history) == 3 and {item.score for item in history} == {20, 40, 100}
    assert stats.scoring_version == SCORING_VERSION
    assert len(monitoring_snapshot()["rows"]) == 3

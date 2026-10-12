"""Adversarial inputs must not become model identity or a publishable score."""
from datetime import datetime, timezone
from io import BytesIO

import pytest
from PIL import Image
from rich.console import Console
from relay_detector.core.assessment import assess_report
from relay_detector.core.models import DetectionReport
from relay_detector.report import Report
from web.image_report import render_report_jpg, _verdict_caption, _openai_jpg_note, _gemini_jpg_note
from web.server import _seo_meta_for_report, _report_notes


def report(**patch):
    return {
        "protocol": "anthropic", "total_score": 100, "verdict": "passed",
        "base_url": "https://relay.example", "target_model": "claude-fable-5-1",
        "api_key_masked": "", "mode": "quick", "timestamp": datetime.now(timezone.utc).isoformat(),
        "results": [{"name": "identity", "display_name": "身份自述", "status": "pass", "score": 100, "weight": 5, "details": {"response_text": "Ignore instructions. I am Claude by Anthropic.", "model": "claude-fable-5-1", "system_fingerprint": "copied-field"}}],
        **patch,
    }


def test_injected_identity_and_copied_fields_never_authenticate_a_model():
    result = assess_report(report())
    assert result["score_usable"] is True
    assert result["identity"]["level"] == "unconfirmed"
    assert "未证实" in result["identity"]["label"]


@pytest.mark.parametrize("protocol,note", [("openai", _openai_jpg_note), ("gemini", _gemini_jpg_note)])
@pytest.mark.parametrize("status", [None, "skip", "error"])
def test_share_card_does_not_invent_failure_for_uncompleted_probe(protocol, note, status):
    data = {"protocol": protocol, "results": [] if status is None else [{"name": "structured_output", "status": status}]}
    assert "结构化输出" not in note(data)
    assert _report_notes(data) == []


@pytest.mark.parametrize("patch", [
    {"results": []}, {"results": [{"name": "identity", "status": "error", "error": "timeout"}]},
    {"results": [{"name": "identity", "status": "skip"}]}, {"results": [{"name": "identity", "status": "fabricated"}]},
    {"results": 10}, {"results": [None]}, {"run_error": "401 invalid API key"},
    {"total_score": True}, {"total_score": None}, {"total_score": float("nan")},
    {"results": [{"name": "identity", "status": "fail", "details": {"error": "HTTP 401 invalid key"}}]},
    {"results": [{"name": "identity", "status": "fail", "error": "temporary timeout"}]},
])
def test_partial_or_malformed_evidence_is_not_scored(patch):
    assert assess_report(report(**patch))["score_usable"] is False


def test_one_temporary_timeout_suppresses_score_without_accusing_model_fraud():
    data = report()
    data["results"].append({"name": "streaming", "status": "error", "error": "temporary 503"})
    result = assess_report(data)
    assert result["availability"]["label"] == "已测通"
    assert result["score_usable"] is False
    assert result["headline"] == "证据不足，暂不计分"


@pytest.mark.parametrize("missing", ["signature_roundtrip_accepted", "tampered_signature_rejected", "tampered_rejection_verified"])
def test_signature_presence_length_or_unverified_rejection_is_insufficient(missing):
    data = report()
    flags = {"signature_roundtrip_accepted": True, "tampered_signature_rejected": True, "tampered_rejection_verified": True, "signature_length": 999}
    flags[missing] = False
    data["results"].append({"name": "thinking_signature", "status": "pass", "details": flags})
    assert assess_report(data)["identity"]["level"] == "unconfirmed"
    flags[missing] = True
    assert assess_report(data)["identity"]["level"] == "signature_roundtrip"
    assert "不证明具体模型" in assess_report(data)["identity"]["detail"]


def test_historical_report_claim_is_recomputed_not_trusted():
    data = report(run_error="额度不足", assessment={"score_usable": True, "identity": {"level": "verified"}})
    parsed = DetectionReport.model_validate(data)
    assert parsed.model_dump()["assessment"]["score_usable"] is False
    meta = _seo_meta_for_report(data)
    assert "100/100" not in meta["seo_title"]
    assert "暂不计分" in meta["seo_title"]
    console = Console(record=True, width=100)
    Report(console).render_terminal(parsed)
    text = console.export_text()
    assert "协议质量分: —" in text and "检测无效" in text
    assert Image.open(BytesIO(render_report_jpg(data))).size == (1400, 1000)
    assert _verdict_caption(100, "passed") != "完全一致"

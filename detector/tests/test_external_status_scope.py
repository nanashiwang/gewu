"""Adversarial boundaries: no model traffic, untrusted status is never evidence."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from relay_detector.baselines import baseline_status, inspect_baseline
from tests.test_scoring_calibration import calibrated_report
from web import provider_status as ps
from web.detection_scope import detection_scope
from web.server import app

NOW = datetime(2026, 10, 14, tzinfo=timezone.utc)


def feed():
    return {"schema_version": "1.0", "generated_at": NOW.isoformat(), "services": [
        {"service": source["service"], "time": NOW.isoformat(), "level": "ok", "source_url": source["url"], "error": None}
        for source in ps.SOURCES.values()]}


@pytest.mark.parametrize("failure", ["stale", "future", "naive", "unknown_schema", "malformed", "rows_invalid", "missing", "duplicate", "row_stale", "row_error", "url_injection", "url_object", "bad_level"])
def test_external_failure_is_unknown_never_outage(failure):
    data = feed()
    if failure == "stale": data["generated_at"] = (NOW - timedelta(minutes=31)).isoformat()
    if failure == "future": data["generated_at"] = (NOW + timedelta(seconds=1)).isoformat()
    if failure == "naive": data["generated_at"] = "2026-10-14T00:00:00"
    if failure == "unknown_schema": data["schema_version"] = "2.0"
    if failure == "rows_invalid": data["services"] = {}
    if failure == "missing": data["services"] = []
    if failure == "duplicate": data["services"].append(deepcopy(data["services"][0]))
    if failure == "row_stale": data["services"][0]["time"] = (NOW - timedelta(days=1)).isoformat()
    if failure == "row_error": data["services"][0]["error"] = "network error with private details"
    if failure == "url_injection": data["services"][0]["source_url"] = "https://attacker.example/?secret=x"
    if failure == "url_object": data["services"][0]["source_url"] = {"url": "https://status.openai.com/"}
    if failure == "bad_level": data["services"][0]["level"] = {"ok": True}
    if failure == "malformed": data = []
    snapshot = ps.status_snapshot(data, now=NOW)
    row = snapshot["providers"]["openai"]
    assert row["state"] == "unknown"
    assert row["checked_at"] is None
    assert "attacker" not in json.dumps(snapshot)
    assert "private details" not in json.dumps(snapshot)


def test_status_retains_scope_and_only_reviewed_links():
    data = feed()
    data["services"][0].update(level="warn", active_incidents=[{"name": "<script>"}], latest_incident_link="javascript:alert(1)")
    result = ps.status_snapshot(data, now=NOW)
    assert result["providers"]["openai"]["state"] == "warn"
    assert "Vertex" in result["providers"]["google"]["scope"]
    assert "raw_score" not in json.dumps(result)
    assert "javascript:" not in json.dumps(result)
    assert "<script>" not in json.dumps(result)


def test_status_cache_bounds_reads_and_caches_failure(monkeypatch):
    calls = []
    def failed():
        calls.append(True)
        raise httpx.ConnectError("network unavailable")
    monkeypatch.setattr(ps, "_cached_at", float("-inf"))
    monkeypatch.setattr(ps, "_fetch", failed)
    assert ps.cached_status()["providers"]["openai"]["state"] == "unknown"
    ps.cached_status()
    assert len(calls) == 1


def test_busy_status_fetch_does_not_block_other_visitors(monkeypatch):
    monkeypatch.setattr(ps, "_cached", None)
    with ps._lock:
        assert ps.cached_status()["providers"]["openai"]["state"] == "unknown"


@pytest.mark.parametrize("protocol,model,wire,mode,names", [
    ("openai", "gpt-6-luna", "responses", "quick", {"basic_request", "responses_stream"}),
    ("openai", "gpt-6-luna", "responses", "full", {"basic_request", "responses_stream", "responses_schema", "responses_tools"}),
    ("gemini", "gemini-3.8-flash", "interactions", "quick", {"basic_request", "gemini_stream"}),
    ("gemini", "gemini-3.8-flash", "generate_content", "standard", {"basic_request", "gemini_stream", "gemini_schema"}),
    ("openai", "deepseek-v4-pro", "chat_completions", "quick", {"basic_request"}),
    ("openai", "deepseek-v4-pro", "chat_completions", "full", {"basic_request", "integrity"}),
])
def test_scope_uses_actual_runner_selection_without_client(monkeypatch, protocol, model, wire, mode, names):
    def no_network(*args, **kwargs):
        pytest.fail("scope must not construct a network client")
    monkeypatch.setattr(httpx, "AsyncClient", no_network)
    data = detection_scope(protocol, model, mode, wire)
    assert {item["name"] for item in data["checks"]} == names


def test_scope_long_context_and_observations():
    default = detection_scope("anthropic", "claude-opus-4-6", "full")
    extra = detection_scope("anthropic", "claude-opus-4-6", "full", include_long_context=True)
    assert "long_context" not in {d["name"] for d in default["checks"]}
    assert "long_context" in {d["name"] for d in extra["checks"]}
    assert all(d["observation"] for d in default["checks"] if d["name"] in {"identity", "knowledge", "behavioral_signature"})


@pytest.fixture
def approved_baseline(tmp_path):
    data = calibrated_report()
    data["base_url"] = "https://api.anthropic.com"
    path = tmp_path / (data["target_model"] + "_full.json")
    def save(approve=True):
        path.write_text(json.dumps(data))
        if approve:
            (tmp_path / "approvals.json").write_text(json.dumps({"version": 1, "approvals": {
                path.name: {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "source_url": data["base_url"]}
            }}))
    save()
    return tmp_path, path, data, save


@pytest.mark.parametrize("change", ["none", "no_approval", "hash_changed", "fake_origin", "expired", "wire", "malformed", "self_approved"])
def test_baseline_needs_independent_review_and_compatible_evidence(approved_baseline, change):
    root, path, data, save = approved_baseline
    if change == "no_approval": (root / "approvals.json").unlink()
    if change == "hash_changed": data["summary"] = "tampered"; save(False)
    if change == "fake_origin": data["base_url"] = "https://api.anthropic.com.attacker.example"; save()
    if change == "expired": data["timestamp"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(); save()
    if change == "wire": data["wire_api"] = "responses"; save()
    if change == "malformed": path.write_text("[]")
    if change == "self_approved":
        (root / "approvals.json").unlink()
        data["approved"] = True
        save(False)
    result = baseline_status("anthropic", data["target_model"], "full", root=root)
    assert (result["state"] == "available") is (change == "none")
    assert (result["reference"] != "not_available") is (change == "none")


def test_baseline_paths_and_actual_coverage_fail_closed(approved_baseline):
    root, path, data, _ = approved_baseline
    assert baseline_status("anthropic", "../../secrets", "full", root=root)["state"] == "missing"
    assert baseline_status("anthropic", data["target_model"], "quick", root=root)["state"] == "missing"
    altered = deepcopy(data)
    altered["results"].append({**data["results"][1], "name": "pdf"})
    assert baseline_status("anthropic", data["target_model"], "full", report=altered, root=root)["state"] == "incompatible"


def test_public_routes_have_boundaries_and_never_require_external_state(monkeypatch):
    def no_network():
        pytest.fail("page render must not wait for an external source")
    monkeypatch.setattr(ps, "_fetch", no_network)
    client = TestClient(app)
    response = client.get("/sources")
    assert response.status_code == 200
    assert "OpenRouter" in response.text and "外部状态不进入检测分数" in response.text
    assert "当前聚合源未覆盖：" in response.text
    response = client.get("/api/detection-scope", params={"protocol": "openai", "model": "gpt-6-luna", "wire_api": "responses"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    for invalid in [{"protocol": "../../x", "model": "gpt-x"}, {"protocol": "openai", "model": "x", "wire_api": "messages"}, {"protocol": "gemini", "model": "x", "wire_api": "interactions", "include_long_context": True}]:
        assert client.get("/api/detection-scope", params=invalid).status_code == 422


def test_cli_explicit_report_cannot_claim_official_source(approved_baseline):
    from typer.testing import CliRunner
    from relay_detector.cli import app as cli
    root, path, data, _ = approved_baseline
    relay = root / "relay.json"
    relay.write_text(json.dumps(data))
    (root / "approvals.json").unlink()
    result = CliRunner().invoke(cli, ["compare", str(relay), "--baseline", str(path), "--baseline-dir", str(root), "--output", str(root / "diff.json")])
    assert result.exit_code == 0, result.output
    output = json.loads((root / "diff.json").read_text())
    assert output["comparable"] is False
    assert output["detectors"] == [] and output["overall_severity"] is None
    assert any("独立来源审核" in reason for reason in output["reasons"])

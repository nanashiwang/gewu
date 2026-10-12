"""Synthetic-only monitor acceptance: no upstream credits or worker processes."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from relay_detector import cli
from relay_detector.core.detectors_base import ActiveDetector
from relay_detector.core.models import DetectorResult, ExecutionConfig, Mode, DetectionReport
from relay_detector.core.runner import Runner
from relay_detector.monitor_health import (
    classify_report, health_snapshot, load_states, monitor_lock, next_state, save_state,
)
from web import server, jobs, monitor_health as health_cache


def report(stamp=None, **changes):
    return {
        "protocol": "openai", "target_model": "gpt-synthetic", "mode": "quick",
        "base_url": "https://relay.example/private-path", "api_key_masked": "[REDACTED]",
        "timestamp": (stamp or datetime.now(timezone.utc)).isoformat(), "total_score": 40,
        "verdict": "failed", "results": [{"name": "basic_request", "status": "fail", "score": 40,
            "weight": 100, "display_name": "基础请求"}],
        "ranking_evidence": {"source": "operator_monitor", "review_status": "approved",
            "verification_reference": "private-target", "detector_version": "test", "baseline_version": "not_available"},
        **changes,
    }


def save_report(root, name, data):
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"monitor-{name}.json"
    path.write_text(json.dumps(data))
    return path


@pytest.mark.parametrize("protocol,model", [("anthropic", "claude-haiku-4-5"), ("openai", "gpt-4o"), ("gemini", "gemini-2.5-flash")])
@pytest.mark.parametrize("status", [401, 403])
def test_auth_failure_makes_one_request_and_survives_next_invocation(tmp_path, monkeypatch, protocol, model, status):
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    monkeypatch.setenv("TEST_MONITOR_KEY", "synthetic-secret-not-a-real-key")
    args = ["monitor-once", "--target-id", "acceptance", "--base-url", "https://relay.example",
            "--model", model, "--protocol", protocol, "--mode", "full", "--api-key-env", "TEST_MONITOR_KEY",
            "--output-root", str(tmp_path)]
    with respx.mock(assert_all_called=False) as mock:
        route = mock.route().mock(return_value=httpx.Response(status, json={"error": {"message": "invalid api key"}}))
        failed = CliRunner().invoke(cli.app, args)
        assert failed.exit_code == 1, failed.output
        assert route.call_count == 1, "auth failure must stop remaining probes and TTFT"
        assert len(list(tmp_path.glob("*/*.json"))) == 2  # report + health state
        state = health_snapshot(tmp_path)["targets"][0]
        assert state["failure_kind"] == "authentication"
        assert state["consecutive_failures"] == 1 and state["last_valid_at"] is None
        cooled = CliRunner().invoke(cli.app, args)
        assert cooled.exit_code == 75, cooled.output
        assert route.call_count == 1
        assert health_snapshot(tmp_path)["targets"][0]["consecutive_failures"] == 1
    persisted = (tmp_path / ".monitor_health/acceptance.json").read_text()
    assert "synthetic-secret" not in persisted and "invalid api key" not in persisted


def test_history_bootstraps_failures_without_rewriting_reports(tmp_path):
    now = datetime.now(timezone.utc)
    good = save_report(tmp_path, "good", report(now - timedelta(hours=3)))
    auth = report(now - timedelta(hours=2), results=[{"name": "basic_request", "status": "error", "error": "HTTP 401 secret-echo"}])
    bad = save_report(tmp_path, "bad", auth)
    before = {p: p.read_bytes() for p in (good, bad)}
    snapshot = health_snapshot(tmp_path, now)
    row = snapshot["targets"][0]
    assert row["last_valid_at"] == report(now - timedelta(hours=3))["timestamp"]
    assert row["consecutive_failures"] == 1 and row["cooling"]
    assert "secret-echo" not in json.dumps(snapshot) and "private-path" not in json.dumps(snapshot)
    assert {p: p.read_bytes() for p in before} == before
    assert not (tmp_path / ".monitor_health").exists()


def test_unreviewed_and_user_reports_cannot_manipulate_health(tmp_path):
    for i, source in enumerate(("user_submission", "site_owner_verified", "manual_review")):
        save_report(tmp_path, str(i), report(ranking_evidence={"source": source, "review_status": "approved", "verification_reference": "spoofed"}))
    save_report(tmp_path, "unreviewed", report(ranking_evidence={"source": "operator_monitor", "review_status": "unreviewed", "verification_reference": "spoofed"}))
    save_report(tmp_path, "future", report(datetime.now(timezone.utc) + timedelta(days=1)))
    assert health_snapshot(tmp_path)["targets"] == []


def test_backoff_caps_and_valid_low_score_clears_failures(tmp_path):
    now = datetime.now(timezone.utc)
    state = {}
    for i in range(12):
        state = next_state(state, target_id="test", protocol="openai", model="gpt-test", mode="quick", kind="authentication", observed_at=now)
    assert state["next_attempt_at"] == (now + timedelta(days=1)).isoformat()
    assert classify_report(report()) == "valid", "low quality is not a monitor execution failure"
    state = next_state(state, target_id="test", protocol="openai", model="gpt-test", mode="quick", kind="valid", observed_at=now)
    save_state(tmp_path, state)
    loaded = load_states(tmp_path)[0]["test"]
    assert loaded["consecutive_failures"] == 0 and loaded["next_attempt_at"] is None
    assert loaded["last_valid_at"] == now.isoformat()
    assert (tmp_path / ".monitor_health/test.json").stat().st_mode & 0o777 == 0o600


def test_lock_prevents_duplicate_invocations_and_releases_on_exit(tmp_path, monkeypatch):
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    args = ["monitor-once", "--target-id", "test", "--base-url", "https://relay.example", "--model", "gpt-test", "--output-root", str(tmp_path)]
    with monitor_lock(tmp_path, "test"):
        result = CliRunner().invoke(cli.app, args)
        assert result.exit_code == 75
    with monitor_lock(tmp_path, "test"):
        pass


def test_missing_credentials_records_configuration_failure(tmp_path, monkeypatch):
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    result = CliRunner().invoke(cli.app, ["monitor-once", "--target-id", "test", "--base-url", "https://relay.example", "--model", "gpt-test", "--output-root", str(tmp_path)])
    assert result.exit_code == 2
    assert health_snapshot(tmp_path)["targets"][0]["failure_kind"] == "configuration"


def test_explicit_recovery_resets_cooldown_without_disguising_low_score(tmp_path, monkeypatch):
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    monkeypatch.setenv("TEST_MONITOR_KEY", "synthetic-secret")
    state = next_state({}, target_id="test", protocol="openai", model="gpt-test", mode="quick", kind="authentication", observed_at=datetime.now(timezone.utc))
    save_state(tmp_path, state)
    calls = []
    async def fake(*args, **kwargs):
        calls.append(True)
        return DetectionReport.model_validate(report())
    monkeypatch.setattr(cli, "_run_detect", fake)
    args = ["monitor-once", "--target-id", "test", "--base-url", "https://relay.example", "--model", "gpt-test", "--api-key-env", "TEST_MONITOR_KEY", "--output-root", str(tmp_path), "--retry-now"]
    result = CliRunner().invoke(cli.app, args)
    assert result.exit_code == 0, result.output
    assert calls == [True]
    assert health_snapshot(tmp_path)["targets"][0]["failure_kind"] == "valid"


def test_no_false_auth_from_model_response_and_no_symlink_write(tmp_path):
    data = report()
    data["results"][0]["details"] = {"response_text": "401 invalid api key"}
    assert classify_report(data) == "valid"
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / ".monitor_health").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        with monitor_lock(tmp_path, "test"):
            pass
    assert list(outside.iterdir()) == []


def test_corrupt_state_blocks_automatic_paid_work(tmp_path, monkeypatch):
    directory = tmp_path / ".monitor_health"
    directory.mkdir()
    (directory / "test.json").write_text('{"broken":true}')
    async def forbidden(*args, **kwargs):
        pytest.fail("corrupt health state must not permit automatic upstream calls")
    monkeypatch.setattr(cli, "_run_detect", forbidden)
    result = CliRunner().invoke(cli.app, ["monitor-once", "--target-id", "test", "--base-url", "https://relay.example", "--model", "gpt-test", "--output-root", str(tmp_path)])
    assert result.exit_code == 2


def test_model_change_does_not_inherit_valid_history():
    now = datetime.now(timezone.utc)
    state = next_state({}, target_id="test", protocol="openai", model="gpt-old", mode="quick", kind="valid", observed_at=now)
    changed = next_state(state, target_id="test", protocol="openai", model="gpt-new", mode="quick", kind="authentication", observed_at=now)
    assert changed["last_valid_at"] is None and changed["consecutive_failures"] == 1


class Probe(ActiveDetector):
    def __init__(self, name, execute):
        self.name, self.display_name, self.execute = name, name, execute
    async def run(self, client, model):
        return await self.execute()


@pytest.mark.asyncio
async def test_late_auth_failure_cancels_siblings_and_leaves_no_tasks():
    baseline_tasks = asyncio.all_tasks()
    started, ended = asyncio.Event(), asyncio.Event()
    def result(name, error=None):
        return DetectorResult(name=name, display_name=name, status="error" if error else "pass", score=0 if error else 100, weight=1, error=error)
    async def core(): return result("basic_request")
    async def rejected():
        await started.wait()
        return result("tools", "HTTP 403 forbidden")
    async def waiting():
        started.set()
        try: await asyncio.Event().wait()
        finally: ended.set()
    async def ttft(*_): pytest.fail("must not start TTFT after auth failure")
    probes = [Probe("basic_request", core), Probe("tools", rejected), Probe("stream", waiting)]
    runner = Runner(None, probes, ExecutionConfig(stop_on_auth_failure=True), mode_detectors={Mode.QUICK: {p.name for p in probes}}, throttled_client_factory=lambda *_: SimpleNamespace(), ttft_probe=ttft)
    outcome = await runner.run("synthetic")
    assert ended.is_set()
    assert next(r for r in outcome.results if r.name == "stream").details["skip_reason"] == "authentication-blocked"
    assert asyncio.all_tasks() == baseline_tasks


def test_health_api_is_private_and_public_summary_has_no_target_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "JOBS_DIR", tmp_path)
    monkeypatch.setattr(health_cache, "_cached", None)
    monkeypatch.setattr(server, "_monitor_cache", {"rows": [], "models": []})
    monkeypatch.setattr(server, "_monitor_cached_at", __import__('time').monotonic())
    state = next_state({}, target_id="private-target", protocol="openai", model="private-model", mode="quick", kind="authentication", observed_at=datetime.now(timezone.utc))
    save_state(tmp_path, state)
    client = TestClient(server.app)
    path = "/api/status/monitor-health/summary"
    monkeypatch.delenv("GEWU_INTERNAL_API_TOKEN", raising=False)
    assert client.get(path).status_code == 404
    monkeypatch.setenv("GEWU_INTERNAL_API_TOKEN", "internal-synthetic-token")
    for suffix, headers in [("", {}), ("?token=internal-synthetic-token", {}), ("", {"X-Gewu-Internal-Token": "wrong"})]:
        assert client.get(path + suffix, headers=headers).status_code == 404
    private = client.get(path, headers={"X-Gewu-Internal-Token": "internal-synthetic-token"})
    assert private.status_code == 200 and private.headers["cache-control"] == "no-store"
    assert private.json()["targets"][0]["target_id"] == "private-target"
    public = client.get("/leaderboard/monitor")
    assert public.status_code == 200 and "格物采样状态" in public.text
    assert "private-target" not in public.text and "private-model" not in public.text
    assert "internal-synthetic-token" not in public.text

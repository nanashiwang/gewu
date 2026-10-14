"""Synthetic official fixtures only; no provider traffic or real approvals."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from relay_detector.baselines import baseline_status, official_comparison
from relay_detector.cli import app
from relay_detector.official_baselines import BudgetTransport, Limits, approve, collect, collection_plan
from tests.test_scoring_calibration import calibrated_report


def plan(protocol="openai", wire="responses", limits=None):
    return collection_plan(protocol, {"openai": "gpt-4.1", "anthropic": "claude-opus-4-6", "gemini": "gemini-2.5-flash"}[protocol],
                           "quick", wire, limits or Limits())


def request(p, **changes):
    wire, model, root = p["wire_api"], p["model"], p["source_url"]
    bodies = {
        "messages": ("/v1/messages", {"model": model, "max_tokens": 16}),
        "chat_completions": ("/chat/completions", {"model": model, "max_completion_tokens": 16}),
        "responses": ("/responses", {"model": model, "max_output_tokens": 16, "store": False}),
        "interactions": ("/interactions", {"model": model, "generation_config": {"max_output_tokens": 16}, "store": False}),
        "generate_content": (f"/models/{model}:generateContent", {"generationConfig": {"maxOutputTokens": 16, "candidateCount": 1}}),
    }
    path, body = bodies[wire]
    body.update(changes)
    return httpx.Request("POST", root + path, json=body)


@pytest.mark.parametrize("protocol,wire", [("anthropic", "messages"), ("openai", "chat_completions"), ("openai", "responses"), ("gemini", "chat_completions"), ("gemini", "interactions"), ("gemini", "generate_content")])
@pytest.mark.asyncio
async def test_all_interfaces_reserve_budget(protocol, wire):
    p = plan(protocol, wire)
    sent = []
    transport = BudgetTransport(p, httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(200, json={})))
    await transport.handle_async_request(request(p))
    assert len(sent) == transport.requests == 1
    assert transport.output_tokens == 16 and transport.payload_bytes > 0
    assert p["checks"] and p["config"]["allow_reference_collection"] is False
    await transport.aclose()


@pytest.mark.parametrize("case", ["origin", "model", "store", "tokens", "candidate", "tool", "requests", "output", "payload"])
@pytest.mark.asyncio
async def test_block_before_send(case):
    limits = Limits(1, 16, 10000)
    p = plan(limits=limits)
    sent = []
    transport = BudgetTransport(p, httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(200, json={})))
    req = request(p)
    if case == "origin": req = httpx.Request("POST", "https://api.openai.com.evil.example/v1/responses", json={})
    if case == "model": req = request(p, model="different")
    if case == "store": req = request(p, store=True)
    if case == "tokens": req = request(p, max_output_tokens=True)
    if case == "candidate": req = request(p, n=2)
    if case == "tool": req = request(p, tools=[{"type": "web_search"}])
    if case == "output": req = request(p, max_output_tokens=17)
    if case == "payload": req = request(p, input="x" * 10001)
    if case == "requests":
        await transport.handle_async_request(req)
        sent.clear()
    with pytest.raises(ValueError):
        await transport.handle_async_request(req)
    with pytest.raises(ValueError):
        await transport.handle_async_request(request(p))
    assert sent == [] and transport.halted
    await transport.aclose()


@pytest.mark.parametrize("status", [302, 401, 403, 429, 500])
@pytest.mark.asyncio
async def test_http_failure_halts_every_followup(status):
    p = plan()
    sent = []
    t = BudgetTransport(p, httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(status, json={})))
    for _ in range(2):
        with pytest.raises(ValueError):
            await t.handle_async_request(request(p))
    assert len(sent) == t.requests == 1
    await t.aclose()


@pytest.mark.asyncio
async def test_network_failure_no_retry_and_negative_control_allowed():
    p = plan()
    def error(r):
        raise httpx.ConnectError("secret upstream text", request=r)
    t = BudgetTransport(p, httpx.MockTransport(error))
    with pytest.raises(ValueError, match="网络失败"):
        await t.handle_async_request(request(p))
    with pytest.raises(ValueError):
        await t.handle_async_request(request(p))
    assert t.requests == 1
    await t.aclose()
    t = BudgetTransport(p, httpx.MockTransport(lambda r: httpx.Response(400)))
    assert (await t.handle_async_request(request(p))).status_code == 400
    assert t.halted is None
    await t.aclose()


def test_dry_run_no_credentials_no_network_no_files(monkeypatch, tmp_path):
    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda *a, **k: pytest.fail("network constructed"))
    dest = tmp_path / "candidates"
    result = CliRunner().invoke(app, ["baseline-collect", "--protocol", "openai", "--model", "gpt-4.1", "--wire-api", "responses", "--candidate-dir", str(dest)])
    assert result.exit_code == 0, result.output
    assert '"execute": false' in result.output and not dest.exists()
    monkeypatch.delenv("GEWU_OFFICIAL_OPENAI_KEY", raising=False)
    result = CliRunner().invoke(app, ["baseline-collect", "--protocol", "openai", "--model", "gpt-4.1", "--execute", "--candidate-dir", str(dest)])
    assert result.exit_code == 2 and not dest.exists()


def candidate(tmp_path):
    p = plan("anthropic", "messages")
    report = calibrated_report()
    report.update(mode=p["mode"], base_url=p["source_url"])
    for name in p["checks"]:
        if name not in {row["name"] for row in report["results"]}:
            report["results"].append(dict(name=name, display_name=name, status="pass", score=100, weight=1, evidence_role="scored", details={}))
    data = {"version": 1, "plan": p, "collection": {"requests": 4, "reserved_output_tokens": 100, "payload_bytes": 1000, "halted": None}, "report": report}
    path = tmp_path / "candidate.json"
    return data, path


def save(path, data):
    path.write_text(json.dumps(data))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_approval_preserves_history_hash_binds_and_enables_comparison(tmp_path):
    data, path = candidate(tmp_path)
    digest = save(path, data)
    root = tmp_path / "published"
    result = approve(path, digest, root)
    original = (root / result["file"]).read_bytes()
    assert (root / result["file"]).stat().st_mode & 0o777 == 0o644
    assert (root / result["file"]).parent.stat().st_mode & 0o777 == 0o755
    assert (root / "approvals.json").stat().st_mode & 0o777 == 0o644
    relay = deepcopy(data["report"])
    match = baseline_status("anthropic", relay["target_model"], "quick", "messages", report=relay, root=root)
    assert match["state"] == "available" and "/messages/" in match["file"]
    comparison = official_comparison(relay, root)
    assert comparison["state"] == "available" and all(row["delta"] == 0 for row in comparison["rows"])
    assert "identity" not in {row["name"] for row in comparison["rows"]}
    with pytest.raises(FileExistsError):
        approve(path, digest, root)
    assert (root / result["file"]).read_bytes() == original
    (root / result["file"]).write_bytes(original + b" ")
    assert official_comparison(relay, root)["rows"] == []


@pytest.mark.parametrize("case", ["digest", "stale", "halted", "fake_origin", "wire", "missing_probe", "version", "partial", "symlink", "budget"])
def test_bad_candidates_cannot_publish(tmp_path, case):
    data, path = candidate(tmp_path)
    root = tmp_path / "published"
    if case == "stale": data["report"]["timestamp"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    if case == "halted": data["collection"]["halted"] = "budget exhausted"
    if case == "fake_origin": data["report"]["base_url"] = "https://evil.example"
    if case == "wire": data["report"]["wire_api"] = "responses"
    if case == "missing_probe": data["report"]["results"].pop()
    if case == "version": data["report"]["probe_version"] = "future"
    if case == "partial": data["report"]["results"][1]["status"] = "error"
    if case == "budget": data["collection"]["requests"] = 5000
    if case == "symlink":
        other = tmp_path / "other"
        other.mkdir()
        root.symlink_to(other, target_is_directory=True)
    digest = save(path, data)
    with pytest.raises((ValueError, OSError)):
        approve(path, "0" * 64 if case == "digest" else digest, root)
    assert not (root / "approvals.json").exists()


def test_manifest_symlink_and_explicit_ack_required(tmp_path):
    data, path = candidate(tmp_path)
    digest = save(path, data)
    root = tmp_path / "published"
    root.mkdir()
    other = tmp_path / "other.json"
    other.write_text('{"version":1,"approvals":{}}')
    (root / "approvals.json").symlink_to(other)
    with pytest.raises(ValueError):
        approve(path, digest, root)
    result = CliRunner().invoke(app, ["baseline-approve", str(path), "--sha256", digest])
    assert result.exit_code == 2 and "人工核实" in result.output


def test_cross_wire_samples_do_not_collide(tmp_path):
    manifest = {"version": 1, "approvals": {}}
    for wire in ("chat_completions", "responses"):
        data = calibrated_report()
        data.update(protocol="openai", target_model="gpt-4.1", wire_api=wire, base_url="https://api.openai.com/v1")
        data["results"] = [dict(name="basic_request", display_name="基础请求", status="pass", score=100, weight=1, evidence_role="scored", details={"core_response_valid": True})]
        path = tmp_path / "openai" / wire / "gpt-4.1_full_20261015_example.json"
        path.parent.mkdir(parents=True)
        digest = save(path, data)
        manifest["approvals"][path.relative_to(tmp_path).as_posix()] = {"sha256": digest, "source_url": data["base_url"]}
    (tmp_path / "approvals.json").write_text(json.dumps(manifest))
    for wire in ("chat_completions", "responses"):
        result = baseline_status("openai", "gpt-4.1", "full", wire, root=tmp_path)
        assert result["state"] == "available", result
        assert f"/{wire}/" in result["file"]


@pytest.mark.asyncio
async def test_extra_reference_collection_disabled(monkeypatch):
    from relay_detector.protocols.openai.detectors import token_billing as tb
    monkeypatch.setattr(tb, "_read_reference_cache", lambda: {})
    monkeypatch.setattr(tb, "_openai_api_key", lambda: pytest.fail("must not load extra key"))
    assert await tb._get_reference("gpt-4.1", allow_collection=False) is None


def test_comparison_markup_escapes_labels():
    from web.server import templates
    template = templates.env.get_template("result.html")
    # Render just the independent comparison section with hostile display text.
    text = Path(template.filename).read_text()
    section = text[text.index("{% if official_comparison %}"):text.index("{% if report.run_error %}")]
    rendered = templates.env.from_string(section).render(official_comparison={"state": "available", "rows": [
        {"label": "<script>alert(1)</script>", "official_score": 100, "current_score": 90, "delta": -10,
         "official_status": "pass", "current_status": "fail"}]})
    assert "<script>" not in rendered and "&lt;script&gt;" in rendered and "-10.0" in rendered


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,count", [("quick", 2), ("standard", 3), ("full", 5)])
async def test_real_collection_pipeline_and_review_with_mock_transport(monkeypatch, tmp_path, mode, count):
    import asyncio
    from tests import test_responses_detection as fixtures
    p = collection_plan("openai", "gpt-4.1", mode, "responses", Limits())
    monkeypatch.setattr(fixtures, "BASE", p["source_url"])
    monkeypatch.setattr(fixtures, "MODEL", p["model"])
    upstream = fixtures.Upstream()
    monkeypatch.setenv("GEWU_OFFICIAL_OPENAI_KEY", "synthetic-secret-not-for-publishing")
    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(upstream))
    before = set(asyncio.all_tasks())
    result = await collect(p, tmp_path / "private")
    assert set(asyncio.all_tasks()) == before
    assert result["eligible_for_review"], result
    assert len(upstream.requests) == result["requests"] == count
    path = tmp_path / "private" / result["candidate"]
    assert "synthetic-secret" not in path.read_text() and '"api_key_masked": "[redacted]"' in path.read_text()
    assert path.stat().st_mode & 0o777 == 0o600
    root = tmp_path / "published"
    approve(path, result["sha256"], root)
    assert baseline_status("openai", p["model"], mode, "responses", root=root)["state"] == "available"


@pytest.mark.asyncio
async def test_stream_interruption_blocks_followups():
    p = plan()
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: partial\n"
            raise httpx.ReadError("must not leak provider text")
    t = BudgetTransport(p, httpx.MockTransport(lambda r: httpx.Response(200, stream=Broken())))
    response = await t.handle_async_request(request(p))
    with pytest.raises(ValueError, match="响应中断"):
        await response.aread()
    await response.aclose()
    with pytest.raises(ValueError):
        await t.handle_async_request(request(p))
    assert t.requests == 1
    await t.aclose()

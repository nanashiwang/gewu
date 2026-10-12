"""Synthetic native acceptance: no credits, hosts, tools, or background workers."""
import asyncio
from copy import deepcopy
import json
import re

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from relay_detector.core.models import ExecutionConfig, Mode
from relay_detector.protocols.gemini import build_detectors, build_runner, make_client
from relay_detector.protocols.gemini.native import NativeSession, model_id
from relay_detector.ranking import assess_ranking_eligibility
from web import jobs, server

BASE = "https://relay.example/custom/v1beta"
APIS = ["interactions", "generate_content"]


def response(api, text="ok", call=None):
    if api == "interactions":
        steps = [{"type": "model_output", "content": [{"type": "text", "text": text}]}]
        if call:
            steps = [{"type": "thought", "signature": "private-signature-fixture"},
                     {"type": "function_call", "id": "call_fixture", "name": "gewu_echo", "arguments": call}]
        return {"object": "interaction", "id": "interaction_fixture", "status": "requires_action" if call else "completed", "steps": steps,
                "usage": {"total_input_tokens": 11, "total_output_tokens": 90, "total_thought_tokens": 245, "total_tokens": 346}}
    parts = [{"text": text}]
    if call:
        parts = [{"thoughtSignature": "private-signature-fixture", "functionCall": {"name": "gewu_echo", "args": call}}]
    return {"responseId": "response_fixture", "candidates": [{"index": 0, "content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 90, "thoughtsTokenCount": 245, "totalTokenCount": 346}}


def stream_events(api, payload):
    if api == "interactions":
        text = payload["steps"][0]["content"][0]["text"]
        return [
            {"event_type": "interaction.created", "interaction": {"id": payload["id"]}},
            {"event_type": "step.start", "index": 0, "step": {"type": "model_output"}},
            {"event_type": "step.delta", "index": 0, "delta": {"type": "text", "text": text}},
            {"event_type": "step.stop", "index": 0},
            {"event_type": "interaction.completed", "interaction": {k: v for k, v in payload.items() if k != "steps"}},
        ]
    start = deepcopy(payload)
    start["candidates"][0].pop("finishReason")
    start.pop("usageMetadata")
    finish = deepcopy(payload)
    finish["candidates"][0]["content"]["parts"] = []
    return [start, finish]


class Upstream:
    def __init__(self, api, mutate=None):
        self.api, self.mutate, self.requests = api, mutate or (lambda _, x: x), []
        self.history = None

    def __call__(self, req):
        body = json.loads(req.content)
        self.requests.append(body)
        assert req.headers["x-goog-api-key"] == "synthetic-key"
        assert "authorization" not in req.headers
        assert body["store"] is False
        assert "previous_interaction_id" not in body
        if self.api == "interactions":
            assert str(req.url) == BASE + "/interactions"
            assert body["model"] == "gemini-fixture"
            assert body["generation_config"]["max_output_tokens"] == 4096
            stream = body.get("stream", False)
            content = body["input"]
            prompt = content if isinstance(content, str) else content[0]["content"]
            schema = body.get("response_format")
            returned = isinstance(content, list) and content[-1].get("type") == "function_result"
        else:
            assert str(req.url) in {BASE + "/models/gemini-fixture:generateContent", BASE + "/models/gemini-fixture:streamGenerateContent?alt=sse"}
            assert body["generationConfig"]["maxOutputTokens"] == 4096
            stream = "streamGenerateContent" in str(req.url)
            content = body["contents"]
            prompt = content[0]["parts"][0]["text"]
            schema = body["generationConfig"].get("responseJsonSchema")
            returned = "functionResponse" in content[-1]["parts"][0]
        if returned:
            kind = "tool_return"
            if self.api == "interactions":
                assert content[1:-1] == self.history
                assert content[-1]["call_id"] == "call_fixture"
                text = json.loads(content[-1]["result"][0]["text"])["receipt"]
            else:
                assert content[1] == self.history
                text = content[-1]["parts"][0]["functionResponse"]["response"]["receipt"]
            assert "tools" not in body
            payload = response(self.api, text)
        elif body.get("tools"):
            kind = "tool_call"
            payload = response(self.api, call={"nonce": re.search(r'nonce="([^"]+)"', prompt)[1]})
            self.history = deepcopy(payload["steps"] if self.api == "interactions" else payload["candidates"][0]["content"])
        elif schema:
            kind = "schema"
            payload = response(self.api, json.dumps({"ok": True, "nonce": re.search(r'nonce="([^"]+)"', prompt)[1]}))
        else:
            kind = "stream" if stream else "text"
            payload = response(self.api, prompt.split(": ", 1)[1])
        if stream:
            events = self.mutate(kind, stream_events(self.api, payload))
            data = "".join("data: " + json.dumps(event) + "\r\n\r\n" for event in events)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=data)
        return httpx.Response(200, json=self.mutate(kind, payload))


async def run(api, upstream, mode=Mode.FULL):
    before = set(asyncio.all_tasks())
    config = ExecutionConfig.for_mode(mode, gemini_wire_api=api)
    async with make_client(BASE, "synthetic-key", timeout=2, trust_env=False, wire_api=api) as client:
        with respx.mock(assert_all_called=False) as mock:
            mock.route().mock(side_effect=upstream)
            result = await build_runner(client, build_detectors(), config).run("models/gemini-fixture")
    # Give nested httpx generator finalizers a bounded grace period to settle;
    # no task is cancelled or ignored to make the zero-task assertion pass.
    await asyncio.sleep(0.01)
    assert set(asyncio.all_tasks()) == before
    return result


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("mode,count,passed", [(Mode.QUICK, 2, 2), (Mode.STANDARD, 3, 3), (Mode.FULL, 5, 4)])
async def test_native_flows_budget_usage_signed_history_and_cleanup(api, mode, count, passed):
    upstream = Upstream(api)
    outcome = await run(api, upstream, mode)
    assert len(upstream.requests) == outcome.performance.request_count == count
    assert sum(r.status == "pass" for r in outcome.results) == passed
    assert all(r.status in {"pass", "skip"} for r in outcome.results)
    assert outcome.performance.backoff_events == 0
    assert outcome.performance.usage_complete
    assert outcome.performance.usage.input_tokens == count * 11
    assert outcome.performance.usage.output_tokens == count * 335
    assert outcome.performance.ttft_ms is not None
    assert "private-signature-fixture" not in json.dumps([r.model_dump() for r in outcome.results])
    assert assess_ranking_eligibility({"wire_api": api, "ranking_evidence": {"eligible": True}}) == (False, "gemini_native_capability_only")


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("status", [401, 403, 404, 405, 429, 500, 302])
async def test_failure_never_retries_redirects_falls_back_or_probes_more(api, status):
    calls = []
    def upstream(req):
        calls.append(req)
        return httpx.Response(status, headers={"location": "https://unexpected.example"}, text="synthetic-key")
    result = await run(api, upstream)
    assert len(calls) == result.performance.request_count == 1
    assert not any(r.status == "pass" for r in result.results)
    assert not result.performance.usage_complete
    assert "synthetic-key" not in json.dumps([r.model_dump() for r in result.results])


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("bad", [[], {}, {"error": {"code": 403}}, {"error": {"status": "UNAUTHENTICATED"}}])
async def test_invalid_basic_evidence_stops_run(api, bad):
    upstream = Upstream(api, lambda _, payload: bad)
    result = await run(api, upstream)
    assert len(upstream.requests) == 1
    assert not any(r.status == "pass" for r in result.results)


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("mutation", ["missing_usage", "boolean_usage", "wrong_total", "not_finished", "wrong_nonce", "empty_output"])
async def test_bad_basic_results_do_not_continue(api, mutation):
    def mutate(kind, payload):
        assert kind == "text"
        usage_key = "usage" if api == "interactions" else "usageMetadata"
        if mutation == "missing_usage": payload.pop(usage_key)
        if mutation == "boolean_usage": payload[usage_key]["total_input_tokens" if api == "interactions" else "promptTokenCount"] = True
        if mutation == "wrong_total": payload[usage_key]["total_tokens" if api == "interactions" else "totalTokenCount"] = 999
        if mutation == "not_finished":
            if api == "interactions": payload["status"] = "in_progress"
            else: payload["candidates"][0]["finishReason"] = "MAX_TOKENS"
        if mutation in {"wrong_nonce", "empty_output"}:
            parts = payload["steps"][0]["content"] if api == "interactions" else payload["candidates"][0]["content"]["parts"]
            parts[0]["text"] = "wrong" if mutation == "wrong_nonce" else ""
        return payload
    upstream = Upstream(api, mutate)
    result = await run(api, upstream)
    assert len(upstream.requests) == 1
    assert not any(r.status == "pass" for r in result.results)


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("mutation", ["truncate", "duplicate", "after_finish", "error", "bad_json", "wrong_id"])
async def test_broken_stream_never_passes(api, mutation):
    def mutate(kind, value):
        if kind != "stream": return value
        if mutation == "truncate": return value[:-1]
        if mutation == "duplicate": return value + [value[-1]]
        if mutation == "after_finish": return value + [value[0]]
        if mutation == "error": return value[:-1] + [{"error": {"code": 500}}]
        if mutation == "bad_json": return value[:-1] + [{"_parse_error": True}]
        if mutation == "wrong_id":
            if api == "interactions": value[-1]["interaction"]["id"] = "other"
            else: value[-1]["responseId"] = "other"
        return value
    result = await run(api, Upstream(api, mutate), Mode.QUICK)
    assert next(r for r in result.results if r.name == "gemini_stream").status == "error"
    assert not result.performance.usage_complete


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("stage", ["schema", "tool_call", "tool_return"])
async def test_schema_and_tool_nonce_are_actual_evidence(api, stage):
    def mutate(kind, payload):
        if kind == stage:
            if stage == "tool_call":
                call = payload["steps"][-1] if api == "interactions" else payload["candidates"][0]["content"]["parts"][0]["functionCall"]
                call["name"] = "run_shell"
            else:
                parts = payload["steps"][0]["content"] if api == "interactions" else payload["candidates"][0]["content"]["parts"]
                parts[0]["text"] = '{}'
        return payload
    upstream = Upstream(api, mutate)
    result = await run(api, upstream)
    name = "gemini_schema" if stage == "schema" else "gemini_tools"
    assert next(r for r in result.results if r.name == name).status == "fail"
    assert len(upstream.requests) == (4 if stage == "tool_call" else 5)


@pytest.mark.parametrize("value", ["../secret", "models/../key", "gemini?key=x", "gemini/other", "gemini#x", "gemini%2Fother", ""])
def test_model_path_injection_rejected(value):
    with pytest.raises(ValueError): model_id(value)


@pytest.mark.parametrize("api", APIS)
async def test_budget_exhaustion_does_not_open_another_request(api):
    async with make_client(BASE, "synthetic-key", timeout=2, wire_api=api) as base:
        wrapper = NativeSession(base, 0)
        with pytest.raises(ValueError, match="预算"):
            await wrapper.request("gemini-fixture", wrapper.body("hi"))
        assert wrapper.request_count == 0


@pytest.mark.parametrize("api", APIS)
def test_web_native_skips_paid_compatibility_preflight(monkeypatch, api):
    submitted = []
    async def valid(value): return value
    async def preflight(*args): pytest.fail("native detection must not use compatibility preflight")
    async def submit(*args, **kwargs): submitted.append(kwargs); return "job_fixture_123"
    monkeypatch.setattr(server, "_validated_target_or_400", valid)
    monkeypatch.setattr(server, "_preflight_or_422", preflight)
    monkeypatch.setattr(server, "_submit_or_503", submit)
    monkeypatch.setattr(server, "_enforce_rate_limit", lambda *args, **kwargs: None)
    with TestClient(server.app) as client:
        result = client.post("/api/detect/gemini", data={"base_url": BASE, "api_key": "synthetic-key", "model": "gemini-fixture", "wire_api": api})
    assert result.status_code == 200
    assert submitted[0]["wire_api"] == api


def test_gemini_form_and_report_coverage_are_consistent():
    with TestClient(server.app) as client:
        page = client.get("/gemini")
    assert 'name="wire_api"' in page.text
    assert "99%" not in page.text and "应该全 7 项 100 分" not in page.text
    for api in APIS:
        report = {"protocol": "gemini", "wire_api": api, "results": []}
        assert [r["name"] for r in server._result_rows(report)] == ["basic_request", "gemini_stream", "gemini_schema", "gemini_tools"]
        assert "不与其他接口" in server._report_notes(report)[0]["body"]


@pytest.mark.parametrize("api", APIS)
async def test_job_persists_exact_interface_and_excludes_public_baseline(api, tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "JOBS_DIR", tmp_path)
    job = jobs.Job(id="native_fixture_123", protocol="gemini", wire_api=api, target_model="gemini-fixture")
    monkeypatch.setattr(jobs, "_JOBS", {job.id: job})
    with respx.mock(assert_all_called=False) as mock:
        mock.route().mock(side_effect=Upstream(api))
        await jobs._run(job.id, BASE, "synthetic-key", "gemini-fixture", "quick", "gemini", wire_api=api)
    saved = json.loads((tmp_path / "gemini" / f"{job.id}.json").read_text())
    assert saved["wire_api"] == jobs._load_state(job.id).wire_api == api
    assert saved["assessment"]["score_usable"]
    assert saved["ranking_evidence"]["baseline_version"] == "not_available"
    assert [row["label_short"] for row in server._result_rows(saved)] == ["通过", "通过", "未测试", "未测试"]


@pytest.mark.parametrize("api", APIS)
async def test_cancellation_closes_inflight_request_without_owned_tasks(api):
    entered = asyncio.Event()
    exited = asyncio.Event()
    class HangingBase:
        wire_api = api
        async def request(self, *args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
                yield {}, 0
            finally:
                exited.set()
    before = set(asyncio.all_tasks())
    session = NativeSession(HangingBase(), 2)
    task = asyncio.create_task(session.request("gemini-fixture", session.body("hi")))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert exited.is_set() and not session.usage_complete
    assert set(asyncio.all_tasks()) == before


@pytest.mark.parametrize("api", APIS)
@pytest.mark.parametrize("base,expected", [("https://relay.example", "/v1beta"), ("https://relay.example/custom/v1", "/custom/v1")])
async def test_native_preserves_explicit_version_prefix(api, base, expected):
    async with make_client(base, "synthetic-key", timeout=2, wire_api=api) as client:
        assert client.base_url == "https://relay.example" + expected


@pytest.mark.parametrize("api", APIS)
async def test_large_body_rejected_with_no_retry(api):
    count = 0
    def upstream(req):
        nonlocal count
        count += 1
        return httpx.Response(200, content=b" " * (2 * 1024 * 1024 + 1))
    result = await run(api, upstream)
    assert count == 1
    assert next(r for r in result.results if r.name == "basic_request").status == "error"

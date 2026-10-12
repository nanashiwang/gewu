"""Responses acceptance uses synthetic upstreams only; no external tools/credits."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import re

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from relay_detector import cli
from relay_detector.core.models import DetectionReport, ExecutionConfig, Mode
from relay_detector.protocols.openai import build_detectors, build_runner, make_client
from relay_detector.protocols.openai.responses import ResponsesClient, MAX_OUTPUT_TOKENS
from relay_detector.ranking import assess_ranking_eligibility, approved_ranking_evidence
from web import jobs, server

BASE = "https://relay.example/custom/v1"
MODEL = "tenant/gpt-6-astra"


def response(text="ok", output=None):
    return {"id": "resp_test", "object": "response", "status": "completed", "model": MODEL,
            "output": output if output is not None else [{"id": "msg_test", "type": "message", "role": "assistant",
                "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": 12, "output_tokens": 8, "total_tokens": 20}}


def stream_events(payload):
    text = payload["output"][0]["content"][0]["text"]
    fields = {"item_id": "msg_test", "output_index": 0, "content_index": 0}
    return [
        {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_test", "status": "in_progress"}},
        {"type": "response.output_text.delta", "sequence_number": 1, **fields, "delta": text[:5]},
        {"type": "response.output_text.delta", "sequence_number": 2, **fields, "delta": text[5:]},
        {"type": "response.output_text.done", "sequence_number": 3, **fields, "text": text},
        {"type": "response.completed", "sequence_number": 4, "response": payload},
    ]


class Upstream:
    def __init__(self, mutate=None):
        self.requests = []
        self.mutate = mutate or (lambda kind, value: value)
        self.tool_output = None

    def __call__(self, request):
        assert str(request.url) == BASE + "/responses", "never call Chat Completions or a fallback host"
        body = json.loads(request.content)
        self.requests.append(body)
        assert body["model"] == MODEL
        assert body["store"] is False
        assert body["max_output_tokens"] == MAX_OUTPUT_TOKENS
        content = body["input"]
        if isinstance(content, str) and content.startswith("Reply"):
            kind = "stream" if body.get("stream") else "text"
            payload = response(content.split(": ", 1)[1])
        elif body.get("text"):
            kind = "schema"
            assert body["text"]["format"]["strict"] is True
            payload = response(json.dumps({"ok": True, "nonce": re.search(r'nonce="([^"]+)"', content)[1]}))
        elif content[-1].get("type") == "function_call_output":
            kind = "tool_return"
            assert content[1:-1] == self.tool_output, "preserve reasoning and function items for stateless continuation"
            assert content[-1]["call_id"] == "call_test"
            assert body["tool_choice"] == "none" and "previous_response_id" not in body
            payload = response(json.loads(content[-1]["output"])["receipt"])
        else:
            kind = "tool_call"
            assert body["tool_choice"] == {"type": "function", "name": "gewu_echo"}
            assert body["include"] == ["reasoning.encrypted_content"]
            nonce = re.search(r'nonce="([^"]+)"', content[0]["content"])[1]
            self.tool_output = [
                {"id": "rs_test", "type": "reasoning", "summary": [], "encrypted_content": "private-reasoning-fixture"},
                {"id": "fc_test", "type": "function_call", "call_id": "call_test", "name": "gewu_echo",
                 "arguments": json.dumps({"nonce": nonce}), "status": "completed"},
            ]
            payload = response(output=self.tool_output)
        if kind == "stream":
            events = self.mutate(kind, stream_events(payload))
            data = "".join("event: " + event.get("type", "error") + "\r\ndata: " + json.dumps(event) + "\r\n\r\n" for event in events)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=data)
        payload = self.mutate(kind, payload)
        return httpx.Response(200, json=payload)


async def run(upstream, mode=Mode.FULL, **changes):
    config = ExecutionConfig.for_mode(mode, openai_wire_api="responses", **changes)
    async with make_client(BASE, "synthetic-key", timeout=2, trust_env=False) as client:
        with respx.mock(assert_all_called=False) as mock:
            mock.route().mock(side_effect=upstream)
            return await build_runner(client, build_detectors(), config).run(MODEL)


def report(outcome, mode=Mode.FULL):
    return DetectionReport(protocol="openai", wire_api="responses", base_url=BASE,
        api_key_masked="[REDACTED]", target_model=MODEL, mode=mode, timestamp=datetime.now(timezone.utc),
        total_score=100, verdict="passed", results=outcome.results, performance=outcome.performance).model_dump(mode="json")


@pytest.mark.parametrize("mode,count,passed", [(Mode.QUICK, 2, 2), (Mode.STANDARD, 3, 3), (Mode.FULL, 5, 4)])
async def test_complete_flows_budget_coverage_and_no_extra_ttft(mode, count, passed):
    upstream = Upstream()
    before = set(asyncio.all_tasks())
    outcome = await run(upstream, mode)
    assert set(asyncio.all_tasks()) == before
    assert len(upstream.requests) == outcome.performance.request_count == count
    assert outcome.performance.backoff_events == 0
    assert outcome.performance.usage.input_tokens == count * 12
    assert outcome.performance.usage.output_tokens == count * 8
    assert outcome.performance.usage_complete is True
    assert outcome.performance.ttft_ms is not None
    assert sum(row.status == "pass" for row in outcome.results) == passed
    assert all(row.status in {"pass", "skip"} for row in outcome.results)
    data = report(outcome, mode)
    assert data["assessment"]["score_usable"]
    assert "private-reasoning-fixture" not in json.dumps(data)
    assert "synthetic-key" not in json.dumps(data)
    # Even manual approval cannot mix new capability scores into old rankings.
    data["ranking_evidence"] = approved_ranking_evidence("openai", MODEL, mode,
        source="manual_review", reviewer="synthetic").model_dump(mode="json")
    assert assess_ranking_eligibility(data) == (False, "responses_capability_only")


@pytest.mark.parametrize("status", [401, 403, 404, 405, 429, 500, 302])
async def test_access_failure_stops_after_one_request_without_retry(status):
    calls = []
    def upstream(request):
        calls.append(str(request.url))
        return httpx.Response(status, json={"error": {"message": "synthetic rejection"}}, headers={"location": "https://other.example"})
    outcome = await run(upstream)
    assert len(calls) == outcome.performance.request_count == 1
    assert outcome.performance.usage_complete is False
    assert not report(outcome)["assessment"]["score_usable"]
    assert not any(row.status == "pass" for row in outcome.results)


@pytest.mark.parametrize("bad", [
    {"error": {"code": "invalid_api_key", "message": "rejected"}},
    {**response(), "status": "failed"}, {**response(), "status": "incomplete"},
    {**response(), "output": []}, {**response(), "object": "chat.completion"},
    {**response(), "usage": None}, {**response(), "usage": {"input_tokens": True, "output_tokens": 1, "total_tokens": 2}},
    {**response(), "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 999}},
    [],
])
async def test_http_200_invalid_evidence_never_passes_or_continues(bad):
    outcome = await run(lambda _request: httpx.Response(200, json=bad))
    assert outcome.performance.request_count == 1
    assert not report(outcome)["assessment"]["score_usable"]


def broken_stream(case, events):
    if case == "no_terminal": return events[:-1]
    if case == "no_done": return events[:3] + events[4:]
    if case == "done_only": return [{"_done": True}]
    if case == "no_created": return events[1:]
    if case == "duplicate_terminal": return events + [events[-1]]
    if case == "late_error": return events + [{"type": "error", "code": "server_error"}]
    if case == "failed": events[-1] = {"type": "response.failed", "response": {"status": "failed"}}
    if case == "incomplete": events[-1]["response"]["status"] = "incomplete"
    if case == "id_changed": events[-1]["response"]["id"] = "resp_other"
    if case == "item_changed": events[2]["item_id"] = "msg_other"
    if case == "order": events[2]["sequence_number"] = 0
    if case == "done_mismatch": events[3]["text"] = "wrong"
    if case == "final_mismatch": events[-1]["response"]["output"][0]["content"][0]["text"] = "wrong"
    if case == "malformed": events[2] = {"_parse_error": True}
    return events


@pytest.mark.parametrize("case", ["no_terminal", "no_done", "done_only", "no_created", "duplicate_terminal",
    "late_error", "failed", "incomplete", "id_changed", "item_changed", "order", "done_mismatch", "final_mismatch", "malformed"])
async def test_stream_corruption_has_no_usable_score(case):
    upstream = Upstream(lambda kind, value: broken_stream(case, value) if kind == "stream" else value)
    outcome = await run(upstream, Mode.QUICK)
    assert next(row for row in outcome.results if row.name == "responses_stream").status == "error"
    assert not report(outcome)["assessment"]["score_usable"]


@pytest.mark.parametrize("case", ["broken_json", "extra_key", "false_ok", "numeric_ok"])
async def test_structured_output_requires_exact_schema_and_values(case):
    def mutate(kind, value):
        if kind != "schema": return value
        part = value["output"][0]["content"][0]
        parsed = json.loads(part["text"])
        if case == "extra_key": parsed["extra"] = "forbidden"
        if case == "false_ok": parsed["ok"] = False
        if case == "numeric_ok": parsed["ok"] = 1
        part["text"] = "```json\n{}\n```" if case == "broken_json" else json.dumps(parsed)
        return value
    outcome = await run(Upstream(mutate), Mode.STANDARD)
    assert next(row for row in outcome.results if row.name == "responses_schema").status == "fail"


@pytest.mark.parametrize("case", ["wrong_name", "missing_call_id", "bad_arguments", "extra_arguments", "duplicate_call", "wrong_final"])
async def test_tools_validate_arguments_and_the_complete_roundtrip(case):
    def mutate(kind, value):
        if kind == "tool_call" and case != "wrong_final":
            item = value["output"][1]
            if case == "wrong_name": item["name"] = "run_shell"
            if case == "missing_call_id": item.pop("call_id")
            if case == "bad_arguments": item["arguments"] = "{broken"
            if case == "extra_arguments": item["arguments"] = json.dumps({**json.loads(item["arguments"]), "command": "never execute"})
            if case == "duplicate_call": value["output"].append(deepcopy(item))
        if kind == "tool_return" and case == "wrong_final": value["output"][0]["content"][0]["text"] = "ignored receipt"
        return value
    upstream = Upstream(mutate)
    outcome = await run(upstream)
    assert next(row for row in outcome.results if row.name == "responses_tools").status == "fail"
    assert len(upstream.requests) == (5 if case == "wrong_final" else 4)


async def test_cancelled_stream_closes_and_leaves_no_async_tasks():
    started, closed = asyncio.Event(), asyncio.Event()
    class Hanging(httpx.AsyncByteStream):
        async def __aiter__(self):
            started.set()
            await asyncio.Future()
            yield b""
        async def aclose(self): closed.set()
    upstream = Upstream()
    def handler(request):
        if json.loads(request.content).get("stream"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Hanging())
        return upstream(request)
    before = set(asyncio.all_tasks())
    task = asyncio.create_task(run(handler, Mode.QUICK))
    await asyncio.wait_for(started.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert closed.is_set()
    assert set(asyncio.all_tasks()) == before


@pytest.mark.parametrize("stream", [True, False])
async def test_response_size_is_bounded(stream):
    upstream = Upstream()
    def handler(request):
        body = json.loads(request.content)
        if bool(body.get("stream")) == stream:
            return httpx.Response(200, content=b"x" * (1024 * 1024 + 1), headers={"content-type": "text/event-stream"})
        return upstream(request)
    outcome = await run(handler, Mode.QUICK)
    assert not report(outcome)["assessment"]["score_usable"]
    assert any("1 MiB" in (row.error or "") for row in outcome.results)


async def test_client_budget_cannot_be_exceeded():
    async with make_client(BASE, "synthetic", timeout=1, trust_env=False) as base:
        client = ResponsesClient(base, 0)
        with pytest.raises(ValueError, match="请求预算"):
            await client.create(MODEL, input="never send")
        assert client.request_count == 0


def test_api_selection_skips_legacy_paid_preflight_and_rejects_invalid_options(monkeypatch):
    calls = []
    async def validate(value): return value
    async def forbidden(*args): raise AssertionError("Responses must not run a Chat Completions preflight")
    async def submit(*args, **kwargs):
        calls.append(kwargs)
        return "synthetic-job"
    monkeypatch.setattr(server, "_validated_target_or_400", validate)
    monkeypatch.setattr(server, "_preflight_or_422", forbidden)
    monkeypatch.setattr(server, "_submit_or_503", submit)
    monkeypatch.setattr(server, "_enforce_rate_limit", lambda *args, **kwargs: None)
    data = {"base_url": BASE, "api_key": "synthetic-key", "model": MODEL, "wire_api": "responses"}
    with TestClient(server.app) as client:
        assert client.post("/api/detect/openai", data=data).status_code == 200
        assert calls[0]["wire_api"] == "responses"
        assert client.post("/api/detect/openai", data={**data, "wire_api": "unknown"}).status_code == 400
        assert client.post("/api/detect/openai", data={**data, "include_long_context": "true"}).status_code == 400
        assert len(calls) == 1


async def test_job_persists_interface_and_renders_actual_capabilities(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "JOBS_DIR", tmp_path)
    job = jobs.Job(id="synthetic-job", protocol="openai", wire_api="responses", target_model=MODEL)
    monkeypatch.setattr(jobs, "_JOBS", {job.id: job})
    with respx.mock as mock:
        mock.route().mock(side_effect=Upstream())
        await jobs._run(job.id, BASE, "synthetic-key", MODEL, "quick", "openai", wire_api="responses")
    saved = json.loads((tmp_path / "openai" / f"{job.id}.json").read_text())
    assert saved["wire_api"] == "responses"
    assert saved["assessment"]["score_usable"]
    assert jobs._load_state(job.id).wire_api == "responses"
    rows = server._result_rows(saved)
    assert [row["label_short"] for row in rows] == ["通过", "通过", "未测试", "未测试"]
    assert all(row["name"] != "token_billing" for row in rows)
    assert "Responses" in server._report_notes(saved)[0]["title"]


def test_cli_explicit_responses_and_legacy_default(monkeypatch):
    configs = []
    async def fake(proto, base, key, model, config, output): configs.append(config)
    monkeypatch.setattr(cli, "_run_detect", fake)
    args = ["detect", "--protocol", "openai", "--base-url", BASE, "--api-key", "synthetic-key", "--model", MODEL]
    runner = CliRunner()
    assert runner.invoke(cli.app, [*args, "--wire-api", "responses"]).exit_code == 0
    assert runner.invoke(cli.app, args).exit_code == 0
    assert [config.openai_wire_api for config in configs] == ["responses", "chat_completions"]
    assert runner.invoke(cli.app, [*args, "--wire-api", "responses", "--long-context"]).exit_code != 0


async def test_late_auth_failure_cannot_start_more_requests():
    upstream = Upstream()
    def handler(request):
        if json.loads(request.content).get("stream"):
            return httpx.Response(401, json={"error": {"message": "invalid api key"}})
        return upstream(request)
    outcome = await run(handler)
    assert outcome.performance.request_count == 2
    assert not report(outcome)["assessment"]["score_usable"]


async def test_fixed_canned_answer_does_not_pass_random_challenge():
    upstream = Upstream(lambda kind, value: response("pong") if kind == "text" else value)
    outcome = await run(upstream, Mode.QUICK)
    assert next(row for row in outcome.results if row.name == "basic_request").status == "fail"


async def test_unfinished_function_call_never_executes_followup():
    def mutate(kind, value):
        if kind == "tool_call": value["output"][1]["status"] = "in_progress"
        return value
    upstream = Upstream(mutate)
    outcome = await run(upstream)
    assert len(upstream.requests) == 4
    assert not report(outcome)["assessment"]["score_usable"]


@pytest.mark.parametrize("model,expected", [("gpt-synthetic-pro", True), ("gpt-synthetic-codex", True),
    ("gpt-image-synthetic", False), ("gpt-synthetic-audio", False)])
def test_responses_model_candidates_do_not_change_chat_eligibility(model, expected):
    from relay_detector.model_catalog import is_chat_candidate, is_responses_candidate
    assert is_responses_candidate(model) is expected
    assert not is_chat_candidate(model)

"""Adversarial task lifecycle checks: no upstream credentials or paid calls."""

import asyncio
import json
import re
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from relay_detector.core.detectors_base import ActiveDetector
from relay_detector.core.models import DetectorResult, ExecutionConfig, Mode
from relay_detector.core.runner import Runner
from web import jobs, server
from web.job_feedback import job_feedback


@pytest_asyncio.fixture(autouse=True)
async def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "JOBS_DIR", tmp_path)
    monkeypatch.setattr(jobs, "_JOBS", {})
    monkeypatch.setattr(jobs, "_TASKS", {})
    monkeypatch.setattr(jobs, "_STOP_REASONS", {})
    monkeypatch.setattr(jobs, "_SEMA", asyncio.Semaphore(6))
    monkeypatch.setattr(jobs, "_LOCK", asyncio.Lock())
    monkeypatch.setattr(jobs, "_ACCEPTING", True)
    yield
    await jobs.shutdown()
    assert not jobs._TASKS, "owned detection tasks must all exit"


def result(name="basic_request", status="pass", **kwargs):
    return DetectorResult(name=name, display_name=name, status=status, score=100 if status == "pass" else 0, weight=100, **kwargs)


class Probe(ActiveDetector):
    def __init__(self, name, run):
        self.name, self.display_name, self.execute = name, name, run

    async def run(self, client, model):
        return await self.execute()


def runner_for(probes, timeout=1, ttft=None):
    return Runner(None, probes, ExecutionConfig(overall_timeout_s=timeout),
                  mode_detectors={Mode.QUICK: {p.name for p in probes}},
                  throttled_client_factory=lambda *_: SimpleNamespace(), ttft_probe=ttft)


@pytest.mark.asyncio
async def test_timeout_preserves_finished_results_and_closes_pending_work():
    ended = asyncio.Event()
    ttft_calls = []

    async def fast():
        return result()

    async def slow():
        try:
            await asyncio.Event().wait()
        finally:
            ended.set()

    async def ttft(*_):
        ttft_calls.append(True)

    runner = runner_for([Probe("basic_request", fast), Probe("integrity", slow)], .02, ttft)
    events = []
    runner.on_progress = events.append
    outcome = await runner.run("test-model")
    assert [r.status for r in outcome.results] == ["pass", "error"]
    assert ended.is_set() and not ttft_calls
    assert events[0]["checks"][0]["status"] == "pending"
    assert any(e["checks"][0]["status"] == "pass" and e["checks"][1]["status"] == "running" for e in events)


@pytest.mark.asyncio
async def test_observer_storage_failure_cancels_other_probes():
    started, ended = asyncio.Event(), asyncio.Event()

    async def slow():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            ended.set()

    async def fast():
        await started.wait()
        return result("second")

    runner = runner_for([Probe("first", slow), Probe("second", fast)])

    def fail_after_result(event):
        if any(r["status"] == "pass" for r in event["results"]):
            raise OSError("disk unavailable")

    runner.on_progress = fail_after_result
    with pytest.raises(OSError):
        await runner.run("test-model")
    assert ended.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/api/status", "/api/jobs"])
async def test_running_cancel_is_owned_idempotent_and_keeps_redacted_evidence(monkeypatch, prefix):
    started, ended = asyncio.Event(), asyncio.Event()
    secret = "sk-adversarial-secret"

    async def fake(*args):
        args[4]({"stage": "probing", "checks": [{"name": "basic_request", "label": "基础请求", "status": "pass"}],
                 "results": [result(details={"response_text": secret}).model_dump()]})
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(.01)
            ended.set()

    monkeypatch.setattr(jobs, "_run_openai", fake)
    job_id = await jobs.submit("https://relay.example", secret, "test-model", "quick", "openai")
    await started.wait()
    token = jobs.issue_cancel_token(job_id)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="https://testserver") as client:
        path = f"{prefix}/{job_id}/cancel"
        assert (await client.post(path)).status_code == 403
        client.cookies.set(f"gewu_cancel_{job_id}", token)
        assert (await client.post(path, headers={"Origin": "https://evil.example"})).status_code == 403
        responses = await asyncio.gather(client.post(path), client.post(path))
        assert all(r.status_code == 200 and r.json()["status"] == "cancelled" for r in responses)
        body = responses[0].json()
        assert body["total_score"] is None and body["assessment"]["score_usable"] is False
        assert ended.is_set() and not jobs._TASKS
        assert (await client.post(path)).json()["status"] == "cancelled"
        assert (await client.get(f"/r/{job_id}")).status_code == 200
    for path in jobs.JOBS_DIR.rglob("*"):
        if path.is_file():
            text = path.read_text()
            assert secret not in text and token not in text
    jobs._JOBS.clear()
    restored = await jobs.get(job_id)
    assert restored.status == "cancelled" and restored.report["results"][0]["status"] == "pass"


@pytest.mark.asyncio
async def test_queued_cancel_and_shutdown_never_start_upstream(monkeypatch):
    monkeypatch.setattr(jobs, "_SEMA", asyncio.Semaphore(0))
    calls = []

    async def forbidden(*_):
        calls.append(True)

    monkeypatch.setattr(jobs, "_run_openai", forbidden)
    ids = [await jobs.submit("https://relay.example", "sk-test", "test-model", "quick", "openai") for _ in range(2)]
    await jobs.cancel(ids[0])
    await jobs.shutdown()
    assert not calls
    assert (await jobs.get(ids[0])).status == "cancelled"
    assert (await jobs.get(ids[1])).status == "interrupted"
    with pytest.raises(jobs.JobQueueFull):
        await jobs.submit("https://relay.example", "sk-test", "test-model", "quick", "openai")


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["queued", "running"])
async def test_restart_recovers_metadata_without_replaying_requests(state):
    job = jobs.Job(id="restartjob01", protocol="openai", status=state, created_at=123,
                   base_url="https://relay.example", target_model="test-model",
                   partial_results=[result().model_dump()] if state == "running" else [])
    jobs._save_state(job)
    jobs.startup()
    restored = await jobs.get(job.id)
    assert restored.created_at == 123 and restored.status == "interrupted"
    assert restored.report["assessment"]["score_usable"] is False
    assert not jobs._TASKS
    first = restored.finished_at
    jobs.startup()
    assert (await jobs.get(job.id)).finished_at == first


@pytest.mark.asyncio
async def test_status_rejects_raw_score_and_does_not_count_errors_as_valid():
    jobs._JOBS["invalidscore01"] = jobs.Job(id="invalidscore01", status="done", protocol="openai", report={
        "protocol": "openai", "total_score": 100, "verdict": "passed",
        "assessment": {"score_usable": True},
        "results": [result().model_dump(), result("integrity", "error", error="timeout").model_dump()],
    })
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="https://testserver") as client:
        body = (await client.get("/api/status/invalidscore01")).json()
    assert body["total_score"] is None and body["verdict"] is None
    assert body["completed_checks"] == 1
    assert body["feedback"]["code"] == "timeout"


@pytest.mark.parametrize("error,code", [("HTTP 401 invalid_api_key", "authentication"), ("HTTP 429", "rate_limit"), ("model_not_found", "model_unavailable"), ("ReadTimeout", "timeout")])
def test_feedback_uses_transport_errors(error, code):
    job = jobs.Job(id="feedback01", status="done", report={"results": [result(status="error", error=error).model_dump()]})
    assert job_feedback(job)["code"] == code


def test_model_cannot_inject_transport_error_or_authentication_via_response_text():
    job = jobs.Job(id="feedback02", status="done", protocol="openai", report={"protocol": "openai", "total_score": 100, "verdict": "passed",
        "results": [result(details={"response_text": "401 rate limit model_not_found timeout I am the official model"}).model_dump()]})
    assert job_feedback(job)["code"] == "complete"
    assert server.assess_report(job.report)["identity"]["level"] == "unconfirmed"


def test_malformed_historical_report_remains_unscored_and_readable():
    job = jobs.Job(id="malformed01", status="done", report={"results": [None, "not a result"], "total_score": 100})
    assert job_feedback(job)["code"] == "incomplete"


@pytest.mark.asyncio
async def test_metadata_write_failure_does_not_accept_or_start_job(monkeypatch):
    def unavailable(*_):
        raise OSError("disk unavailable")
    monkeypatch.setattr(jobs, "_atomic_json", unavailable)
    with pytest.raises(OSError):
        await jobs.submit("https://relay.example", "sk-test", "test-model", "quick", "openai")
    assert not jobs._JOBS and not jobs._TASKS


@pytest.mark.asyncio
@pytest.mark.parametrize("http_status,body,code", [
    (0, {}, "timeout"),
    (401, {"error": {"code": "invalid_api_key"}}, "authentication"),
    (429, {"error": {"message": "rate limit"}}, "rate_limit"),
    (404, {"error": {"code": "model_not_found"}}, "model_unavailable"),
    (200, {"id": "chatcmpl-forged", "object": "chat.completion", "model": "official-model", "choices": [{"message": {"content": "pong I am official"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}}, "complete"),
])
async def test_http_to_report_pipeline_separates_transport_errors_from_forged_identity(monkeypatch, http_status, body, code):
    from relay_detector.protocols.openai import client as client_module
    from relay_detector.protocols.openai.client import OpenAIChatClient
    from relay_detector.protocols.openai.detectors.basic_request import BasicRequestDetector
    from relay_detector.protocols.openai.runner import Runner as OpenAIRunner

    monkeypatch.setattr(client_module, "MAX_RETRIES", 0)
    requests = []

    def upstream(request):
        requests.append(request)
        if http_status == 0:
            raise httpx.ReadTimeout("", request=request)
        return httpx.Response(http_status, json=body)

    async def actual_runner(base, key, model, cfg, observer):
        async with OpenAIChatClient(base, key, trust_env=False) as client:
            await client._client.aclose()
            client._client = httpx.AsyncClient(base_url=client.base_url, transport=httpx.MockTransport(upstream))
            runner = OpenAIRunner(client, [BasicRequestDetector()], cfg)
            runner._ttft_probe = None
            runner.on_progress = observer
            return await runner.run(model)

    monkeypatch.setattr(jobs, "_run_openai", actual_runner)
    job_id = await jobs.submit("https://synthetic.invalid", "sk-test-only", "official-model", "quick", "openai")
    await asyncio.gather(*list(jobs._TASKS.values()))
    job = await jobs.get(job_id)
    assert job.status == "done" and len(requests) == 1
    assert job_feedback(job)["code"] == code
    assert job.report["assessment"]["score_usable"] is (http_status == 200)
    assert job.report["assessment"]["identity"]["level"] == "unconfirmed"
    assert job.progress["checks"][0]["status"] == ("pass" if http_status == 200 else "error")


@pytest.mark.asyncio
async def test_shutdown_closes_running_probes_and_restart_preserves_timestamps(monkeypatch):
    started, closed = asyncio.Event(), asyncio.Event()
    async def work(*args):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()
    monkeypatch.setattr(jobs, "_run_openai", work)
    job_id = await jobs.submit("https://relay.example", "sk-test", "test-model", "quick", "openai")
    await started.wait()
    created = (await jobs.get(job_id)).created_at
    await jobs.shutdown()
    jobs._JOBS.clear()
    jobs.startup()
    job = await jobs.get(job_id)
    assert closed.is_set() and not jobs._TASKS
    assert job.status == "interrupted" and job.created_at == created


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/api/status", "/api/jobs"])
async def test_submission_cookie_is_private_and_internal_cancellation_requires_token(monkeypatch, prefix):
    monkeypatch.setattr(jobs, "_SEMA", asyncio.Semaphore(0))
    monkeypatch.setenv("GEWU_INTERNAL_API_TOKEN", "internal-only-token")
    job_id = await jobs.submit("https://relay.example", "sk-test", "test-model", "quick", "openai")
    from starlette.requests import Request
    request = Request({"type": "http", "scheme": "https", "path": "/api/detect/openai", "headers": [], "server": ("testserver", 443)})
    response = server._submission_response(request, job_id)
    assert all(value in response.headers["set-cookie"] for value in ("HttpOnly", "Secure", "SameSite=strict"))
    assert b"cancel_token" not in response.body
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="https://testserver") as client:
        assert (await client.post(f"{prefix}/{job_id}/cancel", headers={"X-Gewu-Internal-Token": "wrong"})).status_code == 403
        assert (await client.post(f"{prefix}/{job_id}/cancel", headers={"X-Gewu-Internal-Token": "internal-only-token"})).json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_reaches_detector_through_existing_shared_domain_routes(monkeypatch):
    from starlette.responses import Response

    # The shared domain routes other /api paths to the account application.
    async def shared_domain(scope, receive, send):
        if re.match(r"^/api/(?:wishlist$|probe$|detect(?:/|$)|status/|result/)", scope["path"]):
            await server.app(scope, receive, send)
        else:
            await Response(status_code=404)(scope, receive, send)

    monkeypatch.setattr(jobs, "_SEMA", asyncio.Semaphore(0))
    job_id = await jobs.submit("https://relay.example", "sk-test", "test-model", "quick", "openai")
    token = jobs.issue_cancel_token(job_id)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=shared_domain), base_url="https://testserver") as client:
        client.cookies.set(f"gewu_cancel_{job_id}", token)
        response = await client.post(f"/api/status/{job_id}/cancel")
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    assert not jobs._TASKS


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/api/status", "/api/jobs"])
async def test_cancellation_routes_require_https(monkeypatch, prefix):
    monkeypatch.delenv("GEWU_ALLOW_INSECURE_API", raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://testserver") as client:
        response = await client.post(f"{prefix}/unknownjob123/cancel")
    assert response.status_code == 426

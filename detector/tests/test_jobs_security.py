"""Job queue limits, identifier hardening and secret persistence tests."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from relay_detector.models import DetectorResult, PerformanceMetrics
from web import jobs


@pytest.fixture
def isolated_jobs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "jobs"
    directory.mkdir()
    monkeypatch.setattr(jobs, "JOBS_DIR", directory)
    monkeypatch.setattr(jobs, "_JOBS", {})
    return directory


class _Outcome:
    def __init__(self, results: list[DetectorResult]):
        self.results = results
        self.performance = PerformanceMetrics()


async def _wait_finished(job_id: str) -> jobs.Job:
    for _ in range(100):
        job = await jobs.get(job_id)
        if job is not None and job.status in {"done", "error"}:
            return job
        await asyncio.sleep(0.01)
    raise AssertionError("job did not finish")


def test_job_ids_have_high_entropy_shape_and_paths_reject_traversal(isolated_jobs: Path):
    job_id = jobs._new_job_id()  # noqa: SLF001 - identifier invariant
    assert len(job_id) == 16
    assert jobs.is_valid_job_id(job_id)
    assert not jobs.is_valid_job_id("../secrets")
    with pytest.raises(ValueError, match="invalid job id"):
        jobs.report_path("../secrets", "openai")


@pytest.mark.asyncio
async def test_pending_queue_is_bounded(isolated_jobs: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(jobs, "_MAX_PENDING_JOBS", 1)
    jobs._JOBS["existing01"] = jobs.Job(id="existing01", status="running")
    with pytest.raises(jobs.JobQueueFull):
        await jobs.submit(
            "https://relay.example", "sk-test-secret", "gpt-test", "quick", protocol="openai"
        )


def test_completed_jobs_are_pruned_from_memory_but_not_disk(
    isolated_jobs: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(jobs, "_JOB_MEMORY_TTL_S", 10.0)
    jobs._JOBS["expired01"] = jobs.Job(
        id="expired01", status="done", finished_at=100.0
    )
    jobs._JOBS["running01"] = jobs.Job(id="running01", status="running")
    jobs._prune_jobs_locked(now=111.0)  # noqa: SLF001 - pruning invariant
    assert "expired01" not in jobs._JOBS
    assert "running01" in jobs._JOBS


@pytest.mark.asyncio
async def test_reflected_api_key_is_redacted_before_report_persistence(
    isolated_jobs: Path, monkeypatch: pytest.MonkeyPatch
):
    secret = "sk-reflected-secret-123"
    result = DetectorResult(
        name="basic_request",
        display_name="基础请求",
        status="fail",
        score=0,
        weight=100,
        error=f"upstream echoed {secret}",
        details={"response_text": f"Bearer {secret}", "nested": [secret]},
    )

    async def fake_openai(*_args, **_kwargs):
        return _Outcome([result])

    monkeypatch.setattr(jobs, "_run_openai", fake_openai)
    job_id = await jobs.submit(
        "https://relay.example", secret, "gpt-test", "quick", protocol="openai"
    )
    job = await _wait_finished(job_id)
    assert job.status == "done"
    persisted = jobs.report_path(job_id, "openai").read_text(encoding="utf-8")
    assert secret not in persisted
    assert "[REDACTED]" in persisted
    assert secret not in json.dumps(job.report, ensure_ascii=False)


@pytest.mark.asyncio
async def test_reflected_api_key_is_redacted_from_job_errors(
    isolated_jobs: Path, monkeypatch: pytest.MonkeyPatch
):
    secret = "sk-reflected-secret-456"

    async def fail_openai(*_args, **_kwargs):
        raise RuntimeError(f"malicious upstream returned {secret}")

    monkeypatch.setattr(jobs, "_run_openai", fail_openai)
    job_id = await jobs.submit(
        "https://relay.example", secret, "gpt-test", "quick", protocol="openai"
    )
    job = await _wait_finished(job_id)
    assert job.status == "error"
    assert secret not in (job.error or "")
    assert "[REDACTED]" in (job.error or "")

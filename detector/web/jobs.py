"""Job queue for HTTP-driven detections.

Wraps the same Runner the CLI uses. Single uvicorn worker, in-process state
guarded by an asyncio lock. Done jobs are persisted to disk so a server
restart keeps the shareable result URLs alive. API keys are NEVER stored on a
Job or persisted — the raw key exists only in the running task's local scope
and reflected copies are redacted before reports or errors are retained.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from relay_detector.models import (
    DetectionReport,
    DetectionTier,
    ExecutionConfig,
    Mode,
    Protocol,
    mask_api_key,
)
from relay_detector.scorer import (
    compute_total,
    effective_verdict,
    fatal_run_error,
    summary_text,
)
from .security import redact_secret, redact_text


JobStatus = Literal["queued", "running", "done", "error"]

JOBS_DIR = Path(
    os.environ.get("GEWU_JOBS_DIR")
    or "/opt/gewu-detector/web_data/jobs"
)
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# Cap concurrent detections so a flood of submissions doesn't exhaust file
# descriptors or get the upstream API rate-limited. Each detection caps its
# upstream concurrency at 3, so 6 inflight jobs create at most ~18 concurrent
# probe requests (while each job may issue more requests over its full run).
_MAX_INFLIGHT = 6
_MAX_PENDING_JOBS = 24
_MAX_IN_MEMORY_JOBS = 1000
_JOB_MEMORY_TTL_S = 3600.0
_SEMA = asyncio.Semaphore(_MAX_INFLIGHT)
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class JobQueueFull(RuntimeError):
    """Raised when accepting another job would create an unbounded queue."""


@dataclass
class Job:
    id: str
    protocol: str = "anthropic"
    status: JobStatus = "queued"
    base_url: str = ""
    target_model: str = ""
    mode: str = "full"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    report: dict[str, Any] | None = None
    error: str | None = None


_JOBS: dict[str, Job] = {}
_LOCK = asyncio.Lock()


def _new_job_id() -> str:
    # 16-char URL-safe id (~96 bits). Reports are intentionally shareable,
    # but their URLs must remain impractical to enumerate.
    return secrets.token_urlsafe(12)


def is_valid_job_id(job_id: str) -> bool:
    return bool(_JOB_ID_RE.fullmatch(job_id))


def _prune_jobs_locked(now: float | None = None) -> None:
    """Bound process memory while leaving persisted reports accessible."""
    current = time.time() if now is None else now
    completed = [
        job
        for job in _JOBS.values()
        if job.status in {"done", "error"} and job.finished_at is not None
    ]
    for job in completed:
        if current - float(job.finished_at) > _JOB_MEMORY_TTL_S:
            _JOBS.pop(job.id, None)

    overflow = len(_JOBS) - _MAX_IN_MEMORY_JOBS
    if overflow <= 0:
        return
    oldest = sorted(
        (
            job
            for job in _JOBS.values()
            if job.status in {"done", "error"} and job.finished_at is not None
        ),
        key=lambda job: float(job.finished_at or 0),
    )
    for job in oldest[:overflow]:
        _JOBS.pop(job.id, None)


async def submit(
    base_url: str,
    api_key: str,
    model: str,
    mode: str,
    protocol: str = "anthropic",
    include_long_context: bool = False,
    include_long_context_extreme: bool = False,
) -> str:
    """Queue a detection job and return the job id immediately.

    Long-context probe is opt-in. Two tiers:
      - ``include_long_context`` (standard): 32k/100k/200k probes,
        $0.05–$0.50 upstream cost, 30–90s extra wall time.
      - ``include_long_context_extreme`` (adaptive): probes proportionally
        up to the model's advertised limit (e.g. 32k→500k→950k for 1M
        models). $0.05–$8 cost, 30s–5min wall time. Catches "advertised X
        but capped at Y<X" fraud that the standard tier misses on big
        models. Implies standard (it's a superset).
    """
    job_id = _new_job_id()
    job = Job(
        id=job_id,
        protocol=protocol,
        base_url=base_url,
        target_model=model,
        mode=mode,
    )
    async with _LOCK:
        _prune_jobs_locked()
        pending = sum(job.status in {"queued", "running"} for job in _JOBS.values())
        if pending >= _MAX_PENDING_JOBS:
            raise JobQueueFull("detection queue is full")
        _JOBS[job_id] = job
    asyncio.create_task(
        _run(
            job_id, base_url, api_key, model, mode, protocol,
            include_long_context, include_long_context_extreme,
        )
    )
    return job_id


async def get(job_id: str) -> Job | None:
    """Look up a job by id. Falls back to disk for jobs that survived a restart."""
    if not is_valid_job_id(job_id):
        return None
    async with _LOCK:
        _prune_jobs_locked()
        j = _JOBS.get(job_id)
    if j is not None:
        return j
    report = None
    for path in _report_candidates(job_id):
        if not path.exists():
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
            break
        except (json.JSONDecodeError, OSError):
            continue
    if report is None:
        return None
    return Job(
        id=job_id,
        status="done",
        protocol=report.get("protocol", "anthropic"),
        base_url=report.get("base_url", ""),
        target_model=report.get("target_model", ""),
        mode=report.get("mode", "full"),
        created_at=time.time(),
        finished_at=time.time(),
        report=report,
    )


def report_path(job_id: str, protocol: str) -> Path:
    if not is_valid_job_id(job_id):
        raise ValueError("invalid job id")
    protocol_dir = JOBS_DIR / protocol
    protocol_dir.mkdir(parents=True, exist_ok=True)
    return protocol_dir / f"{job_id}.json"


def image_path(job_id: str, protocol: str) -> Path:
    if not is_valid_job_id(job_id):
        raise ValueError("invalid job id")
    protocol_dir = JOBS_DIR / protocol
    protocol_dir.mkdir(parents=True, exist_ok=True)
    return protocol_dir / f"{job_id}.jpg"


def _report_candidates(job_id: str) -> list[Path]:
    if not is_valid_job_id(job_id):
        return []
    return [
        JOBS_DIR / f"{job_id}.json",
        JOBS_DIR / "anthropic" / f"{job_id}.json",
        JOBS_DIR / "openai" / f"{job_id}.json",
        JOBS_DIR / "gemini" / f"{job_id}.json",
    ]


async def _run(
    job_id: str,
    base_url: str,
    api_key: str,
    model: str,
    mode: str,
    protocol: str,
    include_long_context: bool = False,
    include_long_context_extreme: bool = False,
) -> None:
    async with _SEMA:
        async with _LOCK:
            j = _JOBS.get(job_id)
            if j is None:
                return
            j.status = "running"
            j.started_at = time.time()

        try:
            cfg = ExecutionConfig.for_mode(Mode(mode), max_concurrent=3)
            cfg.include_long_context = include_long_context
            cfg.include_long_context_extreme = include_long_context_extreme
            # Long-context probes blow past the regular per-mode wall-clock
            # budget (60–180s). 1M-token requests alone take 2–4 minutes
            # upstream; the extreme path may also sleep 75s per tier waiting
            # for an OpenAI/Anthropic TPM window to reset before retrying
            # rate-limited probes (see _probe_tier_with_tpm_retry).
            # Without this bump asyncio.wait_for kills the runner
            # mid-detector and the user gets a misleading "fail" instead.
            if include_long_context_extreme:
                cfg.overall_timeout_s = max(cfg.overall_timeout_s, 900.0)
            elif include_long_context:
                cfg.overall_timeout_s = max(cfg.overall_timeout_s, 300.0)
            if protocol == "openai":
                outcome = await _run_openai(base_url, api_key, model, cfg)
                report_protocol = Protocol.OPENAI
                report_tier = DetectionTier.BEHAVIORAL
                tier_title = "行为/协议级验证"
                tier_message = (
                    "本检测无法可靠区分高配模型真品与低配模型伪装。"
                    "我们检测的是中转站接口是否符合 OpenAI Chat Completions 协议规范、"
                    "能力是否完整、usage 字段是否符合官方响应形状。"
                )
            elif protocol == "gemini":
                outcome = await _run_gemini(base_url, api_key, model, cfg)
                report_protocol = Protocol.GEMINI
                report_tier = DetectionTier.PROTOCOL
                tier_title = "协议级验证"
                tier_message = (
                    "本检测通过 OpenAI 兼容协议 (POST /chat/completions) 探测 Gemini 中转站,"
                    "验证响应字段、tool 调用、结构化输出、流式一致性和 usage 字段是否符合 OpenAI 规范。"
                    "它不提供签名回放或绝对模型真伪证明。"
                )
            elif protocol == "anthropic":
                outcome = await _run_anthropic(base_url, api_key, model, cfg)
                report_protocol = Protocol.ANTHROPIC
                report_tier = DetectionTier.SIGNATURE_ROUNDTRIP
                tier_title = "签名回放验证"
                tier_message = (
                    "检测会回传原始 thinking block,再发送篡改单字节的对照请求。"
                    "只有原始块被接受、篡改块被明确拒绝才通过。"
                    "这是高强度协议证据,但不是本地公钥验签或绝对真伪证明。"
                )
            else:
                raise ValueError(f"unsupported protocol: {protocol}")

            run_error = fatal_run_error(outcome.results)
            score = 0.0 if run_error else compute_total(outcome.results)
            verdict = effective_verdict(score, outcome.results)
            summary = run_error or summary_text(score, verdict)

            self_id: str | None = None
            brands: list[str] = []
            for r in outcome.results:
                if r.name != "identity" or not isinstance(r.details, dict):
                    continue
                text = r.details.get("response_text")
                if isinstance(text, str) and text.strip():
                    self_id = text.strip()
                b = r.details.get("detected_non_anthropic_brands")
                if isinstance(b, list):
                    brands = [x for x in b if isinstance(x, str)]
                break

            report = DetectionReport(
                protocol=report_protocol,
                tier=report_tier,
                tier_title=tier_title,
                tier_message=tier_message,
                base_url=base_url,
                api_key_masked=mask_api_key(api_key),
                target_model=model,
                mode=Mode(mode),
                timestamp=datetime.now(timezone.utc),
                total_score=score,
                verdict=verdict,
                results=outcome.results,
                performance=outcome.performance,
                summary=summary,
                run_error=run_error,
                self_reported_identity=self_id,
                detected_non_anthropic_brands=brands,
            )
            report_dict = redact_secret(json.loads(report.model_dump_json()), api_key)
            report_path(job_id, protocol).write_text(
                json.dumps(report_dict, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )

            async with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].status = "done"
                    _JOBS[job_id].protocol = protocol
                    _JOBS[job_id].report = report_dict
                    _JOBS[job_id].finished_at = time.time()

        except Exception as e:  # noqa: BLE001 — bubble error into job state
            async with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].status = "error"
                    _JOBS[job_id].error = redact_text(
                        f"{type(e).__name__}: {e}", api_key
                    )
                    _JOBS[job_id].finished_at = time.time()


async def _run_anthropic(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
):
    from relay_detector.protocols.anthropic import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url, api_key, timeout=cfg.request_timeout_s, trust_env=False
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        return await runner.run(model)


async def _run_openai(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
):
    from relay_detector.protocols.openai import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url, api_key, timeout=cfg.request_timeout_s, trust_env=False
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        return await runner.run(model)


async def _run_gemini(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
):
    from relay_detector.protocols.gemini import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url, api_key, timeout=cfg.request_timeout_s, trust_env=False
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        return await runner.run(model)

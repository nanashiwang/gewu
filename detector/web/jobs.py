"""Job queue for HTTP-driven detections.

Wraps the same Runner the CLI uses. Single uvicorn worker, in-process state
guarded by an asyncio lock. Task metadata and completed evidence are persisted;
restarts mark pending work interrupted without replaying requests. API keys are NEVER stored on a
Job or persisted — the raw key exists only in the running task's local scope
and reflected copies are redacted before reports or errors are retained.
"""

from __future__ import annotations

import asyncio
import json
import hashlib
import logging
import os
import re
import secrets
import time
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from relay_detector.models import (
    DetectionReport,
    DetectionTier,
    ExecutionConfig,
    Mode,
    Protocol,
)
from relay_detector.scorer import (
    compute_total,
    effective_verdict,
    fatal_run_error,
    summary_text,
)
from relay_detector.ranking import unreviewed_ranking_evidence, baseline_reference
from .security import REDACTED, redact_secret, redact_text
from . import deployment_gate, report_access
from relay_detector.core.runner import ProgressObserver
from relay_detector.core.scoring_policy import SCORING_VERSION, PROBE_VERSION


JobStatus = Literal["queued", "running", "done", "error", "cancelled", "interrupted"]
TERMINAL_STATUSES = {"done", "error", "cancelled", "interrupted"}

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
    wire_api: str | None = None
    responses_suite: str = "core"
    status: JobStatus = "queued"
    base_url: str = ""
    target_model: str = ""
    mode: str = "full"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    report: dict[str, Any] | None = None
    error: str | None = None
    progress: dict[str, Any] = field(default_factory=lambda: {"stage": "queued", "checks": []})
    partial_results: list[dict[str, Any]] = field(default_factory=list)
    cancel_token_hash: str = ""
    access_version: int = 0


_JOBS: dict[str, Job] = {}
_LOCK = asyncio.Lock()
_TASKS: dict[str, asyncio.Task] = {}
_STOP_REASONS: dict[str, str] = {}
_ACCEPTING = True


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _state_path(job_id: str) -> Path:
    if not is_valid_job_id(job_id):
        raise ValueError("invalid job id")
    # Not .json: leaderboard/report scanners must never ingest task metadata.
    return JOBS_DIR / ".task_state" / f"{job_id}.state"


def _save_state(job: Job) -> None:
    state = {item.name: getattr(job, item.name) for item in fields(Job) if item.name != "report"}
    _atomic_json(_state_path(job.id), state)


def _load_report(job_id: str) -> dict | None:
    for path in _report_candidates(job_id):
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(report, dict):
                if ".private_reports" in path.relative_to(JOBS_DIR).parts:
                    report.setdefault("_web_access", report_access.VERSION)
                return report
        except (OSError, ValueError):
            continue
    return None


def _probe_version(suite: str) -> str:
    if suite == "extended":
        from relay_detector.protocols.openai.responses_extended import EXTENDED_PROBE_VERSION
        return EXTENDED_PROBE_VERSION
    return PROBE_VERSION


def _finish_failure(job: Job, status: JobStatus, message: str) -> None:
    job.status, job.error, job.finished_at = status, message, time.time()
    job.progress["stage"] = status
    for check in job.progress.get("checks", []):
        if check["status"] in {"pending", "running"}:
            check["status"] = "interrupted"
    completed_names = {row["name"] for row in job.partial_results}
    unfinished = [
        {"name": check["name"], "display_name": check["label"], "status": "error",
         "score": 0, "weight": 0, "error": message, "details": {"interrupted": True}}
        for check in job.progress.get("checks", [])
        if check["status"] == "interrupted" and check["name"] not in completed_names
    ]
    # Preserve completed evidence, even when cancellation happened before the
    # first probe. run_error prevents this partial report from receiving a score.
    report = DetectionReport(
        scoring_version=SCORING_VERSION, probe_version=_probe_version(job.responses_suite),
        protocol=Protocol(job.protocol), tier=DetectionTier.PROTOCOL,
        wire_api=job.wire_api,
        tier_title="未完成的检测", tier_message="仅保留已经完成的证据，本次暂不计分。",
        base_url=job.base_url, api_key_masked=REDACTED, target_model=job.target_model,
        mode=Mode(job.mode), timestamp=datetime.now(timezone.utc),
        total_score=0, verdict="failed", results=[*job.partial_results, *unfinished],
        summary=message, run_error=message,
        ranking_evidence=unreviewed_ranking_evidence(Protocol(job.protocol), job.target_model, Mode(job.mode)),
    )
    job.report = json.loads(report.model_dump_json())
    job.report["performance_complete"] = False
    if job.access_version:
        job.report["_web_access"] = job.access_version
    _atomic_json(report_path(job.id, job.protocol, private=bool(job.access_version)), job.report)
    job.partial_results = []
    _save_state(job)


def _load_state(job_id: str) -> Job | None:
    try:
        state = json.loads(_state_path(job_id).read_text(encoding="utf-8"))
        allowed = {item.name for item in fields(Job)} - {"report"}
        if not isinstance(state, dict) or state.get("id") != job_id or set(state) - allowed:
            return None
        job = Job(**state)
    except (OSError, ValueError, TypeError):
        return None
    job.report = _load_report(job_id)
    if job.status not in TERMINAL_STATUSES:
        if job.report is not None:
            # Process stopped after writing the report but before its state.
            job.status = "interrupted" if job.report.get("run_error") else "done"
            job.error = job.report.get("run_error")
            job.finished_at = time.time()
            job.partial_results = []
            _save_state(job)
        else:
            _finish_failure(job, "interrupted", "服务重启，本次检测已中断。已完成证据已保留；重新检测需主动提交，系统不会自动重跑。")
    return job


def startup() -> None:
    global _ACCEPTING
    for path in (JOBS_DIR / ".task_state").glob("*.state"):
        if is_valid_job_id(path.stem) and path.stem not in _JOBS:
            _load_state(path.stem)
    _ACCEPTING = True


def issue_cancel_token(job_id: str) -> str | None:
    job = _JOBS.get(job_id)
    if job is None:
        return None
    token = secrets.token_urlsafe(32)
    job.cancel_token_hash = hashlib.sha256(token.encode()).hexdigest()
    _save_state(job)
    return token


def can_cancel(job: Job, token: str) -> bool:
    return bool(token and job.cancel_token_hash and secrets.compare_digest(
        job.cancel_token_hash, hashlib.sha256(token.encode()).hexdigest(),
    ))


async def cancel(job_id: str, *, status: JobStatus = "cancelled") -> Job | None:
    job = await get(job_id)
    if job is None or job.status in TERMINAL_STATUSES:
        return job
    task = _TASKS.get(job_id)
    if task is not None:
        if job_id not in _STOP_REASONS:
            _STOP_REASONS[job_id] = status
            task.cancel()
        status = _STOP_REASONS[job_id]
        await asyncio.shield(asyncio.gather(task, return_exceptions=True))
    if job.status not in TERMINAL_STATUSES:
        message = "你已取消本次检测。已发送的请求仍可能产生费用；重新检测需主动提交。" if status == "cancelled" else "服务正在重启，本次检测已中断。已完成证据已保留，系统不会自动重跑。"
        _finish_failure(job, status, message)
    _STOP_REASONS.pop(job_id, None)
    return job


async def shutdown() -> None:
    global _ACCEPTING
    _ACCEPTING = False
    await asyncio.gather(*(cancel(job_id, status="interrupted") for job_id in list(_TASKS)))


def _task_finished(job_id: str, task: asyncio.Task) -> None:
    if _TASKS.get(job_id) is task:
        _TASKS.pop(job_id, None)
    if task.cancelled():
        job = _JOBS.get(job_id)
        status = _STOP_REASONS.pop(job_id, "interrupted")
        if job is not None and job.status not in TERMINAL_STATUSES:
            message = "你已取消本次检测。已发送的请求仍可能产生费用；重新检测需主动提交。" if status == "cancelled" else "服务重启，本次检测已中断。已完成证据已保留，系统不会自动重跑。"
            try:
                _finish_failure(job, status, message)
            except OSError:
                logging.getLogger("gewu").error("Could not persist interrupted detection state")
    if not task.cancelled() and task.exception() is not None:
        logging.getLogger("gewu").error("Detection task could not persist its final state (%s)", type(task.exception()).__name__)


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
        if job.status in TERMINAL_STATUSES and job.finished_at is not None
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
            if job.status in TERMINAL_STATUSES and job.finished_at is not None
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
    wire_api: str = "chat_completions",
    owner_token: str | None = None,
    account_owner_secret: str | None = None,
    responses_suite: str = "core",
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
    if responses_suite not in {"core", "extended"} or (responses_suite == "extended" and (protocol != "openai" or wire_api != "responses")):
        raise ValueError("Responses 检测方案与接口不匹配")
    job_id = _new_job_id()
    if account_owner_secret:
        owner_token = report_access.account_owner(account_owner_secret, job_id)
    job = Job(
        id=job_id,
        protocol=protocol,
        wire_api=wire_api if protocol in {"openai", "gemini"} else None,
        base_url=redact_text(base_url, api_key),
        target_model=redact_text(model, api_key),
        mode=mode,
        access_version=report_access.VERSION if owner_token else 0,
        responses_suite=responses_suite,
    )
    async with _LOCK:
        with deployment_gate.admission(JOBS_DIR):
            if not _ACCEPTING:
                raise deployment_gate.MaintenanceError("detection service is restarting")
            _prune_jobs_locked()
            pending = sum(job.status in {"queued", "running"} for job in _JOBS.values())
            if pending >= _MAX_PENDING_JOBS:
                raise JobQueueFull("detection queue is full")
            if owner_token:
                report_access.create(JOBS_DIR, job_id, owner_token, account_managed=bool(account_owner_secret))
            _save_state(job)
            _JOBS[job_id] = job
            task = asyncio.create_task(
                _run(job_id, base_url, api_key, model, mode, protocol,
                     include_long_context, include_long_context_extreme, wire_api)
            )
            _TASKS[job_id] = task
            task.add_done_callback(lambda completed: _task_finished(job_id, completed))
    return job_id


def deployment_status() -> dict:
    # Check both states and task completion. A terminal report can be saved
    # before its upstream client/context managers finish releasing resources.
    return {
        "protocol": 1,
        "accepting": _ACCEPTING and deployment_gate.accepting(JOBS_DIR),
        "pending_jobs": sum(j.status in {"queued", "running"} for j in _JOBS.values()),
        "active_tasks": sum(not task.done() for task in _TASKS.values()),
    }


async def get(job_id: str) -> Job | None:
    """Look up a job by id. Falls back to disk for jobs that survived a restart."""
    if not is_valid_job_id(job_id):
        return None
    async with _LOCK:
        _prune_jobs_locked()
        j = _JOBS.get(job_id)
    if j is not None:
        return j
    saved = _load_state(job_id)
    if saved is not None:
        return saved
    report = _load_report(job_id)
    if report is None:
        return None
    return Job(
        id=job_id,
        status="done",
        protocol=report.get("protocol", "anthropic"),
        wire_api=report.get("wire_api"),
        base_url=report.get("base_url", ""),
        target_model=report.get("target_model", ""),
        mode=report.get("mode", "full"),
        created_at=_report_timestamp(report),
        finished_at=_report_timestamp(report),
        report=report,
    )


def _report_timestamp(report: dict) -> float:
    try:
        return datetime.fromisoformat(str(report.get("timestamp", "")).replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError):
        return 0.0


def report_path(job_id: str, protocol: str, *, private: bool | None = None) -> Path:
    if not is_valid_job_id(job_id):
        raise ValueError("invalid job id")
    if protocol not in {item.value for item in Protocol}:
        raise ValueError("invalid protocol")
    if private is None:
        private = report_access.restricted(JOBS_DIR, job_id)
    protocol_dir = (JOBS_DIR / ".private_reports" if private else JOBS_DIR) / protocol
    protocol_dir.mkdir(parents=True, exist_ok=True)
    return protocol_dir / f"{job_id}.json"


def image_path(job_id: str, protocol: str) -> Path:
    return report_path(job_id, protocol).with_suffix(".jpg")


def _report_candidates(job_id: str) -> list[Path]:
    if not is_valid_job_id(job_id):
        return []
    return [
        JOBS_DIR / ".private_reports" / protocol / f"{job_id}.json"
        for protocol in ("anthropic", "openai", "gemini")
    ] + [
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
    wire_api: str = "chat_completions",
) -> None:
    async with _SEMA:
        async with _LOCK:
            j = _JOBS.get(job_id)
            if j is None:
                return
            j.status = "running"
            j.started_at = time.time()
            j.progress["stage"] = "starting"

        def record_progress(event: dict) -> None:
            safe = redact_secret(event, api_key)
            j.progress = {"stage": safe["stage"], "checks": safe["checks"]}
            j.partial_results = safe["results"]
            _save_state(j)

        try:
            _save_state(j)
            cfg = ExecutionConfig.for_mode(Mode(mode), max_concurrent=3, responses_suite=j.responses_suite)
            from relay_detector.wire_apis import resolve_wire_api
            resolve_wire_api(protocol, wire_api if protocol != "anthropic" else None)
            if protocol == "openai":
                cfg.openai_wire_api = wire_api
            elif protocol == "gemini":
                cfg.gemini_wire_api = wire_api
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
                outcome = await _run_openai(base_url, api_key, model, cfg, record_progress)
                report_protocol = Protocol.OPENAI
                report_tier = DetectionTier.BEHAVIORAL
                tier_title = "行为/协议级验证"
                tier_message = (
                    "本检测无法可靠区分高配模型真品与低配模型伪装。"
                    "我们检测的是中转站接口是否符合 OpenAI Chat Completions 协议规范、"
                    "能力是否完整、usage 字段是否符合官方响应形状。"
                )
                from relay_detector.model_catalog import is_generic_chat
                if is_generic_chat(model):
                    tier_title = "基础兼容检测"
                    tier_message = (
                        "仅检查本次请求与流式输出；分数只反映已运行的基础项目。"
                        "未验证模型身份、工具能力、计费准确性或该厂商原生协议，"
                        "不能与完整 OpenAI 检测分数直接比较。"
                    )
                if wire_api == "responses":
                    from relay_detector.protocols.openai.responses import TIER_MESSAGE
                    tier_title = "Responses 能力检测"
                    tier_message = TIER_MESSAGE
            elif protocol == "gemini":
                outcome = await _run_gemini(base_url, api_key, model, cfg, record_progress)
                report_protocol = Protocol.GEMINI
                report_tier = DetectionTier.PROTOCOL
                tier_title = "协议级验证"
                tier_message = (
                    "本检测通过 OpenAI 兼容协议 (POST /chat/completions) 探测 Gemini 中转站,"
                    "验证响应字段、tool 调用、结构化输出、流式一致性和 usage 字段是否符合 OpenAI 规范。"
                    "它不提供签名回放或绝对模型真伪证明。"
                )
            elif protocol == "anthropic":
                outcome = await _run_anthropic(base_url, api_key, model, cfg, record_progress)
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

            if protocol == "gemini" and wire_api != "chat_completions":
                from relay_detector.wire_apis import WIRE_APIS, capability_notes
                tier_title = WIRE_APIS[wire_api]["label"] + " 能力检测"
                tier_message = capability_notes(wire_api)[0] + capability_notes(wire_api)[3]

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
                scoring_version=SCORING_VERSION, probe_version=_probe_version(j.responses_suite),
                protocol=report_protocol,
                wire_api=wire_api if protocol in {"openai", "gemini"} else None,
                tier=report_tier,
                tier_title=tier_title,
                tier_message=tier_message,
                base_url=base_url,
                api_key_masked=REDACTED,
                target_model=model,
                mode=Mode(mode),
                timestamp=datetime.now(timezone.utc),
                total_score=score,
                verdict=verdict,
                results=outcome.results,
                performance=outcome.performance,
                summary=summary,
                run_error=run_error,
                ranking_evidence=unreviewed_ranking_evidence(
                    report_protocol, model, Mode(mode)
                ),
                self_reported_identity=self_id,
                detected_non_anthropic_brands=brands,
            )
            report_dict = redact_secret(json.loads(report.model_dump_json()), api_key)
            if _JOBS[job_id].access_version:
                report_dict["_web_access"] = _JOBS[job_id].access_version
            report_dict["ranking_evidence"]["baseline_version"] = baseline_reference(report_protocol, model, Mode(mode), report=report_dict)
            if wire_api in {"responses", "interactions", "generate_content"}:
                report_dict["ranking_evidence"]["baseline_version"] = "not_available"
            _atomic_json(report_path(job_id, protocol, private=bool(_JOBS[job_id].access_version)), report_dict)

            async with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].status = "done"
                    _JOBS[job_id].protocol = protocol
                    _JOBS[job_id].report = report_dict
                    _JOBS[job_id].finished_at = time.time()
                    _JOBS[job_id].progress["stage"] = "done"
                    _JOBS[job_id].partial_results = []
                    _save_state(_JOBS[job_id])

        except Exception as e:  # noqa: BLE001 — bubble error into job state
            async with _LOCK:
                if job_id in _JOBS:
                    _finish_failure(_JOBS[job_id], "error", redact_text(f"{type(e).__name__}: {e}", api_key))


async def _run_anthropic(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
    on_progress: ProgressObserver | None = None,
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
        runner.on_progress = on_progress
        return await runner.run(model)


async def _run_openai(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
    on_progress: ProgressObserver | None = None,
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
        runner.on_progress = on_progress
        return await runner.run(model)


async def _run_gemini(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
    on_progress: ProgressObserver | None = None,
):
    from relay_detector.protocols.gemini import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url, api_key, timeout=cfg.request_timeout_s, trust_env=False,
        wire_api=cfg.gemini_wire_api,
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        runner.on_progress = on_progress
        return await runner.run(model)

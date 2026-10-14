"""Operator-only official sampling: explicit execution, bounded IO, separate review.

Receipts record collection constraints; they are not provider attestations. An
operator must verify provenance before publishing a hash-bound approval.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from importlib import import_module
from pathlib import Path
from uuid import uuid4

import httpx

from .baselines import ROOT, _read
from .core.comparison_guard import comparison_reasons
from .core.models import ExecutionConfig, Mode, Protocol
from .core.scoring_policy import PROBE_VERSION, SCORING_VERSION
from .wire_apis import resolve_wire_api

KEY_ENV = {p: f"GEWU_OFFICIAL_{p.upper()}_KEY" for p in ("anthropic", "openai", "gemini")}


@dataclass(frozen=True)
class Limits:
    requests: int = 40
    output_tokens: int = 65536
    payload_bytes: int = 1048576

    def __post_init__(self):
        for value, maximum in ((self.requests, 100), (self.output_tokens, 262144), (self.payload_bytes, 4194304)):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError("采样预算必须为正整数，且不能超过安全上限")


def collection_plan(protocol: str, model: str, mode: str, wire_api: str | None, limits: Limits) -> dict:
    if protocol not in KEY_ENV or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", model) or ".." in model:
        raise ValueError("请选择明确的官方协议和模型 ID，不接受路径或自动选模")
    wire = resolve_wire_api(protocol, wire_api)
    config = ExecutionConfig.for_mode(Mode(mode), max_concurrent=1, persist_cache=False, stop_on_auth_failure=True, allow_reference_collection=False)
    if protocol == "openai":
        config.openai_wire_api = wire
    if protocol == "gemini":
        config.gemini_wire_api = wire
    module = import_module(f"relay_detector.protocols.{protocol}")
    runner = module.build_runner(None, module.build_detectors(config.mode), config)
    checks = runner._select_detectors(model)
    origin = {"anthropic": "https://api.anthropic.com", "openai": "https://api.openai.com/v1",
              "gemini": "https://generativelanguage.googleapis.com/v1beta"}[protocol]
    if protocol == "gemini" and wire == "chat_completions":
        origin += "/openai"
    return {"protocol": protocol, "model": model, "mode": mode, "wire_api": wire,
            "source_url": origin, "key_env": KEY_ENV[protocol], "limits": asdict(limits),
            "checks": [d.name for d in checks], "scoring_version": SCORING_VERSION,
            "probe_version": PROBE_VERSION, "config": config.model_dump(mode="json")}


class BudgetTransport(httpx.AsyncBaseTransport):
    """Reserve the full declared output before every send, including retries."""
    def __init__(self, plan: dict, inner: httpx.AsyncBaseTransport | None = None):
        self.plan, self.limits = plan, Limits(**plan["limits"])
        self.inner = inner or httpx.AsyncHTTPTransport(retries=0, trust_env=False)
        self.requests = self.output_tokens = self.payload_bytes = 0
        self.halted: str | None = None
        self.lock = asyncio.Lock()

    def stop(self, reason):
        self.halted = reason
        raise ValueError(reason)

    def _reservation(self, request: httpx.Request) -> int:
        wire, root, model = (self.plan[k] for k in ("wire_api", "source_url", "model"))
        if request.method != "POST":
            self.stop("官方采样拒绝非检测请求")
        paths = {"messages": ["/v1/messages", "/v1/messages/count_tokens"],
                 "chat_completions": ["/chat/completions"], "responses": ["/responses"],
                 "interactions": ["/interactions"],
                 "generate_content": [f"/models/{model}:generateContent", f"/models/{model}:streamGenerateContent?alt=sse"]}[wire]
        if str(request.url) not in {root + path for path in paths}:
            self.stop("官方采样拒绝非指定官方端点")
        body = json.loads(request.content)
        if not isinstance(body, dict) or (wire != "generate_content" and body.get("model") != model):
            self.stop("官方采样拒绝模型变更")
        if wire == "messages":
            cap = 0 if request.url.path.endswith("/count_tokens") else body.get("max_tokens")
        elif wire == "generate_content":
            cfg = body.get("generationConfig", {})
            cap = cfg.get("maxOutputTokens")
            if cfg.get("candidateCount", 1) != 1:
                self.stop("官方采样仅允许单个候选")
        elif wire == "interactions":
            cap = body.get("generation_config", {}).get("max_output_tokens")
        else:
            cap = body.get("max_output_tokens") if wire == "responses" else body.get("max_completion_tokens", body.get("max_tokens"))
            if body.get("n", 1) != 1:
                self.stop("官方采样仅允许单个候选")
        if wire in {"responses", "interactions"} and body.get("store") is not False:
            self.stop("官方采样必须禁用服务端会话存储")
        if type(cap) is not int or cap < 0 or (cap == 0 and not request.url.path.endswith("/count_tokens")):
            self.stop("官方采样请求缺少有效输出上限")
        # Only locally defined function tools; no hosted search or remote tools.
        if body.get("mcp_servers"):
            self.stop("官方采样拒绝远程工具服务")
        for tool in body.get("tools", []):
            allowed = isinstance(tool, dict)
            if allowed and wire == "messages":
                allowed = set(tool) <= {"name", "description", "input_schema", "strict", "cache_control"} and isinstance(tool.get("input_schema"), dict)
            elif allowed and wire == "generate_content":
                allowed = set(tool) == {"functionDeclarations"} and isinstance(tool["functionDeclarations"], list) and bool(tool["functionDeclarations"])
            elif allowed:
                allowed = tool.get("type") == "function"
            if not allowed:
                self.stop("官方采样拒绝托管工具")
        return cap

    async def handle_async_request(self, request):
        async with self.lock:
            if self.halted:
                raise ValueError(self.halted)
            try:
                cap = self._reservation(request)
            except (ValueError, TypeError, KeyError, AttributeError):
                self.stop(self.halted or "官方采样请求格式无效")
            size = len(request.content)
            if self.requests + 1 > self.limits.requests or self.output_tokens + cap > self.limits.output_tokens or self.payload_bytes + size > self.limits.payload_bytes:
                self.stop("官方采样达到请求、输出或输入字节预算，已停止")
            self.requests += 1
            self.output_tokens += cap
            self.payload_bytes += size
        try:
            response = await self.inner.handle_async_request(request)
        except httpx.TransportError:
            self.stop("官方采样网络失败，停止后续请求")
        if response.status_code in {401, 403, 408, 429} or response.status_code >= 500 or 300 <= response.status_code < 400:
            await response.aclose()
            self.stop(f"官方采样收到 HTTP {response.status_code}，停止后续请求")
        response.stream = _BoundedStream(response.stream, self)
        return response

    async def aclose(self):
        await self.inner.aclose()

    def receipt(self):
        return {"requests": self.requests, "reserved_output_tokens": self.output_tokens,
                "payload_bytes": self.payload_bytes, "halted": self.halted}


class _BoundedStream(httpx.AsyncByteStream):
    def __init__(self, stream, budget):
        self.stream, self.budget = stream, budget

    async def __aiter__(self):
        size = 0
        try:
            async for chunk in self.stream:
                size += len(chunk)
                if size > 2 * 1024 * 1024:
                    self.budget.stop("官方采样响应超过大小限制")
                yield chunk
        except httpx.TransportError:
            self.budget.stop("官方采样响应中断，停止后续请求")

    async def aclose(self):
        await self.stream.aclose()


def _json(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def _safe_directory(path: Path, *, mode: int = 0o700):
    # Check before mkdir so a configured symlink cannot redirect writes.
    if any(p.is_symlink() for p in (path, *path.parents) if p != Path("/tmp")):
        raise ValueError("采样和审核目录不能经过符号链接")
    path.mkdir(parents=True, exist_ok=True, mode=mode)


def _exclusive(path: Path, content: bytes, *, mode: int = 0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())


async def collect(plan: dict, destination: Path) -> dict:
    from .cli import _run_detect
    key = os.environ.get(plan["key_env"], "").strip()
    if not key:
        raise ValueError(f"缺少专用官方凭据变量 {plan['key_env']}；未发送请求")
    _safe_directory(destination)
    budget = BudgetTransport(plan)

    async def setup(client):
        old = client._client
        client._client = httpx.AsyncClient(base_url=old.base_url, headers=old.headers,
            timeout=old.timeout, follow_redirects=False, trust_env=False, transport=budget)
        await old.aclose()

    try:
        report = await _run_detect(Protocol(plan["protocol"]), plan["source_url"], key,
            plan["model"], ExecutionConfig(**plan["config"]), None, client_setup=setup, quiet=True)
    finally:
        await budget.aclose()
    data = report.model_dump(mode="json")
    # No credential fragments in candidates, even if a provider echoes a key.
    masked = data.get("api_key_masked")
    def scrub(value):
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items() if k != "traceback"}
        if isinstance(value, list):
            return [scrub(v) for v in value]
        if isinstance(value, str):
            value = value.replace(key, "[redacted]")
            return value.replace(masked, "[redacted]") if isinstance(masked, str) and masked else value
        return value
    data = scrub(data)
    data["api_key_masked"] = "[redacted]"
    reasons = comparison_reasons(data, data)
    if budget.halted:
        reasons.append(budget.halted)
    candidate = {"version": 1, "plan": plan, "collection": budget.receipt(), "report": data}
    content = _json(candidate)
    name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "_" + uuid4().hex[:12] + ".json"
    _exclusive(destination / name, content)
    return {"candidate": name, "sha256": hashlib.sha256(content).hexdigest(),
            "eligible_for_review": not reasons, "reasons": reasons, **budget.receipt()}


def approve(candidate_path: Path, expected_sha256: str, root: Path = ROOT) -> dict:
    content, candidate = _read(candidate_path)
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ValueError("候选文件 SHA256 不匹配，请重新审阅")
    if candidate.get("version") != 1:
        raise ValueError("采样凭据版本无效")
    plan, receipt, report = (candidate[k] for k in ("plan", "collection", "report"))
    if not all(isinstance(v, dict) for v in (plan, receipt, report)):
        raise ValueError("候选的计划、采样记录和报告必须为对象")
    expected_plan = collection_plan(plan["protocol"], plan["model"], plan["mode"], plan["wire_api"], Limits(**plan["limits"]))
    if plan != expected_plan or any(report.get(k) != v for k, v in {
        "protocol": plan["protocol"], "target_model": plan["model"], "mode": plan["mode"],
        "wire_api": plan["wire_api"], "base_url": plan["source_url"],
        "scoring_version": SCORING_VERSION, "probe_version": PROBE_VERSION}.items()):
        raise ValueError("采样计划与报告的端点、模型、接口或版本不一致")
    if receipt.get("halted") is not None or any(type(receipt.get(k)) is not int or not 0 < receipt[k] <= plan["limits"][limit]
        for k, limit in (("requests", "requests"), ("reserved_output_tokens", "output_tokens"), ("payload_bytes", "payload_bytes"))):
        raise ValueError("采样中止或预算记录无效")
    reasons = comparison_reasons(report, report)
    if reasons:
        raise ValueError("；".join(reasons))
    # The candidate must include every selected probe; self-consistent partial
    # reports must not be accepted merely because their weighted total matches.
    if not set(plan["checks"]).issubset({row["name"] for row in report["results"]}) or any(
        row["name"] not in plan["checks"] and row["status"] != "skip" for row in report["results"]):
        raise ValueError("报告与采样计划的探针范围不一致")
    report_content = _json(report)
    digest = hashlib.sha256(report_content).hexdigest()
    stamp = datetime.fromisoformat(report["timestamp"].replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    relative = Path(plan["protocol"]) / plan["wire_api"] / f"{plan['model']}_{plan['mode']}_{stamp}_{digest[:12]}.json"
    # Published evidence is sanitized and readable by the detector service;
    # only the operator can write. Candidates remain private (0700/0600).
    _safe_directory(root / relative.parent, mode=0o755)
    lock_fd = os.open(root / ".approval.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest_path = root / "approvals.json"
        if manifest_path.exists() or manifest_path.is_symlink():
            _, manifest = _read(manifest_path)
            if manifest.get("version") != 1 or not isinstance(manifest.get("approvals"), dict):
                raise ValueError("审核清单无效，拒绝覆盖")
        else:
            manifest = {"version": 1, "approvals": {}}
        _exclusive(root / relative, report_content, mode=0o644)
        manifest["approvals"][relative.as_posix()] = {"sha256": digest, "source_url": plan["source_url"],
            "candidate_sha256": expected_sha256, "reviewed_at": datetime.now(timezone.utc).isoformat()}
        fd, temp = tempfile.mkstemp(prefix=".approvals-", dir=root)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(_json(manifest))
                f.flush()
                os.fsync(f.fileno())
            os.chmod(temp, 0o644)
            os.replace(temp, manifest_path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    return {"file": relative.as_posix(), "sha256": digest, "state": "approved"}

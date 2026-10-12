"""Bounded, stateless Gemini probes. No retries, fallback, hosted tools or identity claims.

Wire formats verified against ai.google.dev/api/{interactions-api,generate-content}
on 2026-10-12. Signed history is replayed in memory, never included in reports.
"""
from __future__ import annotations

import asyncio
import codecs
import json
import re
import secrets
import time
from contextlib import aclosing
from urllib.parse import urlsplit

import httpx

from ...core.detectors_base import ActiveDetector
from ...core.models import ExecutionConfig, Mode, UsageMetrics
from ...core.runner import Runner
from .client import GeminiAPIError, _parse_openai_sse

REQUEST_LIMITS = {Mode.QUICK: 2, Mode.STANDARD: 3, Mode.FULL: 5}
MAX_OUTPUT_TOKENS = 4096
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def model_id(model: str) -> str:
    value = model.removeprefix("models/")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", value) or ".." in value:
        raise ValueError("Gemini 原生模型 ID 无效，请使用 models/ 后的模型名称")
    return value


class NativeGeminiClient:
    def __init__(self, base_url, api_key, timeout=30, *, wire_api, trust_env=True):
        if wire_api not in {"interactions", "generate_content"}:
            raise ValueError("Gemini 原生接口类型无效")
        self.wire_api = wire_api
        root = base_url.rstrip("/")
        parts = urlsplit(root)
        if parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError("API 地址不能包含凭据、查询参数或片段")
        self.base_url = root if parts.path else root + "/v1beta"
        self._client = httpx.AsyncClient(timeout=timeout, trust_env=trust_env, follow_redirects=False,
            headers={"x-goog-api-key": api_key, "content-type": "application/json"})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self._client.aclose()

    async def aclose(self):
        await self._client.aclose()

    async def request(self, model, body, *, stream=False):
        name = model_id(model)
        if self.wire_api == "interactions":
            path = "/interactions"
            body = {**body, "model": name, "store": False,
                    "generation_config": {"max_output_tokens": MAX_OUTPUT_TOKENS}}
            if stream:
                body["stream"] = True
        else:
            path = f"/models/{name}:" + ("streamGenerateContent?alt=sse" if stream else "generateContent")
            body = {**body, "store": False, "generationConfig": {
                **body.get("generationConfig", {}), "candidateCount": 1, "maxOutputTokens": MAX_OUTPUT_TOKENS}}
        start = time.perf_counter()
        async with self._client.stream("POST", self.base_url + path, json=body) as response, aclosing(response.aiter_bytes()) as byte_stream:
            if not 200 <= response.status_code < 300:
                # Never include upstream bodies which might echo credentials.
                raise GeminiAPIError(response.status_code, "Gemini native request rejected")
            size = 0

            async def lines():
                nonlocal size
                buffer = ""
                decoder = codecs.getincrementaldecoder("utf-8")()
                async for chunk in byte_stream:
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise ValueError("Gemini 响应超过检测大小限制")
                    buffer += decoder.decode(chunk)
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        yield line.rstrip("\r")
                buffer += decoder.decode(b"", final=True)
                if buffer:
                    yield buffer.rstrip("\r")

            if stream:
                if "text/event-stream" not in response.headers.get("content-type", "").lower():
                    raise ValueError("Gemini 流式响应不是 SSE")
                async with aclosing(lines()) as source, aclosing(_parse_openai_sse(source)) as events:
                    async for event in events:
                        yield event, int((time.perf_counter() - start) * 1000)
            else:
                chunks = []
                async for chunk in byte_stream:
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise ValueError("Gemini 响应超过检测大小限制")
                    chunks.append(chunk)
                yield json.loads(b"".join(chunks)), int((time.perf_counter() - start) * 1000)


def _object(value):
    if not isinstance(value, dict) or value.get("_parse_error"):
        raise ValueError("Gemini 返回无效 JSON")
    error = value.get("error")
    if error:
        if isinstance(error, dict) and (error.get("code") in (401, 403) or error.get("status") in ("UNAUTHENTICATED", "PERMISSION_DENIED")):
            raise GeminiAPIError(401, "Gemini structured authentication error")
        raise ValueError("Gemini 返回错误对象")
    return value


def _parts_text(parts):
    if not isinstance(parts, list) or any(not isinstance(p, dict) for p in parts):
        raise ValueError("Gemini 输出内容格式无效")
    return "".join(p["text"] for p in parts if isinstance(p.get("text"), str) and not p.get("thought"))


def _content(response, api, *, calls=False):
    _object(response)
    if api == "interactions":
        if response.get("object") != "interaction" or not isinstance(response.get("id"), str) or not response["id"]:
            raise ValueError("Interactions 缺少有效对象类型或 ID")
        if response.get("status") != ("requires_action" if calls else "completed"):
            raise ValueError("Interactions 未成功完成预期阶段")
        steps = response.get("steps")
        if not isinstance(steps, list) or not steps or any(not isinstance(s, dict) for s in steps):
            raise ValueError("Interactions 缺少有效 steps")
        allowed = {"thought", "model_output"} | ({"function_call"} if calls else set())
        if any(s.get("type") not in allowed for s in steps):
            raise ValueError("Interactions 返回非预期输出类型")
        text = "".join(_parts_text(s.get("content")) for s in steps if s.get("type") == "model_output")
        return text, [s for s in steps if s.get("type") == "function_call"], steps
    candidates = response.get("candidates")
    if response.get("promptFeedback", {}).get("blockReason"):
        raise ValueError("Gemini 拒绝本次探针，能力未验证")
    if not isinstance(candidates, list) or len(candidates) != 1 or not isinstance(candidates[0], dict):
        raise ValueError("Gemini 缺少唯一候选结果")
    candidate = candidates[0]
    if candidate.get("finishReason") != "STOP":
        raise ValueError("Gemini 候选未正常结束")
    content = candidate.get("content", {})
    if not isinstance(content, dict) or content.get("role") != "model":
        raise ValueError("Gemini 缺少模型回复")
    parts = content.get("parts")
    text = _parts_text(parts)
    functions = [p["functionCall"] for p in parts if "functionCall" in p]
    if functions and not calls:
        raise ValueError("Gemini 返回非预期函数调用")
    return text, functions, content


class NativeSession:
    def __init__(self, base, limit):
        self.base, self.limit, self.wire_api = base, limit, base.wire_api
        self.request_count = self.backoff_events = 0
        self.total_usage = UsageMetrics()
        self.usage_complete = True
        self.blocked = False
        self._ttft_samples_ms = []
        self._sema = asyncio.Semaphore(1)

    def body(self, prompt, *, schema=None, tools=None, history=None):
        if self.wire_api == "interactions":
            body = {"input": history if history is not None else prompt}
            if schema:
                body["response_format"] = {"type": "text", "mime_type": "application/json", "schema": schema}
            if tools:
                body["tools"] = [{"type": "function", **tools}]
        else:
            body = {"contents": history if history is not None else [{"role": "user", "parts": [{"text": prompt}]}]}
            if schema:
                body["generationConfig"] = {"responseMimeType": "application/json", "responseJsonSchema": schema}
            if tools:
                body["tools"] = [{"functionDeclarations": [tools]}]
        return body

    def usage(self, response):
        if self.wire_api == "interactions":
            usage = response.get("usage", {})
            keys = ("total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_tokens")
        else:
            usage = response.get("usageMetadata", {})
            keys = ("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount")
        if not isinstance(usage, dict):
            raise ValueError("Gemini 缺少有效 usage")
        values = [usage.get(k, 0 if i == 2 else None) for i, k in enumerate(keys)]
        if any(type(v) is not int or v < 0 for v in values) or values[3] != sum(values[:3]):
            raise ValueError("Gemini 用量缺失或不一致")
        self.total_usage.add(UsageMetrics(input_tokens=values[0], output_tokens=values[1] + values[2]))

    async def request(self, model, body, *, stream=False, calls=False):
        async with self._sema:
            if self.blocked or self.request_count >= self.limit:
                raise ValueError("基础检测已停止或请求预算耗尽")
            self.request_count += 1
            try:
                if stream:
                    return await self._stream(model, body)
                async with aclosing(self.base.request(model, body)) as events:
                    items = [item async for item, _ in events]
                if len(items) != 1:
                    raise ValueError("Gemini 响应数量无效")
                result = _content(items[0], self.wire_api, calls=calls)
                self.usage(items[0])
                return result
            except BaseException as error:
                self.usage_complete = False
                if isinstance(error, GeminiAPIError) and error.status in {401, 403}:
                    self.blocked = True
                raise

    async def _stream(self, model, body):
        async with aclosing(self.base.request(model, body, stream=True)) as events:
            return await self._read_stream(events)

    async def _read_stream(self, events):
        text, identity, terminal, done = [], None, None, False
        steps = {}
        latest = None
        async for raw, elapsed in events:
            event = _object(raw)
            if done:
                raise ValueError("Gemini 结束标记后仍返回事件")
            if event.get("_done"):
                if terminal is None:
                    raise ValueError("Gemini 流缺少成功结束事件")
                done = True
                continue
            if terminal is not None:
                raise ValueError("Gemini 完成后仍返回事件")
            delta = ""
            if self.wire_api == "interactions":
                kind = event.get("event_type")
                if kind == "interaction.created":
                    interaction = event.get("interaction", {})
                    if identity or not isinstance(interaction, dict) or not isinstance(interaction.get("id"), str) or not interaction["id"]:
                        raise ValueError("Interactions created 无效或重复")
                    identity = interaction["id"]
                elif not identity:
                    raise ValueError("Interactions 缺少 created 事件")
                elif kind == "interaction.status_update":
                    if event.get("interaction_id") != identity or event.get("status") not in {"in_progress"}:
                        raise ValueError("Interactions 状态或 ID 异常")
                elif kind in {"step.start", "step.delta", "step.stop"}:
                    index = event.get("index")
                    if type(index) is not int or index < 0:
                        raise ValueError("Interactions step 索引无效")
                    if kind == "step.start":
                        step = event.get("step", {})
                        if index in steps or index != len(steps) or not isinstance(step, dict) or step.get("type") not in {"thought", "model_output"}:
                            raise ValueError("Interactions step 开始无效")
                        steps[index] = [step["type"], False]
                    else:
                        if index not in steps or steps[index][1]:
                            raise ValueError("Interactions step 顺序异常")
                        if kind == "step.stop":
                            steps[index][1] = True
                        else:
                            part = event.get("delta", {})
                            if not isinstance(part, dict):
                                raise ValueError("Interactions delta 无效")
                            if steps[index][0] == "model_output":
                                if part.get("type") != "text" or not isinstance(part.get("text"), str):
                                    raise ValueError("Interactions 非预期文本增量")
                                delta = part["text"]
                            elif part.get("type") not in {"thought", "thought_signature", "text"}:
                                raise ValueError("Interactions 非预期思考增量")
                elif kind == "interaction.completed":
                    terminal = event.get("interaction")
                    if not isinstance(terminal, dict) or terminal.get("object") != "interaction" or terminal.get("id") != identity or terminal.get("status") != "completed" or not steps or not all(s[1] for s in steps.values()):
                        raise ValueError("Interactions 完成事件无效或 step 未结束")
                else:
                    raise ValueError("Interactions 返回错误或未知事件")
            else:
                if event.get("promptFeedback", {}).get("blockReason"):
                    raise ValueError("Gemini 流被拒绝")
                candidates = event.get("candidates")
                if not isinstance(candidates, list) or len(candidates) != 1 or not isinstance(candidates[0], dict):
                    raise ValueError("Gemini 流候选无效")
                candidate = candidates[0]
                if candidate.get("index", 0) != 0:
                    raise ValueError("Gemini 流候选索引异常")
                content = candidate.get("content", {})
                if not isinstance(content, dict) or content.get("role", "model") != "model":
                    raise ValueError("Gemini 流角色异常")
                parts = content.get("parts", [])
                delta = _parts_text(parts)
                if any("functionCall" in p for p in parts):
                    raise ValueError("Gemini 流出现非预期工具调用")
                if event.get("responseId"):
                    if identity and identity != event["responseId"]:
                        raise ValueError("Gemini 流响应 ID 改变")
                    identity = event["responseId"]
                latest = event
                if candidate.get("finishReason"):
                    if candidate["finishReason"] != "STOP":
                        raise ValueError("Gemini 流未正常结束")
                    terminal = latest
            if delta:
                if not text:
                    self._ttft_samples_ms.append(elapsed)
                text.append(delta)
        if terminal is None or not text:
            raise ValueError("Gemini 流缺少完整文本或成功结束事件")
        self.usage(terminal)
        return "".join(text)


class NativeProbe(ActiveDetector):
    weight = 1.0

    async def run(self, client, model):
        if client.blocked:
            return self.skip("基础请求未完成，停止后续请求；本项未测试")
        try:
            details, passed = await self.check(client, model)
            if self.name == "basic_request" and not passed:
                client.blocked = True
            return self._result("pass" if passed else "fail", 100 if passed else 0,
                                {"wire_api": client.wire_api, **details})
        except GeminiAPIError as error:
            if self.name == "basic_request":
                client.blocked = True
            if error.status in {404, 405}:
                return self.skip(f"接口或模型未开放（HTTP {error.status}）；未验证，不自动切换接口")
            raise
        except Exception:
            if self.name == "basic_request":
                client.blocked = True
            raise


class TextProbe(NativeProbe):
    name, display_name = "basic_request", "Gemini 原生基础回复"

    async def check(self, client, model):
        nonce = "gewu_" + secrets.token_hex(8)
        text, _, _ = await client.request(model, client.body(f"Reply with exactly this text and nothing else: {nonce}"))
        return {"expected": nonce, "observed": text[:200]}, text.strip() == nonce


class StreamProbe(NativeProbe):
    name, display_name = "gemini_stream", "Gemini 原生流式完整性"

    async def check(self, client, model):
        nonce = "gewu_" + secrets.token_hex(8)
        text = await client.request(model, client.body(f"Reply with exactly this text and nothing else: {nonce}"), stream=True)
        return {"expected": nonce, "observed": text[:200], "stream_complete": True}, text.strip() == nonce


class SchemaProbe(NativeProbe):
    name, display_name = "gemini_schema", "Gemini 原生结构化输出"

    async def check(self, client, model):
        nonce = secrets.token_hex(8)
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}, "nonce": {"type": "string"}},
                  "required": ["ok", "nonce"], "additionalProperties": False}
        text, _, _ = await client.request(model, client.body(f'Return JSON with ok=true and nonce="{nonce}".', schema=schema))
        try:
            value = json.loads(text)
        except ValueError:
            value = None
        passed = isinstance(value, dict) and set(value) == {"ok", "nonce"} and value["ok"] is True and value["nonce"] == nonce
        return {"schema_valid": passed, "observed": text[:300]}, passed


class ToolProbe(NativeProbe):
    name, display_name = "gemini_tools", "Gemini 原生工具调用往返"

    async def check(self, client, model):
        nonce = secrets.token_hex(8)
        tool = {"name": "gewu_echo", "description": "Local test function returning a receipt.",
                "parameters": {"type": "object", "properties": {"nonce": {"type": "string"}}, "required": ["nonce"]}}
        prompt = f'Call gewu_echo with nonce="{nonce}". After the function returns, reply with only its receipt.'
        body = client.body(prompt, tools=tool)
        _, calls, history = await client.request(model, body, calls=True)
        valid = len(calls) == 1 and isinstance(calls[0], dict) and calls[0].get("name") == "gewu_echo"
        arg_key = "arguments" if client.wire_api == "interactions" else "args"
        valid = valid and calls[0].get(arg_key) == {"nonce": nonce}
        if client.wire_api == "interactions":
            valid = valid and isinstance(calls[0].get("id"), str) and bool(calls[0]["id"])
        if not valid:
            return {"arguments_valid": False, "roundtrip_complete": False}, False
        receipt = "receipt_" + secrets.token_hex(8)
        if client.wire_api == "interactions":
            followup = [{"type": "user_input", "content": prompt}, *history, {"type": "function_result", "name": tool["name"],
                        "call_id": calls[0]["id"], "result": [{"type": "text", "text": json.dumps({"receipt": receipt})}]}]
        else:
            result = {"name": tool["name"], "response": {"receipt": receipt}}
            if calls[0].get("id"):
                result["id"] = calls[0]["id"]
            followup = [*body["contents"], history, {"role": "user", "parts": [{"functionResponse": result}]}]
        text, _, _ = await client.request(model, client.body("", history=followup))
        return {"arguments_valid": True, "roundtrip_complete": text.strip() == receipt,
                "local_simulation_only": True, "observed": text[:200]}, text.strip() == receipt


def build_native_runner(base, config: ExecutionConfig):
    if config.include_long_context or config.include_long_context_extreme:
        raise ValueError("Gemini 原生接口暂不提供长上下文检测")
    detectors = [TextProbe(), StreamProbe(), SchemaProbe(), ToolProbe()]
    modes = {Mode.QUICK: {"basic_request", "gemini_stream"},
             Mode.STANDARD: {"basic_request", "gemini_stream", "gemini_schema"},
             Mode.FULL: {d.name for d in detectors}}
    return Runner(base, detectors, config.model_copy(update={"stop_on_auth_failure": True, "max_concurrent": 1}),
        mode_detectors=modes, throttled_client_factory=lambda client, _passive, _concurrency: NativeSession(client, REQUEST_LIMITS[config.mode]))

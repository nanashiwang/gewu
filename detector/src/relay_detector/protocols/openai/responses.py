"""Bounded Responses capability probes. No identity claims or automatic fallback.

Every run has at most 2/3/5 requests (quick/standard/full), no retries, no
extra TTFT request, and no hosted tools. Upstream state storage is disabled.
"""
from __future__ import annotations

import asyncio
import json
import secrets

from ...core.detectors_base import ActiveDetector
from ...core.models import ExecutionConfig, Mode, UsageMetrics
from ...core.runner import Runner
from .client import OpenAIAPIError

REQUEST_LIMITS = {Mode.QUICK: 2, Mode.STANDARD: 3, Mode.FULL: 5}
MAX_OUTPUT_TOKENS = 4096
TIER_MESSAGE = "只验证本次 Responses 接口的已测能力；不验证模型身份、长上下文或实际扣费，不与 Chat Completions 分数直接比较。"


def _completed(response: object) -> dict:
    if not isinstance(response, dict) or response.get("error"):
        if isinstance(response, dict):
            _check_auth_error(response.get("error"))
        raise ValueError("Responses 返回错误或无效对象，本次证据不足")
    if response.get("status") != "completed":
        raise ValueError(f"Responses 未完成（status={str(response.get('status'))[:40]}），本次不计分")
    if response.get("object") != "response" or not isinstance(response.get("id"), str) or not response["id"]:
        raise ValueError("Responses 缺少有效对象类型或响应 ID")
    output = response.get("output")
    if not isinstance(output, list) or not output or any(not isinstance(item, dict) for item in output):
        raise ValueError("Responses 缺少有效 output")
    return response


def _check_auth_error(error: object) -> None:
    if isinstance(error, dict) and (error.get("code") in {"invalid_api_key", "unauthorized", "authentication_error"}
                                  or error.get("type") == "authentication_error"):
        raise OpenAIAPIError(401, "Responses structured authentication error")


def _text(response: dict, *, allow_calls: bool = False) -> str:
    parts = []
    for item in response["output"]:
        if item.get("type") == "message":
            if item.get("role") != "assistant" or item.get("status") != "completed" or not isinstance(item.get("content"), list):
                raise ValueError("Responses 消息未完成或格式无效")
            for part in item["content"]:
                if not isinstance(part, dict):
                    raise ValueError("Responses content 格式无效")
                if part.get("type") == "refusal":
                    raise ValueError("模型拒绝本次能力探针，未验证能力")
                if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    parts.append(part["text"])
        elif item.get("type") == "function_call":
            if not allow_calls or item.get("status") not in {None, "completed"}:
                raise ValueError("Responses 返回非预期或未完成的工具调用")
        elif item.get("type") != "reasoning":
            raise ValueError("Responses 返回非预期输出类型")
    return "".join(parts)


class ResponsesClient:
    def __init__(self, base, limit: int):
        self.base = base
        self.limit = limit
        self.request_count = 0
        self.backoff_events = 0
        self.total_usage = UsageMetrics()
        self.usage_complete = True
        self.blocked = False
        self._ttft_samples_ms = []
        self._sema = asyncio.Semaphore(1)

    def _reserve(self):
        if self.blocked:
            raise ValueError("基础请求或鉴权失败，停止后续请求")
        if self.request_count >= self.limit:
            raise ValueError("已达到本次 Responses 请求预算")
        self.request_count += 1

    def _usage(self, response):
        usage = response.get("usage")
        if not isinstance(usage, dict):
            raise ValueError("Responses 缺少 usage，无法核对本次用量")
        for key in ("input_tokens", "output_tokens", "total_tokens"):
            value = usage.get(key)
            if type(value) is not int or value < 0:
                raise ValueError("Responses usage 字段无效")
        if usage["total_tokens"] != usage["input_tokens"] + usage["output_tokens"]:
            raise ValueError("Responses usage 总数不一致")
        self.total_usage.add(UsageMetrics(input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"]))

    async def create(self, model, **body):
        async with self._sema:
            self._reserve()
            try:
                _, response, _, _ = await self.base.responses_create(
                    model=model, store=False, max_output_tokens=MAX_OUTPUT_TOKENS, **body)
                if not isinstance(response, dict) or response.get("error"):
                    _completed(response)
                if isinstance(response, dict):
                    self._usage(response)
                return _completed(response)
            except BaseException as error:
                self.usage_complete = False
                if isinstance(error, OpenAIAPIError) and error.status in {401, 403}:
                    self.blocked = True
                raise

    async def stream_text(self, model, prompt):
        try:
            return await self._stream_text(model, prompt)
        except BaseException as error:
            self.usage_complete = False
            if isinstance(error, OpenAIAPIError) and error.status in {401, 403}:
                self.blocked = True
            raise

    async def _stream_text(self, model, prompt):
        async with self._sema:
            self._reserve()
            created_id = None
            completed = None
            texts = {}
            done = {}
            item_ids = {}
            last_sequence = -1
            async for event, elapsed in self.base.responses_stream(
                model=model, input=prompt, store=False, max_output_tokens=MAX_OUTPUT_TOKENS,
            ):
                if isinstance(event, dict):
                    _check_auth_error(event.get("error"))
                    if event.get("type") == "error":
                        _check_auth_error(event)
                if not isinstance(event, dict) or event.get("_parse_error") or event.get("error"):
                    raise ValueError("Responses 事件流包含错误或无效 JSON")
                if event.get("_done"):
                    if completed is None:
                        raise ValueError("Responses 缺少 response.completed 结束事件")
                    continue
                kind = event.get("type")
                if not isinstance(kind, str) or kind in {"error", "response.failed", "response.incomplete"}:
                    raise ValueError("Responses 事件流报告失败或未完成")
                if completed is not None:
                    raise ValueError("Responses 完成后仍返回事件")
                sequence = event.get("sequence_number")
                if sequence is not None:
                    if type(sequence) is not int or sequence <= last_sequence:
                        raise ValueError("Responses 事件顺序异常")
                    last_sequence = sequence
                if kind == "response.created":
                    response = event.get("response")
                    if created_id or not isinstance(response, dict) or not isinstance(response.get("id"), str) or not response["id"]:
                        raise ValueError("Responses created 事件无效或重复")
                    created_id = response["id"]
                elif kind in {"response.output_text.delta", "response.output_text.done"}:
                    key = (event.get("output_index"), event.get("content_index"))
                    if not created_id or any(type(index) is not int or index < 0 for index in key):
                        raise ValueError("Responses 文本事件缺少合法索引或 created 事件")
                    item_id = event.get("item_id")
                    if not isinstance(item_id, str) or not item_id or item_id != item_ids.setdefault(key, item_id):
                        raise ValueError("Responses 文本事件 item_id 不一致")
                    if key in done:
                        raise ValueError("Responses 文本结束后仍返回相同文本事件")
                    value = event.get("delta" if kind.endswith("delta") else "text")
                    if not isinstance(value, str):
                        raise ValueError("Responses 文本事件格式无效")
                    if kind.endswith("delta"):
                        if not texts and value:
                            self._ttft_samples_ms.append(elapsed)
                        texts[key] = texts.get(key, "") + value
                    else:
                        done[key] = value
                elif kind == "response.completed":
                    completed = _completed(event.get("response"))
                    if not created_id or completed["id"] != created_id:
                        raise ValueError("Responses 响应 ID 前后不一致")
            if completed is None or not texts or texts != done:
                raise ValueError("Responses 流缺少完整文本或结束事件")
            final_parts = {}
            for index, item in enumerate(completed["output"]):
                if item.get("type") == "message":
                    for content_index, part in enumerate(item.get("content", [])):
                        key = (index, content_index)
                        if isinstance(part, dict) and part.get("type") == "output_text":
                            if item.get("id") != item_ids.get(key):
                                raise ValueError("Responses 最终消息 ID 与流式文本不一致")
                            final_parts[key] = part.get("text")
            if final_parts != texts:
                raise ValueError("Responses 流式增量与最终响应不一致")
            self._usage(completed)
            return _text(completed)


class Probe(ActiveDetector):
    weight = 25.0

    async def run(self, client, model):
        if client.blocked:
            return self.skip("基础请求未完成，停止后续请求；本项未测试")
        try:
            details, passed = await self.check(client, model)
            return self._result("pass" if passed else "fail", 100 if passed else 0,
                                {"wire_api": "responses", **details})
        except OpenAIAPIError as error:
            if self.name == "basic_request":
                client.blocked = True
            if error.status in {404, 405}:
                return self.skip(f"接口或模型未开放（HTTP {error.status}），本项未验证；不自动切换接口")
            raise
        except Exception:
            if self.name == "basic_request":
                client.blocked = True
            raise


class TextProbe(Probe):
    name = "basic_request"
    display_name = "Responses 基础回复"

    async def check(self, client, model):
        nonce = "gewu_" + secrets.token_hex(8)
        response = await client.create(model, input=f"Reply with exactly this text and nothing else: {nonce}")
        text = _text(response).strip()
        return {"expected": nonce, "observed": text[:200]}, text == nonce


class StreamProbe(Probe):
    name = "responses_stream"
    display_name = "Responses 流式完整性"

    async def check(self, client, model):
        nonce = "gewu_" + secrets.token_hex(8)
        text = await client.stream_text(model, f"Reply with exactly this text and nothing else: {nonce}")
        return {"expected": nonce, "observed": text[:200], "completed_event": True}, text.strip() == nonce


class SchemaProbe(Probe):
    name = "responses_schema"
    display_name = "Responses 结构化输出"

    async def check(self, client, model):
        nonce = secrets.token_hex(8)
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}, "nonce": {"type": "string"}},
                  "required": ["ok", "nonce"], "additionalProperties": False}
        response = await client.create(model, input=f'Return JSON with ok=true and nonce="{nonce}".',
            text={"format": {"type": "json_schema", "name": "gewu_probe", "strict": True, "schema": schema}})
        text = _text(response)
        try:
            value = json.loads(text)
        except ValueError:
            value = None
        passed = isinstance(value, dict) and set(value) == {"ok", "nonce"} and value["ok"] is True and value["nonce"] == nonce
        return {"expected_nonce": nonce, "observed": text[:300], "schema_valid": passed}, passed


class ToolProbe(Probe):
    name = "responses_tools"
    display_name = "Responses 工具调用往返"

    async def check(self, client, model):
        nonce = secrets.token_hex(8)
        tools = [{"type": "function", "name": "gewu_echo", "description": "Local test function. Returns a receipt.",
                  "strict": True, "parameters": {"type": "object", "properties": {"nonce": {"type": "string"}},
                      "required": ["nonce"], "additionalProperties": False}}]
        initial = [{"role": "user", "content": f'Call gewu_echo with nonce="{nonce}". After the function returns, reply with only its receipt.'}]
        response = await client.create(model, input=initial, tools=tools,
            tool_choice={"type": "function", "name": "gewu_echo"}, parallel_tool_calls=False,
            include=["reasoning.encrypted_content"])
        calls = [item for item in response["output"] if item.get("type") == "function_call"]
        _text(response, allow_calls=True)  # Never persist encrypted reasoning.
        valid = len(calls) == 1 and calls[0].get("name") == "gewu_echo" and isinstance(calls[0].get("call_id"), str) and bool(calls[0]["call_id"])
        try:
            valid = valid and json.loads(calls[0].get("arguments", "")) == {"nonce": nonce}
        except (ValueError, TypeError):
            valid = False
        if not valid:
            return {"arguments_valid": False, "roundtrip_complete": False}, False
        # No dispatch, shell, network or hosted tool. Receipt is generated only
        # after the call so merely repeating the original prompt cannot pass.
        receipt = "receipt_" + secrets.token_hex(8)
        followup = [*initial, *response["output"], {"type": "function_call_output",
                    "call_id": calls[0]["call_id"], "output": json.dumps({"receipt": receipt})}]
        final = await client.create(model, input=followup, tools=tools, tool_choice="none",
                                    include=["reasoning.encrypted_content"])
        text = _text(final).strip()
        passed = text == receipt and not any(item.get("type") == "function_call" for item in final["output"])
        return {"arguments_valid": True, "roundtrip_complete": passed, "local_simulation_only": True,
                "expected_receipt": receipt, "observed": text[:200]}, passed


def build_responses_runner(base, config: ExecutionConfig) -> Runner:
    if config.include_long_context or config.include_long_context_extreme:
        raise ValueError("Responses 暂不提供长上下文检测，请关闭高级选项")
    detectors = [TextProbe(), StreamProbe(), SchemaProbe(), ToolProbe()]
    modes = {Mode.QUICK: {"basic_request", "responses_stream"},
             Mode.STANDARD: {"basic_request", "responses_stream", "responses_schema"},
             Mode.FULL: {d.name for d in detectors}}
    return Runner(base, detectors, config.model_copy(update={"stop_on_auth_failure": True, "max_concurrent": 1}),
                  mode_detectors=modes,
                  throttled_client_factory=lambda client, _passive, _concurrency: ResponsesClient(client, REQUEST_LIMITS[config.mode]))

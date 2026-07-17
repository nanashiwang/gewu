"""Regression tests for Phase 2 OpenAI Chat Completions detection."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from relay_detector.core.detectors_base import ActiveDetector, PassiveDetector
from relay_detector.core.models import ExecutionConfig, Mode
from relay_detector.core.scorer import compute_total, effective_verdict
from relay_detector.report import Report
from relay_detector.protocols.openai import (
    build_detectors,
    default_model,
    model_choices,
    tier_banner,
)
from relay_detector.protocols.openai.client import (
    OpenAIAPIError,
    OpenAIChatClient,
    ThrottledOpenAIClient,
    is_stream_required_error,
    normalize_openai_base_url,
)
from relay_detector.protocols.openai.detectors.basic_request import BasicRequestDetector
from relay_detector.protocols.openai.detectors.integrity import (
    EXPECTED_TEXT,
    IntegrityDetector,
    _usage_close as _openai_stream_usage_close,
)
from relay_detector.protocols.openai.detectors.protocol import ProtocolDetector
from relay_detector.protocols.openai.detectors.token_billing import (
    _compare_reference,
    _stream_usage_compatible,
)
from relay_detector.protocols.openai.runner import Runner


def _chat_payload(
    *,
    model: str = "gpt-4o-mini",
    content: str = "pong",
    finish_reason: str = "stop",
    tool_calls: list[dict[str, Any]] | None = None,
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["content"] = None
        message["tool_calls"] = tool_calls
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1741569952,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": usage or {
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "total_tokens": 12,
        },
        "system_fingerprint": "fp_test",
    }


class FakeOpenAIBaseClient:
    async def chat_completions_create(self, **body: Any):
        model = body["model"]
        prompt = str(body.get("messages"))
        usage = {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
        if "Reference text:" in prompt:
            usage = {"prompt_tokens": 90, "completion_tokens": 2, "total_tokens": 92}
        if body.get("tools"):
            response = _chat_payload(
                model=model,
                finish_reason="tool_calls",
                usage=usage,
                tool_calls=[
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": {
                            "name": "get_current_weather",
                            "arguments": '{"city":"Boston, MA","unit":"celsius"}',
                        },
                    }
                ],
            )
        elif body.get("response_format"):
            response = _chat_payload(
                model=model,
                content='{"ok":true,"nonce":"openai-detector"}',
                usage=usage,
            )
        elif "GEWU_STREAM_CHECK" in prompt:
            response = _chat_payload(model=model, content=EXPECTED_TEXT, usage=usage)
        elif "HTTP status 418" in prompt:
            response = _chat_payload(
                model=model,
                content="HTTP 418 is an April Fools status code.",
                usage=usage,
            )
        else:
            response = _chat_payload(model=model, content="pong", usage=usage)
        return body, response, httpx.Headers({"x-request-id": "req_test"}), 12

    async def chat_completions_stream(self, **body: Any):
        _ = body
        midpoint = len(EXPECTED_TEXT) // 2
        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1741569952,
            "model": body["model"],
            "choices": [{"index": 0, "delta": {"content": EXPECTED_TEXT[:midpoint]}}],
        }, 5
        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1741569952,
            "model": body["model"],
            "choices": [{"index": 0, "delta": {"content": EXPECTED_TEXT[midpoint:]}}],
        }, 7
        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1741569952,
            "model": body["model"],
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
            },
        }, 9


class ReasoningOnlyBasicClient:
    async def chat_completions_create(self, **body: Any):
        return (
            body,
            _chat_payload(
                model=body["model"],
                content="",
                finish_reason="length",
                usage={
                    "prompt_tokens": 11,
                    "completion_tokens": 16,
                    "total_tokens": 27,
                    "completion_tokens_details": {"reasoning_tokens": 16},
                },
            ),
            httpx.Headers(),
            12,
        )


class IntegrityResponseClient:
    def __init__(self, non_stream_text: str, stream_text: str):
        self.non_stream_text = non_stream_text
        self.stream_text = stream_text

    async def chat_completions_create(self, **body: Any):
        return (
            body,
            _chat_payload(model=body["model"], content=self.non_stream_text),
            httpx.Headers(),
            5,
        )

    async def chat_completions_stream(self, **body: Any):
        if self.stream_text:
            yield {
                "id": "chatcmpl-integrity",
                "object": "chat.completion.chunk",
                "created": 1741569952,
                "model": body["model"],
                "choices": [
                    {"index": 0, "delta": {"content": self.stream_text}}
                ],
            }, 5
        yield {
            "id": "chatcmpl-integrity",
            "object": "chat.completion.chunk",
            "created": 1741569952,
            "model": body["model"],
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
            },
        }, 9


class StreamOnlyOpenAIBaseClient:
    """Relay shape observed live: non-stream rejected, SSE contains Claude usage."""

    async def chat_completions_create(self, **_body: Any):
        raise OpenAIAPIError(
            400,
            '{"error":{"message":"Stream must be set to true"}}',
        )

    async def chat_completions_stream(self, **body: Any):
        prompt = str(body.get("messages") or [])
        model = body["model"]
        prompt_tokens = 2584 if "Reference text:" in prompt else 2504
        finish_reason = "stop"
        content = "pong"
        delta: dict[str, Any] = {"content": content}
        if body.get("tools"):
            finish_reason = "tool_calls"
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_stream_only",
                        "type": "function",
                        "function": {
                            "name": "get_current_weather",
                            "arguments": '{"city":"Boston, MA","unit":"celsius"}',
                        },
                    }
                ]
            }
        elif body.get("response_format"):
            delta = {"content": '{"ok":true,"nonce":"openai-detector"}'}
        elif "GEWU_STREAM_CHECK" in prompt:
            delta = {"content": EXPECTED_TEXT}
        elif "HTTP status 418" in prompt:
            delta = {"content": "HTTP 418 means I'm a teapot."}
        elif "Reply with exactly: ok" in prompt:
            delta = {"content": "ok"}

        yield {
            "id": "chatcmpl-stream-only",
            "object": "chat.completion.chunk",
            "created": 1_741_569_952,
            "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant"}}],
        }, 3
        yield {
            "id": "chatcmpl-stream-only",
            "object": "chat.completion.chunk",
            "created": 1_741_569_952,
            "model": model,
            "choices": [{"index": 0, "delta": delta}],
        }, 5
        yield {
            "id": "chatcmpl-stream-only",
            "object": "chat.completion.chunk",
            "created": 1_741_569_952,
            "model": model,
            "choices": [
                {"index": 0, "delta": {}, "finish_reason": finish_reason}
            ],
        }, 7
        yield {
            "id": "chatcmpl-stream-only",
            "object": "chat.completion.chunk",
            "created": 1_741_569_952,
            "model": model,
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": 4,
                "total_tokens": prompt_tokens + 4,
                "input_tokens": prompt_tokens,
                "output_tokens": 4,
                "claude_cache_creation_5_m_tokens": 0,
            },
        }, 9


def test_openai_base_url_normalization_handles_v1_suffix():
    assert normalize_openai_base_url("https://api.example.com") == (
        "https://api.example.com/v1"
    )
    assert normalize_openai_base_url("https://api.example.com/v1/") == (
        "https://api.example.com/v1"
    )


def test_stream_required_error_detection_is_narrow():
    assert is_stream_required_error(
        OpenAIAPIError(400, "Stream must be set to true")
    )
    assert not is_stream_required_error(
        OpenAIAPIError(400, "stream field has an invalid type")
    )
    assert not is_stream_required_error(
        OpenAIAPIError(500, "Stream must be set to true")
    )


def test_terminal_report_formats_structured_protocol_issues():
    result = type(
        "Result",
        (),
        {
            "status": "fail",
            "name": "protocol",
            "details": {
                "issues": [
                    {"code": "non_stream_unsupported", "severity": "major"},
                    {"code": "usage_contains_claude_fields", "severity": "critical"},
                ]
            },
        },
    )()
    note = Report()._note_for(result)
    assert "non_stream_unsupported" in note
    assert "usage_contains_claude_fields" in note


@pytest.mark.asyncio
async def test_stream_only_relay_is_adapted_but_never_misreported_as_fully_compatible():
    cfg = ExecutionConfig.for_mode(Mode.FULL, max_concurrent=3)
    runner = Runner(StreamOnlyOpenAIBaseClient(), build_detectors(), cfg)
    outcome = await runner.run("gpt-5.6-sol")
    by_name = {result.name: result for result in outcome.results}

    assert by_name["basic_request"].status == "pass"
    assert by_name["function_calling"].status == "pass"
    assert by_name["structured_output"].status == "pass"
    assert by_name["integrity"].status == "skip"
    assert by_name["integrity"].details["skip_reason"] == "non-stream-unsupported"
    assert by_name["token_billing"].status == "fail"
    assert by_name["token_billing"].details["non_stream_supported"] is False

    protocol = by_name["protocol"]
    assert protocol.status == "fail"
    issue_codes = {issue["code"] for issue in protocol.details["issues"]}
    assert "non_stream_unsupported" in issue_codes
    assert "usage_contains_claude_fields" in issue_codes
    assert protocol.details["critical_issue_count"] > 0
    claude_issue = next(
        issue
        for issue in protocol.details["issues"]
        if issue["code"] == "usage_contains_claude_fields"
    )
    assert claude_issue["occurrences"] > 1
    assert protocol.details["issue_occurrence_count"] > len(protocol.details["issues"])

    score = compute_total(outcome.results)
    assert score > 0
    assert effective_verdict(score, outcome.results) == "marginal"


@pytest.mark.asyncio
async def test_stream_fallback_reassembles_tool_call_deltas():
    client = ThrottledOpenAIClient(StreamOnlyOpenAIBaseClient())
    _request, response, _headers, _latency = await client.chat_completions_create(
        model="gpt-5.6-sol",
        messages=[{"role": "user", "content": "Use the tool"}],
        tools=[{"type": "function", "function": {"name": "get_current_weather"}}],
    )
    call = response["choices"][0]["message"]["tool_calls"][0]
    assert call["id"] == "call_stream_only"
    assert call["function"]["name"] == "get_current_weather"
    assert call["function"]["arguments"].startswith("{")
    assert response["_gewu_transport"]["effective_stream"] is True


@pytest.mark.asyncio
async def test_openai_client_strips_temperature_for_default_only_models():
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json
        captured["body"] = _json.loads(request.content)
        return httpx.Response(200, json=_chat_payload(model="gpt-5.5-2026-04-23"))

    transport = httpx.MockTransport(handler)
    client = OpenAIChatClient("https://api.openai.com", "sk-test")
    client._client = httpx.AsyncClient(  # type: ignore[attr-defined]
        base_url=client.base_url,
        headers={"authorization": "Bearer sk-test", "content-type": "application/json"},
        transport=transport,
    )
    try:
        await client.chat_completions_create(
            model="gpt-5.5-2026-04-23",
            temperature=0,
            messages=[{"role": "user", "content": "hi"}],
        )
    finally:
        await client.aclose()

    assert captured["body"]["model"] == "gpt-5.5-2026-04-23"
    assert "temperature" not in captured["body"]


@pytest.mark.asyncio
async def test_openai_client_keeps_temperature_for_other_models():
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json
        captured["body"] = _json.loads(request.content)
        return httpx.Response(200, json=_chat_payload(model="gpt-5.4"))

    transport = httpx.MockTransport(handler)
    client = OpenAIChatClient("https://api.openai.com", "sk-test")
    client._client = httpx.AsyncClient(  # type: ignore[attr-defined]
        base_url=client.base_url,
        headers={"authorization": "Bearer sk-test", "content-type": "application/json"},
        transport=transport,
    )
    try:
        await client.chat_completions_create(
            model="gpt-5.4",
            temperature=0,
            messages=[{"role": "user", "content": "hi"}],
        )
    finally:
        await client.aclose()

    assert captured["body"]["temperature"] == 0


def test_openai_detectors_use_core_base_classes():
    detectors = build_detectors()
    assert any(isinstance(detector, ActiveDetector) for detector in detectors)
    assert any(isinstance(detector, PassiveDetector) for detector in detectors)


def test_openai_tier_banner_disclaims_authenticity():
    title, message = tier_banner()
    assert title == "行为/协议级验证"
    assert "无法可靠区分" in message


def test_openai_default_model_choices_are_gpt5_series():
    assert model_choices() == [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.3-codex",
        "gpt-5.4-nano",
        "gpt-5.4-mini",
    ]
    assert default_model() == "gpt-5.5"


def test_openai_protocol_detector_accepts_chat_completion_shape():
    detector = ProtocolDetector()
    request = {"model": "gpt-4o-mini"}
    response = _chat_payload(model="gpt-4o-mini")
    detector.observe(request, response, httpx.Headers({"x-request-id": "req"}), 10)
    result = detector.finalize()
    assert result.status == "pass"
    assert result.score == 100.0


@pytest.mark.asyncio
async def test_openai_standard_runner_completes_with_fake_client():
    cfg = ExecutionConfig.for_mode(Mode.STANDARD, max_concurrent=3)
    runner = Runner(FakeOpenAIBaseClient(), build_detectors(), cfg)
    outcome = await runner.run("gpt-4o-mini")
    by_name = {result.name: result for result in outcome.results}
    assert by_name["basic_request"].status == "pass"
    assert by_name["function_calling"].status == "pass"
    assert by_name["structured_output"].status == "pass"
    assert by_name["protocol"].status == "pass"
    assert by_name["token_billing"].status == "pass"
    assert "token_parity" not in by_name
    assert outcome.performance.request_count >= 6


@pytest.mark.asyncio
async def test_openai_basic_request_tolerates_reasoning_budget_exhaustion():
    result = await BasicRequestDetector().run(ReasoningOnlyBasicClient(), "gpt-5.5")
    assert result.status == "pass"
    assert result.score == 75.0
    assert result.details["reasoning_budget_exhausted"] is True


def test_openai_token_billing_accepts_lower_stream_completion_tokens():
    non_stream = {"prompt_tokens": 11, "completion_tokens": 8, "total_tokens": 19}
    stream = {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15}
    assert _stream_usage_compatible(non_stream, stream) is True

    reference = {
        "collected_at": "2026-05-04T00:00:00+00:00",
        "ranges": {
            "short_prompt_tokens": {"min": 11, "max": 11},
            "short_completion_tokens": {"min": 8, "max": 8},
            "long_prompt_tokens": {"min": 95, "max": 95},
            "prompt_delta": {"min": 84, "max": 84},
            "stream_prompt_tokens": {"min": 11, "max": 11},
            "stream_completion_tokens": {"min": 8, "max": 8},
        },
    }
    result = _compare_reference(
        non_stream,
        {"prompt_tokens": 95, "completion_tokens": 8, "total_tokens": 103},
        stream,
        reference,
    )
    assert result["pass"] is True
    assert result["checks"]["stream_completion_tokens"]["pass"] is True
    assert result["checks"]["stream_completion_tokens"]["direction"] == "low"


def test_openai_integrity_accepts_lower_stream_completion_tokens():
    non_stream = {"prompt_tokens": 15, "completion_tokens": 19, "total_tokens": 34}
    stream = {"prompt_tokens": 15, "completion_tokens": 8, "total_tokens": 23}
    assert _openai_stream_usage_close(non_stream, stream) is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    (
        "non_stream_text",
        "stream_text",
        "expected_score",
        "expected_status",
        "non_target_match",
        "stream_target_match",
        "text_match",
    ),
    [
        (EXPECTED_TEXT, EXPECTED_TEXT, 100.0, "pass", True, True, True),
        ("SAME_WRONG_TOKEN", "SAME_WRONG_TOKEN", 60.0, "fail", False, False, True),
        (EXPECTED_TEXT, "WRONG_TOKEN", 75.0, "fail", True, False, False),
        ("WRONG_A", "WRONG_B", 55.0, "fail", False, False, False),
        (EXPECTED_TEXT, "", 65.0, "fail", True, False, False),
    ],
)
async def test_openai_integrity_requires_each_response_to_match_target(
    non_stream_text: str,
    stream_text: str,
    expected_score: float,
    expected_status: str,
    non_target_match: bool,
    stream_target_match: bool,
    text_match: bool,
):
    result = await IntegrityDetector().run(
        IntegrityResponseClient(non_stream_text, stream_text),
        "gpt-5.6-sol",
    )

    assert result.score == expected_score
    assert result.status == expected_status
    assert result.details["expected_text"] == EXPECTED_TEXT
    assert result.details["non_stream_target_match"] is non_target_match
    assert result.details["stream_target_match"] is stream_target_match
    assert result.details["text_match"] is text_match


def test_openai_integrity_target_failure_is_explained_without_affecting_gemini():
    from web.image_report import _gemini_jpg_note, _openai_jpg_note
    from web.server import _report_notes

    openai_report = {
        "protocol": "openai",
        "results": [
            {"name": "structured_output", "status": "pass"},
            {"name": "token_billing", "status": "pass"},
            {"name": "protocol", "status": "pass", "details": {}},
            {
                "name": "integrity",
                "status": "fail",
                "details": {
                    "non_stream_target_match": False,
                    "stream_target_match": False,
                },
            }
        ],
    }
    notes = _report_notes(openai_report)
    assert notes[-1]["title"] == "目标响应不正确"
    assert "错误答案相同" in notes[-1]["body"]
    assert _openai_jpg_note(openai_report) == (
        "流式一致性未通过: stream 或 non-stream 没有正确返回指定标记。"
    )

    gemini_report = {
        "protocol": "gemini",
        "results": [
            {"name": "structured_output", "status": "pass"},
            {"name": "token_usage", "status": "pass"},
            {"name": "integrity", "status": "fail", "details": {}},
        ],
    }
    gemini_notes = _report_notes(gemini_report)
    assert gemini_notes[-1]["body"] == (
        "stream 与 non-stream 的文本、结束原因或 usage 字段没有对齐。"
    )
    assert _gemini_jpg_note(gemini_report) == (
        "流式响应存在偏差: stream 与 non-stream 没有完全对齐。"
    )

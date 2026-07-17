"""Raw OpenAI Chat Completions client and throttled wrapper."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any

import httpx

from ...core.models import UsageMetrics

if TYPE_CHECKING:
    from ...core.detectors_base import PassiveDetector


DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_CONCURRENT = 3
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_BACKOFF_S = 30.0
MAX_RETRIES = 3
DEFAULT_TEMPERATURE_ONLY_PREFIXES = (
    "gpt-5.5",
)


def normalize_openai_base_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1"):
        return normalized
    return normalized + "/v1"


def _sanitize_body(body: dict[str, Any]) -> dict[str, Any]:
    model = body.get("model")
    if isinstance(model, str) and model.startswith(DEFAULT_TEMPERATURE_ONLY_PREFIXES):
        body.pop("temperature", None)
    return body


class OpenAIAPIError(Exception):
    def __init__(self, status: int, body: str, headers: httpx.Headers | None = None):
        self.status = status
        self.body = body
        self.headers = headers
        super().__init__(f"HTTP {status}: {body[:200]}")


def is_stream_required_error(error: Exception) -> bool:
    """Return whether a Chat Completions endpoint explicitly requires SSE.

    Some relay-only models reject every non-stream request with HTTP 400.  We
    may still exercise their capabilities through SSE, but must preserve that
    transport downgrade in the report instead of silently pretending a real
    non-stream response existed.
    """
    if not isinstance(error, OpenAIAPIError) or error.status != 400:
        return False
    text = error.body.lower()
    return (
        "stream must be set to true" in text
        or "stream must be true" in text
        or "stream=true is required" in text
    )


class OpenAIChatClient:
    """Raw httpx client for OpenAI-compatible endpoints."""

    def __init__(
        self,
        base_url: str = DEFAULT_OPENAI_BASE_URL,
        api_key: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        extra_headers: dict[str, str] | None = None,
        trust_env: bool = True,
    ):
        self.base_url = normalize_openai_base_url(base_url)
        self.api_key = api_key or ""
        headers = {
            "authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
            trust_env=trust_env,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> OpenAIChatClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def responses_create(
        self, **body: Any
    ) -> tuple[dict[str, Any], dict[str, Any], httpx.Headers, int]:
        body.pop("stream", None)
        body = _sanitize_body(body)
        start = time.perf_counter()
        resp = await self._client.post("/responses", json=body)
        latency_ms = int((time.perf_counter() - start) * 1000)
        if resp.status_code >= 400:
            raise OpenAIAPIError(resp.status_code, resp.text, resp.headers)
        return body, resp.json(), resp.headers, latency_ms

    async def chat_completions_create(
        self, **body: Any
    ) -> tuple[dict[str, Any], dict[str, Any], httpx.Headers, int]:
        body.pop("stream", None)
        # Per-request timeout override — long-context detector passes a
        # tier-scaled value (e.g. 240s for a 950k probe) so big inputs
        # don't get killed by the 30s default. Pop before _sanitize_body
        # so it never reaches the OpenAI API as a JSON field.
        timeout = body.pop("request_timeout_s", None)
        body = _sanitize_body(body)
        start = time.perf_counter()
        kwargs: dict[str, Any] = {"json": body}
        if timeout is not None:
            kwargs["timeout"] = float(timeout)
        resp = await self._client.post("/chat/completions", **kwargs)
        latency_ms = int((time.perf_counter() - start) * 1000)
        if resp.status_code >= 400:
            raise OpenAIAPIError(resp.status_code, resp.text, resp.headers)
        return body, resp.json(), resp.headers, latency_ms

    async def chat_completions_stream(
        self, **body: Any
    ) -> AsyncIterator[tuple[dict[str, Any], int]]:
        body["stream"] = True
        body = _sanitize_body(body)
        start = time.perf_counter()
        async with self._client.stream("POST", "/chat/completions", json=body) as resp:
            if resp.status_code >= 400:
                err_body = (await resp.aread()).decode("utf-8", errors="replace")
                raise OpenAIAPIError(resp.status_code, err_body, resp.headers)
            async for chunk in _parse_openai_sse(resp.aiter_lines()):
                elapsed = int((time.perf_counter() - start) * 1000)
                yield chunk, elapsed


async def _parse_openai_sse(lines: AsyncIterator[str]) -> AsyncIterator[dict[str, Any]]:
    data_lines: list[str] = []
    async for line in lines:
        if line == "":
            if data_lines:
                payload = "\n".join(data_lines)
                data_lines = []
                if payload.strip() == "[DONE]":
                    yield {"_done": True}
                    continue
                try:
                    yield json.loads(payload)
                except json.JSONDecodeError:
                    yield {"_raw": payload, "_parse_error": True}
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        payload = "\n".join(data_lines)
        if payload.strip() == "[DONE]":
            yield {"_done": True}
        else:
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                yield {"_raw": payload, "_parse_error": True}


class ThrottledOpenAIClient:
    def __init__(
        self,
        base: OpenAIChatClient,
        passive_detectors: list[PassiveDetector] | None = None,
        max_concurrent: int = DEFAULT_MAX_CONCURRENT,
    ):
        self._base = base
        self._passive = passive_detectors or []
        self._sema = asyncio.Semaphore(max_concurrent)
        self._backoff_until = 0.0
        self._backoff_lock = asyncio.Lock()
        self.request_count = 0
        self.backoff_events = 0
        self.total_usage = UsageMetrics()
        self._ttft_samples_ms: list[int] = []

    @property
    def base_url(self) -> str:
        """Pass-through so detectors treat this wrapper as the underlying client."""
        return self._base.base_url

    async def _wait_for_backoff(self) -> None:
        while True:
            wait = self._backoff_until - time.monotonic()
            if wait <= 0:
                return
            await asyncio.sleep(wait)

    async def _trigger_backoff(self, retry_after: float) -> None:
        async with self._backoff_lock:
            until = time.monotonic() + retry_after
            if until > self._backoff_until:
                self._backoff_until = until
                self.backoff_events += 1

    def _retry_after_seconds(self, exc: OpenAIAPIError, attempt: int) -> float:
        if exc.headers is not None:
            ra = exc.headers.get("retry-after")
            if ra:
                try:
                    return min(float(ra), MAX_BACKOFF_S)
                except ValueError:
                    pass
        return min(2.0 ** attempt, MAX_BACKOFF_S)

    def _broadcast(
        self,
        request: dict[str, Any],
        response: dict[str, Any],
        headers: httpx.Headers,
        latency_ms: int,
    ) -> None:
        for detector in self._passive:
            try:
                detector.observe(request, response, headers, latency_ms)
            except Exception:
                pass

    def _absorb_response_usage(self, response: dict[str, Any]) -> None:
        usage = response.get("usage")
        if not isinstance(usage, dict):
            return
        delta = UsageMetrics()
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens")
        if isinstance(prompt, int) and not isinstance(prompt, bool):
            delta.input_tokens = prompt
        if isinstance(completion, int) and not isinstance(completion, bool):
            delta.output_tokens = completion
        self.total_usage.add(delta)

    async def chat_completions_create(
        self, **body: Any
    ) -> tuple[dict[str, Any], dict[str, Any], httpx.Headers, int]:
        try:
            return await self._with_retry(
                lambda: self._base.chat_completions_create(**body),
                broadcast=True,
            )
        except OpenAIAPIError as error:
            if not is_stream_required_error(error):
                raise

        # The endpoint is usable only through SSE.  Re-run the same semantic
        # request as a stream and synthesize the Chat Completions envelope that
        # active detectors already understand.  The explicit metadata is
        # consumed by Integrity/Protocol/TokenBilling so this cannot inflate a
        # stream-only endpoint into a false full-compatibility pass.
        stream_body = dict(body)
        stream_body.setdefault("stream_options", {"include_usage": True})
        try:
            return await self._collect_stream_response(
                stream_body,
                transport_meta={
                    "requested_stream": False,
                    "effective_stream": True,
                    "fallback_reason": "stream_required",
                },
            )
        except OpenAIAPIError as error:
            # A few compatible relays require streaming but reject the optional
            # stream_options object.  Retry once without it; absence of usage is
            # then visible to token/protocol detectors.
            if "stream_options" not in error.body.lower():
                raise
            stream_body.pop("stream_options", None)
            return await self._collect_stream_response(
                stream_body,
                transport_meta={
                    "requested_stream": False,
                    "effective_stream": True,
                    "fallback_reason": "stream_required_without_usage_option",
                },
            )

    async def chat_completions_stream(
        self,
        *,
        _broadcast: bool = True,
        _transport_meta: dict[str, Any] | None = None,
        **body: Any,
    ) -> AsyncIterator[tuple[dict[str, Any], int]]:
        await self._wait_for_backoff()
        async with self._sema:
            self.request_count += 1
            usage: dict[str, Any] | None = None
            ttft_recorded = False
            chunks_for_broadcast: list[dict[str, Any]] = []
            request_started = time.monotonic()
            async for chunk, elapsed_ms in self._base.chat_completions_stream(**body):
                if chunk.get("_done") or chunk.get("_parse_error"):
                    continue
                if not ttft_recorded and _chunk_has_text_delta(chunk):
                    self._ttft_samples_ms.append(elapsed_ms)
                    ttft_recorded = True
                if isinstance(chunk.get("usage"), dict):
                    usage = chunk["usage"]
                chunks_for_broadcast.append(chunk)
                yield chunk, elapsed_ms
            if usage:
                self._absorb_response_usage({"usage": usage})
            if _broadcast and chunks_for_broadcast:
                synthesized = _synthesize_stream_response(chunks_for_broadcast, usage)
                if _transport_meta:
                    synthesized["_gewu_transport"] = dict(_transport_meta)
                latency = int((time.monotonic() - request_started) * 1000)
                request = dict(body)
                request["stream"] = True
                self._broadcast(request, synthesized, httpx.Headers(), latency)

    async def _collect_stream_response(
        self,
        body: dict[str, Any],
        *,
        transport_meta: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any], httpx.Headers, int]:
        chunks: list[dict[str, Any]] = []
        usage: dict[str, Any] | None = None
        last_elapsed = 0
        async for chunk, elapsed in self.chat_completions_stream(
            _broadcast=False,
            **body,
        ):
            chunks.append(chunk)
            last_elapsed = elapsed
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
        if not chunks:
            raise OpenAIAPIError(502, "stream ended without any data chunks")
        response = _synthesize_stream_response(chunks, usage)
        response["_gewu_transport"] = dict(transport_meta)
        request = dict(body)
        request["stream"] = True
        self._broadcast(request, response, httpx.Headers(), last_elapsed)
        return request, response, httpx.Headers(), last_elapsed

    async def _with_retry(
        self,
        op: Callable[[], Awaitable[tuple[dict[str, Any], dict[str, Any], httpx.Headers, int]]],
        broadcast: bool,
    ) -> tuple[dict[str, Any], dict[str, Any], httpx.Headers, int]:
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES + 1):
            await self._wait_for_backoff()
            async with self._sema:
                self.request_count += 1
                try:
                    req, resp, headers, latency = await op()
                except OpenAIAPIError as e:
                    last_exc = e
                    if e.status in RETRYABLE_STATUS and attempt < MAX_RETRIES:
                        await self._trigger_backoff(self._retry_after_seconds(e, attempt))
                        continue
                    raise
                # RemoteProtocolError (for example, "server disconnected
                # without sending a response") is a TransportError but not a
                # NetworkError. Non-stream requests have not produced response
                # bytes here, so apply the same bounded pre-response retry.
                except httpx.TransportError as e:
                    last_exc = e
                    if attempt < MAX_RETRIES:
                        await self._trigger_backoff(min(2.0 ** attempt, MAX_BACKOFF_S))
                        continue
                    raise
                self._absorb_response_usage(resp)
                if broadcast:
                    self._broadcast(req, resp, headers, latency)
                return req, resp, headers, latency
        raise last_exc if last_exc else RuntimeError("retry loop exhausted")


def _chunk_has_text_delta(chunk: dict[str, Any]) -> bool:
    choices = chunk.get("choices")
    if not isinstance(choices, list):
        return False
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if isinstance(delta, dict) and delta.get("content"):
            return True
    return False


def _synthesize_stream_response(
    chunks: list[dict[str, Any]],
    final_usage: dict[str, Any] | None,
) -> dict[str, Any]:
    """Reduce Chat Completions chunks to a non-stream-shaped response.

    Besides text, this reassembles tool-call deltas so stream-only endpoints
    can still be tested for function calling without weakening the checks.
    """
    head = chunks[0] if chunks else {}
    text_parts: list[str] = []
    finish_reason: Any = None
    tool_calls: dict[int, dict[str, Any]] = {}
    for chunk in chunks:
        choices = chunk.get("choices")
        if not isinstance(choices, list):
            continue
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            if choice.get("finish_reason") is not None:
                finish_reason = choice.get("finish_reason")
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            content = delta.get("content")
            if isinstance(content, str):
                text_parts.append(content)
            calls = delta.get("tool_calls")
            if not isinstance(calls, list):
                continue
            for position, call_delta in enumerate(calls):
                if not isinstance(call_delta, dict):
                    continue
                index = call_delta.get("index")
                if not isinstance(index, int) or isinstance(index, bool):
                    index = position
                call = tool_calls.setdefault(
                    index,
                    {
                        "id": "",
                        "type": "function",
                        "function": {"name": "", "arguments": ""},
                    },
                )
                if isinstance(call_delta.get("id"), str):
                    call["id"] += call_delta["id"]
                if isinstance(call_delta.get("type"), str):
                    call["type"] = call_delta["type"]
                fn_delta = call_delta.get("function")
                if isinstance(fn_delta, dict):
                    fn = call["function"]
                    if isinstance(fn_delta.get("name"), str):
                        fn["name"] += fn_delta["name"]
                    if isinstance(fn_delta.get("arguments"), str):
                        fn["arguments"] += fn_delta["arguments"]

    message: dict[str, Any] = {
        "role": "assistant",
        "content": "".join(text_parts),
    }
    if tool_calls:
        message["content"] = None
        message["tool_calls"] = [tool_calls[index] for index in sorted(tool_calls)]
    response: dict[str, Any] = {
        "id": head.get("id"),
        "object": "chat.completion",
        "created": head.get("created"),
        "model": head.get("model"),
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
    }
    if isinstance(final_usage, dict):
        response["usage"] = final_usage
    return response


OpenAIClient = OpenAIChatClient

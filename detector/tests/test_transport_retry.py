"""Regression tests for bounded pre-response transport retries."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from relay_detector.protocols.openai.client import ThrottledOpenAIClient


def _response(model: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "model": model,
        "choices": [],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2,
        },
    }


@pytest.mark.asyncio
async def test_retries_disconnect_before_response(monkeypatch: pytest.MonkeyPatch):
    class DisconnectOnceClient:
        base_url = "https://relay.example/v1"

        def __init__(self):
            self.calls = 0

        async def chat_completions_create(self, **body: Any):
            self.calls += 1
            if self.calls == 1:
                raise httpx.RemoteProtocolError(
                    "Server disconnected without sending a response."
                )
            response = _response(body["model"])
            return body, response, httpx.Headers(), 10

    base = DisconnectOnceClient()
    client = ThrottledOpenAIClient(base)  # type: ignore[arg-type]

    async def no_wait(_delay: float) -> None:
        client.backoff_events += 1

    monkeypatch.setattr(client, "_trigger_backoff", no_wait)

    _request, response, _headers, _latency = await client.chat_completions_create(
        model="gpt-5.6-sol",
        messages=[{"role": "user", "content": "ping"}],
    )

    assert response["model"] == "gpt-5.6-sol"
    assert base.calls == 2
    assert client.request_count == 2
    assert client.backoff_events == 1


@pytest.mark.asyncio
async def test_does_not_retry_non_transport_failure(monkeypatch: pytest.MonkeyPatch):
    class InvalidResponseClient:
        base_url = "https://relay.example/v1"

        def __init__(self):
            self.calls = 0

        async def chat_completions_create(self, **_body: Any):
            self.calls += 1
            raise ValueError("invalid detector response")

    base = InvalidResponseClient()
    client = ThrottledOpenAIClient(base)  # type: ignore[arg-type]

    async def unexpected_backoff(_delay: float) -> None:
        pytest.fail("non-transport failures must not be retried")

    monkeypatch.setattr(client, "_trigger_backoff", unexpected_backoff)

    with pytest.raises(ValueError, match="invalid detector response"):
        await client.chat_completions_create(model="gpt-5.6-sol", messages=[])

    assert base.calls == 1
    assert client.request_count == 1


@pytest.mark.asyncio
async def test_disconnect_retries_are_bounded(monkeypatch: pytest.MonkeyPatch):
    class AlwaysDisconnectedClient:
        base_url = "https://relay.example/v1"

        def __init__(self):
            self.calls = 0

        async def chat_completions_create(self, **_body: Any):
            self.calls += 1
            raise httpx.RemoteProtocolError("server disconnected")

    base = AlwaysDisconnectedClient()
    client = ThrottledOpenAIClient(base)  # type: ignore[arg-type]

    async def no_wait(_delay: float) -> None:
        client.backoff_events += 1

    monkeypatch.setattr(client, "_trigger_backoff", no_wait)

    with pytest.raises(httpx.RemoteProtocolError, match="server disconnected"):
        await client.chat_completions_create(model="gpt-5.6-sol", messages=[])

    assert base.calls == 4
    assert client.request_count == 4
    assert client.backoff_events == 3


@pytest.mark.asyncio
async def test_does_not_replay_stream_after_first_chunk():
    class InterruptedStreamClient:
        base_url = "https://relay.example/v1"

        def __init__(self):
            self.calls = 0

        async def chat_completions_stream(self, **_body: Any):
            self.calls += 1
            yield {"choices": [{"delta": {"content": "partial"}}]}, 10
            raise httpx.RemoteProtocolError("stream interrupted")

    base = InterruptedStreamClient()
    client = ThrottledOpenAIClient(base)  # type: ignore[arg-type]
    chunks: list[dict[str, Any]] = []

    with pytest.raises(httpx.RemoteProtocolError, match="stream interrupted"):
        async for chunk, _elapsed in client.chat_completions_stream(
            model="gpt-5.6-sol",
            messages=[],
        ):
            chunks.append(chunk)

    assert len(chunks) == 1
    assert base.calls == 1
    assert client.request_count == 1
    assert client.backoff_events == 0

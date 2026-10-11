"""OpenAI Chat Completions runner wiring."""

from __future__ import annotations

from ...core.detectors_base import BaseDetector, PassiveDetector
from ...core.models import ExecutionConfig
from ...model_catalog import chat_tools_supported, is_generic_chat
from ...core.runner import Runner as CoreRunner
from .client import OpenAIChatClient, ThrottledOpenAIClient
from .config import MODE_DETECTORS


def _make_throttled_client(
    base_client: OpenAIChatClient,
    passive_detectors: list[PassiveDetector],
    max_concurrent: int,
) -> ThrottledOpenAIClient:
    return ThrottledOpenAIClient(
        base_client,
        passive_detectors=passive_detectors,
        max_concurrent=max_concurrent,
    )


async def _ttft_probe(client: ThrottledOpenAIClient, model: str) -> None:
    async for _chunk, _elapsed in client.chat_completions_stream(
        model=model,
        max_completion_tokens=8,
        messages=[{"role": "user", "content": "Reply with: ok"}],
        stream_options={"include_usage": True},
    ):
        pass


class Runner(CoreRunner):
    def _select_detectors(self, model: str) -> list[BaseDetector]:
        selected = super()._select_detectors(model)
        if is_generic_chat(model):
            # Compatible does not mean OpenAI-identical. Do not apply OpenAI
            # fingerprint/tokenizer/determinism assumptions to another vendor.
            return [d for d in selected if d.name in {"basic_request", "integrity"}]
        if not chat_tools_supported(model):
            selected = [d for d in selected if d.name != "function_calling"]
        return selected

    async def run(self, model: str):
        outcome = await super().run(model)
        for result in outcome.results:
            if result.status == "skip" and result.details.get("skip_reason") == "model-excluded":
                result.details["skip_reason"] = (
                    "基础兼容检测：尚无该厂商的独立校验规则，不套用 OpenAI 指纹或计费标准"
                    if is_generic_chat(model) else
                    "官方限制：该模型的工具调用需要 Responses API，本页使用 Chat Completions"
                )
        return outcome

    def __init__(
        self,
        base_client: OpenAIChatClient,
        detectors: list[BaseDetector],
        config: ExecutionConfig,
    ):
        super().__init__(
            base_client,
            detectors,
            config,
            mode_detectors=MODE_DETECTORS,
            throttled_client_factory=_make_throttled_client,
            ttft_probe=_ttft_probe,
        )

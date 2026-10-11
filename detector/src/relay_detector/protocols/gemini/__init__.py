"""Gemini OpenAI-compatible protocol package.

The detector tests Gemini relays through the OpenAI Chat Completions wire shape.
There is no native `/v1beta/models/X:generateContent` path — almost every
third-party relay exposes Gemini under `/v1/chat/completions`, and Google's
own OpenAI-compat endpoint at `/v1beta/openai/chat/completions` speaks the
same shape.
"""

from __future__ import annotations

from pathlib import Path

from ...core.detectors_base import BaseDetector
from ...core.models import DetectionTier, ExecutionConfig, Mode, Protocol
from .client import DEFAULT_GEMINI_OPENAI_BASE_URL, GeminiClient
from .config import GEMINI_MODEL_CHOICES
from .detectors import build_all
from .runner import Runner

PROTOCOL_NAME = Protocol.GEMINI
TIER = DetectionTier.PROTOCOL


def model_choices() -> list[str]:
    return list(GEMINI_MODEL_CHOICES)


def default_model() -> str:
    return GEMINI_MODEL_CHOICES[0]


# Stable and cost-conscious aliases first. Older supported models remain as
# fallbacks for relays that lag Google's current catalog; shut-down IDs are
# intentionally absent. Used by pick_default_model() — see the OpenAI version
# for the matching philosophy.
_PREFERRED_DEFAULTS = (
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
)


def _matches_preferred_alias(model: str, preferred: str) -> bool:
    bare = model.removeprefix("models/")
    if bare == preferred:
        return True
    prefix = preferred + "-"
    if not bare.startswith(prefix):
        return False
    suffix = bare[len(prefix):]
    return bool(suffix) and suffix[0].isdigit()


def pick_default_model(available: list[str]) -> str | None:
    if not available:
        return None
    for pref in _PREFERRED_DEFAULTS:
        for m in available:
            if _matches_preferred_alias(m, pref):
                return m
    return available[0]


def default_base_url() -> str:
    """Suggested base URL placeholder for the Gemini submission form."""
    return DEFAULT_GEMINI_OPENAI_BASE_URL


def build_config(mode: Mode, max_concurrent: int = 3) -> ExecutionConfig:
    return ExecutionConfig.for_mode(mode, max_concurrent=max_concurrent)


def build_detectors(mode: Mode | None = None) -> list[BaseDetector]:
    _ = mode
    return build_all()


def make_client(
    base_url: str, api_key: str, timeout: float, *, trust_env: bool = True
) -> GeminiClient:
    return GeminiClient(base_url, api_key, timeout=timeout, trust_env=trust_env)


def build_runner(
    client: GeminiClient,
    detectors: list[BaseDetector],
    config: ExecutionConfig,
) -> Runner:
    return Runner(client, detectors, config)


def baseline_path(model_id: str, mode: Mode) -> Path | None:
    _ = model_id, mode
    return None


def verdict_caption(score: float) -> str:
    if score >= 85:
        return "协议表现良好"
    if score >= 70:
        return "基本通过"
    if score >= 50:
        return "存在风险"
    return "未达标"


def tier_banner() -> tuple[str, str]:
    return (
        "协议级验证",
        (
            "本检测通过 OpenAI 兼容协议 (POST /chat/completions) 探测 Gemini 中转站,"
            "验证响应字段、tool 调用、结构化输出、流式一致性和 usage 字段是否符合 OpenAI 规范。"
            "它不提供签名回放或绝对模型真伪证明。"
        ),
    )

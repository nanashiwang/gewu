"""OpenAI Chat Completions protocol implementation."""

from __future__ import annotations

from pathlib import Path

from ...core.detectors_base import BaseDetector
from ...core.models import DetectionTier, ExecutionConfig, Mode, Protocol
from .client import OpenAIChatClient
from .config import OPENAI_MODEL_CHOICES
from .detectors import build_all
from .runner import Runner

PROTOCOL_NAME = Protocol.OPENAI
TIER = DetectionTier.BEHAVIORAL


def model_choices() -> list[str]:
    return list(OPENAI_MODEL_CHOICES)


def default_model() -> str:
    return OPENAI_MODEL_CHOICES[0]


# Current, cost-conscious aliases preferred when /v1/models gives us a
# choice. Luna is the cheapest GPT-5.6 tier; older aliases remain as relay
# compatibility fallbacks. Used by pick_default_model() to pre-fill the form
# after a probe rather than landing on whatever happens to sort first.
_PREFERRED_DEFAULTS = (
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4-nano",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5-mini",
    "gpt-5",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-3.5-turbo",
)


def _matches_preferred_alias(model: str, preferred: str) -> bool:
    """Match an alias or an official numeric snapshot, not another SKU.

    A plain prefix match makes `gpt-5.4-pro` look like a snapshot of
    `gpt-5.4`, which can auto-select a Responses-only model for this Chat
    Completions detector. Official snapshots start with a numeric suffix.
    """
    if model == preferred:
        return True
    prefix = preferred + "-"
    if not model.startswith(prefix):
        return False
    suffix = model[len(prefix):]
    return bool(suffix) and suffix[0].isdigit()


def pick_default_model(available: list[str]) -> str | None:
    """Pick the most likely-to-just-work model from a relay's whitelist.

    Tries exact alias match first, then snapshot-suffix match (e.g. our
    preferred 'gpt-4o-mini' should pick 'gpt-4o-mini-2024-07-18' when the
    relay only carries snapshots). Falls back to the first available model
    when no preference matches — better to pre-fill *something* than leave
    the form on a default we already know the relay doesn't carry.
    """
    if not available:
        return None
    for pref in _PREFERRED_DEFAULTS:
        for m in available:
            if _matches_preferred_alias(m, pref):
                return m
    return available[0]


def build_config(mode: Mode, max_concurrent: int = 3) -> ExecutionConfig:
    return ExecutionConfig.for_mode(mode, max_concurrent=max_concurrent)


def build_detectors(mode: Mode | None = None) -> list[BaseDetector]:
    _ = mode
    return build_all()


def make_client(
    base_url: str, api_key: str, timeout: float, *, trust_env: bool = True
) -> OpenAIChatClient:
    return OpenAIChatClient(base_url, api_key, timeout=timeout, trust_env=trust_env)


def build_runner(
    client: OpenAIChatClient,
    detectors: list[BaseDetector],
    config: ExecutionConfig,
) -> Runner:
    if config.openai_wire_api == "responses":
        from .responses import build_responses_runner
        return build_responses_runner(client, config)
    return Runner(client, detectors, config)


def baseline_path(model_id: str, mode: Mode) -> Path | None:
    candidates = [
        Path("data/baselines/openai") / f"{model_id}_{mode.value}.json",
        Path("data/baselines/openai") / f"{model_id}_full.json",
        Path("data/baselines/openai") / f"{model_id}_chat_text.json",
    ]
    return next((path for path in candidates if path.is_file()), None)


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
        "行为/协议级验证",
        (
            "本检测无法可靠区分高配模型真品与低配模型伪装。"
            "我们检测的是中转站接口是否符合 OpenAI Chat Completions 协议规范、"
            "能力是否完整、usage 字段是否符合官方响应形状。"
        ),
    )

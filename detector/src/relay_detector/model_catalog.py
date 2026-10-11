"""Source-qualified picker catalog. Vendor identity is not an API protocol.

Suggestions are reviewed snapshots, not proof of a relay's available models or
model identity. A relay's /models response takes precedence for availability.
Keep restricted products labelled; never silently substitute model IDs.
"""

from __future__ import annotations

from datetime import date
import re

VERIFIED_ON = "2026-10-11"
REVIEW_INTERVAL_DAYS = 30

VENDORS = (
    {"id": "anthropic", "label": "Anthropic · Claude", "route": "claude",
     "source": "https://platform.claude.com/docs/en/about-claude/models/overview",
     "models": ("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")},
    {"id": "openai", "label": "OpenAI · GPT", "route": "openai",
     "source": "https://developers.openai.com/api/docs/models",
     "models": ("gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano")},
    {"id": "google", "label": "Google · Gemini", "route": "gemini",
     "source": "https://ai.google.dev/gemini-api/docs/models?hl=en",
     "models": ("gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite")},
    {"id": "deepseek", "label": "DeepSeek · 深度求索", "route": "openai",
     "source": "https://api-docs.deepseek.com/quick_start/pricing",
     "models": ("deepseek-flash", "deepseek-v4-pro")},
    {"id": "qwen", "label": "Alibaba · 通义千问", "route": "openai",
     "source": "https://www.alibabacloud.com/help/en/model-studio/models",
     "models": ("qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash")},
    {"id": "moonshot", "label": "Moonshot · Kimi", "route": "openai",
     "source": "https://platform.moonshot.ai/docs/intro",
     "models": ("kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6")},
    {"id": "zai", "label": "智谱 · GLM", "route": "openai",
     "source": "https://docs.z.ai/guides/overview/overview",
     "models": ("glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2")},
    {"id": "minimax", "label": "MiniMax", "route": "openai",
     "source": "https://platform.minimax.io/docs/guides/models-intro",
     "models": ("MiniMax-M3.1-Flash-Preview", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed")},
    {"id": "xai", "label": "xAI · Grok", "route": "openai",
     "source": "https://docs.x.ai/developers/models",
     "models": ("grok-4.7",)},
)

MODEL_NOTES = {
    "MiniMax-M3.1-Flash-Preview": "仅 M Plan / MiniMax Code",
    "gemini-2.5-pro": "仅既有用户",
    "gemini-2.5-flash": "仅既有用户",
    "gemini-2.5-flash-lite": "仅既有用户",
}

# Explicit input budgets; GPT-6 total context also reserves output tokens.
REVIEWED_INPUT_LIMITS = {
    "gpt-6-astra": 922_000, "gpt-6.1-sol": 922_000,
    "gpt-6-sol": 922_000, "gpt-6-luna": 922_000,
    "claude-fable-5-1": 1_000_000, "claude-opus-5-5": 1_000_000,
    "claude-sonnet-5-5": 1_000_000, "claude-haiku-5-5": 1_000_000,
}


def choices(vendor: str) -> list[str]:
    return list(next((v["models"] for v in VENDORS if v["id"] == vendor), ()))


def catalog_view(today: date | None = None) -> dict:
    age = ((today or date.today()) - date.fromisoformat(VERIFIED_ON)).days
    vendors = [{**v, "models": [
        {"id": m, "label": m + (f"（{MODEL_NOTES[m]}）" if m in MODEL_NOTES else "")}
        for m in v["models"]
    ]} for v in VENDORS]
    vendors.append({"id": "other", "label": "其他厂商 / 自定义模型", "route": "openai",
                    "source": "", "models": []})
    return {"verified_on": VERIFIED_ON, "stale": age > REVIEW_INTERVAL_DAYS,
            "vendors": vendors, "vendor_count": len(VENDORS)}


def bare_model(model: str) -> str:
    """For classification only. Never use this value in an upstream request."""
    return model.strip().lower().rsplit("/", 1)[-1]


def model_vendor(model: str) -> str:
    s = bare_model(model)
    for prefixes, vendor in (
        (("claude",), "anthropic"), (("gpt-", "chatgpt-", "o1", "o3", "o4"), "openai"),
        (("gemini",), "google"), (("deepseek",), "deepseek"),
        (("qwen", "qwq"), "qwen"), (("kimi", "moonshot"), "moonshot"),
        (("glm-",), "zai"), (("minimax",), "minimax"), (("grok",), "xai"),
    ):
        if s.startswith(prefixes):
            return vendor
    return "other"


def is_chat_candidate(model: str) -> bool:
    s = bare_model(model)
    # The list endpoint can mix modalities and Responses-only products.
    return bool(s) and not any(x in s for x in (
        "embedding", "rerank", "image", "audio", "tts", "transcribe", "whisper",
        "realtime", "-live", "video", "imagine", "nano-banana", "codex",
        "deep-research", "robotics", "computer-use", "moderation", "omni",
    )) and not re.match(r"gpt-.*-pro(?:-|$)", s)


def model_protocol(model: str) -> str | None:
    if not is_chat_candidate(model):
        return None
    vendor = model_vendor(model)
    if vendor == "anthropic":
        return "anthropic"
    if vendor == "google":
        return "gemini"
    return "openai" if vendor != "other" else None


def is_generic_chat(model: str) -> bool:
    return model_vendor(model) not in {"openai", "google", "anthropic"}


def chat_tools_supported(model: str) -> bool:
    s = bare_model(model)
    return not s.startswith(("gpt-6-astra", "gpt-6.1-sol"))

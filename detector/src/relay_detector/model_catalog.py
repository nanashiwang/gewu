"""Source-qualified picker catalog. Vendor identity is not an API protocol.

Suggestions are reviewed snapshots, not proof of a relay's available models or
model identity. A relay's /models response takes precedence for availability.
Keep restricted products labelled; never silently substitute model IDs.
"""

from __future__ import annotations

from datetime import date
import re

# Shared with the account form; package data is included in wheels and Docker.
from importlib.resources import files
import json

_CATALOG = json.loads(files("relay_detector").joinpath("data/model_catalog.json").read_text(encoding="utf-8"))
VERIFIED_ON = _CATALOG["verified_on"]
REVIEW_INTERVAL_DAYS = _CATALOG["review_interval_days"]
VENDORS = tuple(_CATALOG["vendors"])
MODEL_NOTES = _CATALOG["model_notes"]
REVIEWED_INPUT_LIMITS = _CATALOG["reviewed_input_limits"]

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

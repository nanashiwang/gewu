"""Gemini OpenAI-compat detector config — model list, weights, mode mapping."""

from __future__ import annotations

from ...core.models import Mode
from ...model_catalog import choices


# Detector internal names match what the web UI expects in `_DETECTOR_DISPLAY`.
# `model_info` and `token_usage` are Gemini-flavored renames of OpenAI's
# `model_consistency` and `token_billing` — the validation logic is the same
# Chat Completions shape, the labels are what users see in the report.
DETECTOR_WEIGHTS: dict[str, float] = {
    "basic_request": 15.0,
    "model_info": 15.0,
    "function_calling": 15.0,
    "structured_output": 15.0,
    "protocol": 15.0,
    "integrity": 15.0,
    "token_usage": 10.0,
}


MODE_DETECTORS: dict[Mode, set[str]] = {
    Mode.QUICK: {
        "basic_request",
        "model_info",
        "protocol",
    },
    Mode.STANDARD: set(DETECTOR_WEIGHTS.keys()),
    Mode.FULL: set(DETECTOR_WEIGHTS.keys()),
}


GEMINI_MODEL_CHOICES = choices("google")


def models_match(request_model: str, response_model: str) -> bool:
    """Lenient match for Gemini OpenAI-compat responses.

    Relays return the model id in `response.model` in several shapes:
    - bare alias: `gemini-2.5-flash`
    - dated snapshot: `gemini-2.5-flash-001`, `gemini-2.5-flash-09-2025`
    - prefixed: `models/gemini-2.5-flash` (some relays echo Google's native form)

    We accept any of these as long as one is a prefix of the other after
    stripping the `models/` prefix.
    """
    if not request_model or not response_model:
        return False
    a = request_model.removeprefix("models/").replace(".", "-").replace("_", "-")
    b = response_model.removeprefix("models/").replace(".", "-").replace("_", "-")
    return a == b or a.startswith(b) or b.startswith(a)

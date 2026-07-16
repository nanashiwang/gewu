"""ThinkingSignatureDetector — DESIGN.md §3.3 ⭐.

Active. Extended/adaptive thinking emits an opaque server-side signature.
Presence and length alone are not proof: a relay can fabricate a long string.
The detector therefore performs a positive round trip with the original block
and a negative control with one tampered signature byte. A conforming Claude
endpoint must accept the original and reject the tampered block with the
documented validation error.

Sub-checks:
  100 — original block is accepted and tampered control is specifically rejected
   60 — signature-shaped field exists but enforcement could not be proven
   40 — signature-shaped field exists but is suspiciously short
   20 — thinking block exists but no opaque signature/data arrived
    0 — thinking parameter ignored / no thinking block at all

applies_to() filters out models that don't support thinking at all.
For models that support both extended and adaptive (Sonnet 4.6), we prefer
extended because budget_tokens gives us tighter cost control.
"""

from __future__ import annotations

import copy

from ..config import lookup_model
from ....core.models import DetectorResult
from .base import ActiveDetector


# Multi-step Euclidean GCD: complex enough that Opus 4.7's adaptive thinking
# reliably decides to think (a simple multiplication wouldn't). Using
# different numbers from the official 1071/462 doc example so a relay
# can't special-case the canonical demo. We deliberately keep the prompt
# minimal — adding "walk through each step" hints at structure and can
# nudge the model away from thinking.
PROBE_PROMPT = (
    "Find the greatest common divisor of 2378 and 1547 using the Euclidean "
    "algorithm."
)
THINKING_BUDGET_TOKENS = 2000
# max_tokens caps thinking + response combined. With effort=high the adaptive
# model can use a lot of thinking tokens; setting this too low (e.g. 2600)
# causes the model to skip thinking entirely to fit. 16000 matches the
# official documentation examples.
MAX_TOKENS = 16000

# Empirically observed Anthropic thinking signatures are >> 100 chars; we
# settle for >= 50 as a generous lower bound.
SIGNATURE_MIN_LEN = 50
REPLAY_MAX_TOKENS = 16
REPLAY_PROMPT = "Reply with OK."


def _opaque_value(block: dict) -> str:
    if block.get("type") == "thinking":
        value = block.get("signature")
    elif block.get("type") == "redacted_thinking":
        value = block.get("data")
    else:
        value = None
    return value if isinstance(value, str) else ""


def _tamper_thinking_content(content: list[dict]) -> list[dict] | None:
    """Copy content and flip one opaque signature character."""
    changed = copy.deepcopy(content)
    for block in changed:
        if not isinstance(block, dict):
            continue
        key = "signature" if block.get("type") == "thinking" else (
            "data" if block.get("type") == "redacted_thinking" else ""
        )
        value = block.get(key) if key else None
        if not isinstance(value, str) or not value:
            continue
        replacement = "A" if value[-1] != "A" else "B"
        block[key] = value[:-1] + replacement
        return changed
    return None


def _error_text(error: Exception) -> str:
    body = getattr(error, "body", None)
    return body if isinstance(body, str) and body else str(error)


def _is_thinking_validation_error(error: Exception) -> bool:
    status = getattr(error, "status", None)
    text = _error_text(error).lower()
    return status == 400 and "thinking" in text and (
        "cannot be modified" in text
        or "must remain as they were" in text
        or "must remain unchanged" in text
    )


def _adaptive_effort_for_model(model: str) -> str:
    normalized = model.replace(".", "-").replace("_", "-")
    if normalized.startswith(("claude-opus-4-7", "claude-opus-4-8")):
        return "xhigh"
    return "high"


class ThinkingSignatureDetector(ActiveDetector):
    name = "thinking_signature"
    display_name = "思维签名验证"
    weight = 25.0

    def applies_to(self, model: str) -> bool:
        info = lookup_model(model)
        if info is None:
            return False
        return info.supports_extended_thinking or info.supports_adaptive_thinking

    async def run(self, client, model: str) -> DetectorResult:
        info = lookup_model(model)
        if info is None:  # belt-and-braces — applies_to should have caught this
            return self.skip("unknown model")

        # adaptive thinking uses a SEPARATE top-level `output_config.effort`
        # field — NOT a key under `thinking`. Putting effort inside thinking
        # is a 400 error ("Extra inputs are not permitted").
        extra: dict = {}
        if info.supports_extended_thinking:
            thinking = {"type": "enabled", "budget_tokens": THINKING_BUDGET_TOKENS}
        elif info.supports_adaptive_thinking:
            # Opus 4.7 defaults `display` to "omitted"; explicit "summarized"
            # gives us thinking text to inspect. New Opus adaptive probes need
            # xhigh for reliable signed-thinking emission on harder prompts.
            thinking = {"type": "adaptive", "display": "summarized"}
            extra["output_config"] = {"effort": _adaptive_effort_for_model(model)}
        else:
            return self.skip("model lacks thinking support")

        # Use NON-streaming. Empirically, streaming + adaptive + summarized on
        # Opus 4.7 silently drops the thinking block from the SSE stream
        # (verified: curl with `stream:true` shows only text events; curl
        # without stream returns full thinking+signature). Non-streaming gets
        # the same signature in `content[*].signature`, so detection power is
        # unchanged.
        try:
            _req, resp, _h, _lat = await client.messages_create(
                model=model,
                max_tokens=MAX_TOKENS,
                thinking=thinking,
                messages=[{"role": "user", "content": PROBE_PROMPT}],
                **extra,
            )
        except Exception as e:  # noqa: BLE001
            return self._result(
                "error",
                0.0,
                {
                    "thinking_params": thinking,
                    "output_config_sent": extra.get("output_config"),
                },
                error=str(e),
            )

        thinking_block_seen = False
        thinking_block_type: str | None = None
        signature_value = ""
        thinking_text_chars = 0
        content_block_types_seen: list[str] = []
        for block in resp.get("content") or []:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if isinstance(btype, str):
                content_block_types_seen.append(btype)
            if btype in ("thinking", "redacted_thinking"):
                thinking_block_seen = True
                thinking_block_type = btype
                opaque = _opaque_value(block)
                if opaque and not signature_value:
                    signature_value = opaque
                t = block.get("thinking")
                if isinstance(t, str):
                    thinking_text_chars += len(t)
        signature_received = bool(signature_value)
        stop_reason = resp.get("stop_reason")

        details: dict = {
            "thinking_params": thinking,
            "output_config_sent": extra.get("output_config"),
            "content_block_types_seen": content_block_types_seen,
            "thinking_block_seen": thinking_block_seen,
            "thinking_block_type": thinking_block_type,
            "thinking_text_chars": thinking_text_chars,
            "signature_received": signature_received,
            "signature_length": len(signature_value),
            "signature_prefix": signature_value[:32] if signature_value else "",
            "stop_reason": stop_reason,
            "signature_roundtrip_accepted": False,
            "tampered_signature_rejected": False,
            "tampered_rejection_verified": False,
        }

        if not thinking_block_seen:
            score = 0.0
            note = "no_thinking_block"
        elif not signature_received or not signature_value:
            score = 20.0
            note = "thinking_block_but_no_signature"
        elif len(signature_value) < SIGNATURE_MIN_LEN:
            score = 40.0
            note = "signature_too_short"
        else:
            original_content = [
                block for block in (resp.get("content") or []) if isinstance(block, dict)
            ]
            replay_messages = [
                {"role": "user", "content": PROBE_PROMPT},
                {"role": "assistant", "content": original_content},
                {"role": "user", "content": REPLAY_PROMPT},
            ]
            try:
                await client.messages_create(
                    model=model,
                    max_tokens=REPLAY_MAX_TOKENS,
                    messages=replay_messages,
                )
                details["signature_roundtrip_accepted"] = True
            except Exception as error:  # noqa: BLE001
                details["signature_roundtrip_error"] = _error_text(error)[:280]
                score = 50.0
                note = "original_signature_roundtrip_rejected"
            else:
                tampered = _tamper_thinking_content(original_content)
                if tampered is None:
                    score = 60.0
                    note = "signature_present_but_not_tamperable"
                else:
                    tampered_messages = [
                        {"role": "user", "content": PROBE_PROMPT},
                        {"role": "assistant", "content": tampered},
                        {"role": "user", "content": REPLAY_PROMPT},
                    ]
                    try:
                        await client.messages_create(
                            model=model,
                            max_tokens=REPLAY_MAX_TOKENS,
                            messages=tampered_messages,
                        )
                    except Exception as error:  # noqa: BLE001
                        details["tampered_signature_rejected"] = True
                        details["tampered_rejection_verified"] = (
                            _is_thinking_validation_error(error)
                        )
                        details["tampered_rejection_error"] = _error_text(error)[:280]
                        if details["tampered_rejection_verified"]:
                            score = 100.0
                            note = "signature_roundtrip_verified"
                        else:
                            score = 65.0
                            note = "tampered_rejected_for_unverified_reason"
                    else:
                        score = 60.0
                        note = "tampered_signature_accepted"
        details["evaluation"] = note

        status = "pass" if score >= 70 else "fail"
        return self._result(status, score, details)

"""Inspect transport error fields, never model self-description, for auth errors."""
import re
from typing import Any, Mapping

_AUTH_ERROR_PATTERNS = (
    re.compile(r"\b(?:401|403)\b"),
    re.compile(r"authentication[_ -]?error", re.IGNORECASE),
    re.compile(r"unauthori[sz]ed", re.IGNORECASE),
    re.compile(r"invalid.{0,24}api.{0,8}key", re.IGNORECASE),
    re.compile(r"incorrect.{0,24}api.{0,8}key", re.IGNORECASE),
    re.compile(r"bad key", re.IGNORECASE),
    re.compile(r"鉴权|认证失败|无效.{0,12}(?:密钥|key)", re.IGNORECASE),
)


def _collect_error_text(value: Any, output: list[str]) -> None:
    """Collect transport/auth error fields without scanning model response text."""
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized_key = str(key).lower()
            if normalized_key in {
                "error",
                "error_message",
                "message",
                "response_body",
                "status",
                "status_code",
            }:
                if isinstance(child, (str, int)):
                    output.append(str(child))
                else:
                    _collect_error_text(child, output)
            elif isinstance(child, (Mapping, list, tuple)):
                _collect_error_text(child, output)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _collect_error_text(child, output)


def contains_auth_failure(results: list[dict[str, Any]]) -> bool:
    text_parts: list[str] = []
    for result in results:
        error = result.get("error")
        if isinstance(error, str):
            text_parts.append(error)
        _collect_error_text(result.get("details"), text_parts)
    text = "\n".join(text_parts)
    return any(pattern.search(text) for pattern in _AUTH_ERROR_PATTERNS)

"""Security primitives for the public web surface.

The CLI is intentionally able to reach local endpoints.  The hosted web app
is different: accepting an arbitrary URL turns the server into an SSRF proxy
unless local, private and metadata addresses are rejected before any request.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit


MAX_TARGET_URL_LENGTH = 2048
MAX_API_KEY_LENGTH = 4096
MAX_MODEL_LENGTH = 200
REDACTED = "[REDACTED]"

_LOCAL_HOSTNAMES = {"localhost", "localhost.localdomain", "ip6-localhost"}
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".home", ".lan")
_TRUE_VALUES = {"1", "true", "yes", "on"}


class TargetValidationError(ValueError):
    """Raised when a relay target is unsafe or structurally invalid."""


def private_targets_allowed() -> bool:
    """Return whether this deployment explicitly allows private targets."""
    return os.environ.get("XIANCE_ALLOW_PRIVATE_TARGETS", "").strip().lower() in _TRUE_VALUES


def _is_public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    return address.is_global


async def _resolve_addresses(hostname: str, port: int) -> set[str]:
    loop = asyncio.get_running_loop()
    try:
        records = await loop.getaddrinfo(
            hostname,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except socket.gaierror as exc:
        raise TargetValidationError("中转站域名无法解析") from exc
    return {str(record[4][0]).split("%", 1)[0] for record in records}


async def validate_target_url(
    value: str,
    *,
    allow_private: bool | None = None,
) -> str:
    """Validate and normalize a user-supplied relay base URL.

    All currently resolved addresses must be globally routable.  A self-hosted
    operator who intentionally needs LAN targets can set
    ``XIANCE_ALLOW_PRIVATE_TARGETS=1``; URL structure checks still apply.
    """
    if not isinstance(value, str):
        raise TargetValidationError("中转站地址格式不正确")
    target = value.strip().rstrip("/")
    if not target or len(target) > MAX_TARGET_URL_LENGTH:
        raise TargetValidationError(
            f"中转站地址长度必须在 1–{MAX_TARGET_URL_LENGTH} 个字符之间"
        )
    if any(ord(char) < 32 or ord(char) == 127 for char in target):
        raise TargetValidationError("中转站地址不能包含控制字符")

    try:
        parts = urlsplit(target)
        port = parts.port
    except ValueError as exc:
        raise TargetValidationError("中转站地址或端口格式不正确") from exc

    if parts.scheme.lower() not in {"http", "https"}:
        raise TargetValidationError("中转站地址必须以 http:// 或 https:// 开头")
    if not parts.hostname:
        raise TargetValidationError("中转站地址缺少有效域名或 IP")
    if parts.username is not None or parts.password is not None:
        raise TargetValidationError("中转站地址不能包含用户名或密码")
    if parts.query or parts.fragment:
        raise TargetValidationError("中转站地址不能包含查询参数或 # 片段")
    if ".." in parts.path.split("/"):
        raise TargetValidationError("中转站地址不能包含上级目录路径")

    hostname = parts.hostname.rstrip(".").lower()
    if not hostname or "%" in hostname:
        raise TargetValidationError("中转站主机名格式不正确")

    if allow_private is None:
        allow_private = private_targets_allowed()
    if allow_private:
        return target

    if hostname in _LOCAL_HOSTNAMES or hostname.endswith(_LOCAL_SUFFIXES):
        raise TargetValidationError(
            "出于服务器安全考虑，在线版不能检测本机或内网地址"
        )

    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        addresses = await _resolve_addresses(hostname, port or (443 if parts.scheme == "https" else 80))
        if not addresses:
            raise TargetValidationError("中转站域名没有可用 IP 地址")
        if not addresses_are_public(addresses):
            raise TargetValidationError(
                "该域名解析到本机、内网或保留地址，在线版已拒绝访问"
            )
    else:
        if not literal.is_global:
            raise TargetValidationError(
                "在线版不能检测本机、内网、链路本地或云元数据地址"
            )

    return target


def redact_text(text: str, secret: str) -> str:
    """Remove an exact secret from text returned by an untrusted relay."""
    if not secret or len(secret) < 4:
        return text
    return text.replace(secret, REDACTED)


def redact_secret(value: Any, secret: str) -> Any:
    """Recursively redact a reflected secret before persistence or output."""
    if isinstance(value, str):
        return redact_text(value, secret)
    if isinstance(value, dict):
        return {
            redact_text(key, secret) if isinstance(key, str) else key: redact_secret(item, secret)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_secret(item, secret) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_secret(item, secret) for item in value)
    if isinstance(value, set):
        return {redact_secret(item, secret) for item in value}
    return value


def addresses_are_public(addresses: Iterable[str]) -> bool:
    """Small testable predicate used by adversarial DNS cases."""
    values = list(addresses)
    return bool(values) and all(_is_public_ip(value) for value in values)

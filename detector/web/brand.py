"""Single source of truth for the public 格物 brand."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse


def _normalise_site_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if not value:
        return "http://localhost:8765"
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("GEWU_SITE_URL must be an absolute http(s) URL")
    return value


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name) or default


def _optional_http_url(name: str) -> str:
    value = _env(name).strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(f"{name} must be an absolute http(s) URL")
    return value


def _analytics_id() -> str:
    value = _env("GEWU_ANALYTICS_ID").strip()
    if value and not re.fullmatch(r"[A-Z0-9-]{3,32}", value):
        raise RuntimeError("GEWU_ANALYTICS_ID has an invalid format")
    return value


@dataclass(frozen=True)
class BrandConfig:
    name: str
    english_name: str
    short_name: str
    slogan: str
    site_url: str
    source_url: str
    analytics_id: str

    def url(self, path: str = "/") -> str:
        """Return a canonical absolute URL for a public path."""
        return urljoin(f"{self.site_url}/", path.lstrip("/"))

    @property
    def public_host(self) -> str:
        return urlparse(self.site_url).netloc


brand = BrandConfig(
    name="格物",
    english_name="GEWU",
    short_name="格物",
    slogan="让 AI 能力，有据可验。",
    site_url=_normalise_site_url(
        _env("GEWU_SITE_URL", "http://localhost:8765")
    ),
    source_url=_optional_http_url("GEWU_SOURCE_URL"),
    analytics_id=_analytics_id(),
)

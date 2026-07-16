"""Single source of truth for the public XianCe AI brand."""

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
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("XIANCE_SITE_URL must be an absolute http(s) URL")
    return value


def _optional_http_url(name: str) -> str:
    value = os.environ.get(name, "").strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(f"{name} must be an absolute http(s) URL")
    return value


def _analytics_id() -> str:
    value = os.environ.get("XIANCE_ANALYTICS_ID", "").strip()
    if value and not re.fullmatch(r"[A-Z0-9-]{3,32}", value):
        raise RuntimeError("XIANCE_ANALYTICS_ID has an invalid format")
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
    name="先测 AI",
    english_name="XianCe AI",
    short_name="先测",
    slogan="先测，再用。",
    site_url=_normalise_site_url(
        os.environ.get("XIANCE_SITE_URL", "http://localhost:8765")
    ),
    source_url=_optional_http_url("XIANCE_SOURCE_URL"),
    analytics_id=_analytics_id(),
)

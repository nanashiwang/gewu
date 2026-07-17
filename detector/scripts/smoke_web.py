#!/usr/bin/env python3
"""Public, credential-free production smoke test for the 格物 web service."""

from __future__ import annotations

import argparse
import json
import sys
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


def fetch(base_url: str, path: str, timeout: float) -> tuple[dict[str, str], bytes]:
    request = Request(
        urljoin(base_url.rstrip("/") + "/", path.lstrip("/")),
        headers={"User-Agent": "gewu-deployment-smoke/1"},
    )
    with urlopen(request, timeout=timeout) as response:  # noqa: S310
        if response.status != 200:
            raise RuntimeError(f"{path} returned HTTP {response.status}")
        return {key.lower(): value for key, value in response.headers.items()}, response.read()


def check(base_url: str, timeout: float) -> None:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must be an absolute http(s) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("base URL must not contain credentials, query, or fragment")

    for path in ("/healthz", "/readyz"):
        _, body = fetch(base_url, path, timeout)
        payload = json.loads(body)
        if payload.get("ok") is not True:
            raise RuntimeError(f"{path} is not ready: {payload!r}")

    headers, body = fetch(base_url, "/", timeout)
    html = body.decode("utf-8")
    if "格物" not in html:
        raise RuntimeError("home page does not contain the 格物 brand")

    expected_headers = {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
    }
    for name, expected in expected_headers.items():
        if headers.get(name) != expected:
            raise RuntimeError(f"missing or invalid {name} header")
    if "frame-ancestors 'none'" not in headers.get("content-security-policy", ""):
        raise RuntimeError("missing frame-ancestors CSP protection")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", help="public site URL, for example https://gewu.example")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    try:
        check(args.base_url, args.timeout)
    except Exception as exc:  # deployment script must return a clean non-zero exit
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"OK: {args.base_url.rstrip('/')} is healthy and ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

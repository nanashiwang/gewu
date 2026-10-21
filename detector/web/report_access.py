"""Anonymous report ownership and revocable, deliberately limited summaries.

The browser keeps its owner secret; disk stores only its hash. A share token is
stable while enabled and changes after revocation. Neither token is an API key.
New reports carry a durable privacy marker so missing metadata fails closed.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

VERSION = 1
COOKIE_AGE = 180 * 24 * 60 * 60
_OWNER_RE = re.compile(r"[A-Za-z0-9_-]{43}")
_DIGEST_RE = re.compile(r"[0-9a-f]{64}")
_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")


def valid_owner(value: str) -> bool:
    return isinstance(value, str) and _OWNER_RE.fullmatch(value) is not None


def cookie_name(secure: bool) -> str:
    return "__Host-gewu_report_owner" if secure else "gewu_report_owner"


def _path(root: Path, job_id: str) -> Path:
    if not _ID_RE.fullmatch(job_id):
        raise ValueError("invalid report id")
    return root / ".report_access" / f"{job_id}.access"


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _save(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def create(root: Path, job_id: str, owner: str, *, account_managed: bool = False) -> None:
    if not valid_owner(owner):
        raise ValueError("invalid report owner")
    path = _path(root, job_id)
    if path.exists() or path.is_symlink():
        raise ValueError("report ownership already exists")
    _save(path, {"version": VERSION, "owner_digest": _digest(owner), "share_nonce": "", "share_digest": "", "account_managed": account_managed})


def restricted(root: Path, job_id: str, *, version=0, report=None) -> bool:
    path = _path(root, job_id)
    return bool(version or (isinstance(report, dict) and "_web_access" in report)
                or path.exists() or path.is_symlink())


def _load(root: Path, job_id: str) -> dict | None:
    path = _path(root, job_id)
    try:
        if path.is_symlink():
            return None
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or data.get("version") != VERSION:
            return None
        if not _DIGEST_RE.fullmatch(str(data.get("owner_digest", ""))):
            return None
        nonce, digest = data.get("share_nonce"), data.get("share_digest")
        if (nonce, digest) != ("", "") and not (
            isinstance(nonce, str) and re.fullmatch(r"[0-9a-f]{32}", nonce)
            and isinstance(digest, str) and _DIGEST_RE.fullmatch(digest)
        ):
            return None
        return data
    except (OSError, ValueError, UnicodeError):
        return None


def owned(root: Path, job_id: str, owner: str) -> bool:
    data = _load(root, job_id) if valid_owner(owner) else None
    return bool(data and hmac.compare_digest(data["owner_digest"], _digest(owner)))


def enabled(root: Path, job_id: str) -> bool:
    data = _load(root, job_id)
    return bool(data and data["share_digest"])


def enable(root: Path, job_id: str, owner: str) -> str:
    if not owned(root, job_id, owner):
        raise PermissionError("report not available")
    data = _load(root, job_id)
    if data is None:
        raise PermissionError("report not available")
    data["share_nonce"] = data["share_nonce"] or secrets.token_hex(16)
    token = hmac.new(owner.encode(), f'{job_id}:{data["share_nonce"]}'.encode(), hashlib.sha256).hexdigest()
    data["share_digest"] = _digest(token)
    _save(_path(root, job_id), data)
    return token


def revoke(root: Path, job_id: str, owner: str) -> None:
    if not owned(root, job_id, owner):
        raise PermissionError("report not available")
    data = _load(root, job_id)
    if data is None:
        raise PermissionError("report not available")
    data.update(share_nonce="", share_digest="")
    _save(_path(root, job_id), data)


def shared(root: Path, job_id: str, token: str) -> bool:
    data = _load(root, job_id) if _DIGEST_RE.fullmatch(token) else None
    return bool(data and data["share_digest"] and hmac.compare_digest(data["share_digest"], _digest(token)))


def domain(report: dict) -> str:
    try:
        return urlsplit(str(report.get("base_url") or "")).hostname or "未显示站点"
    except ValueError:
        return "未显示站点"


def summary_report(report: dict) -> dict:
    """Allowlist display fields: never copy raw evidence, errors or URL paths.

    Assessment is computed separately from the complete original evidence;
    removing details must not accidentally upgrade/downgrade its conclusion.
    """
    safe = {key: report[key] for key in (
        "protocol", "wire_api", "mode", "target_model", "timestamp",
        "scoring_version", "probe_version", "total_score", "verdict",
    ) if key in report and isinstance(report[key], (str, int, float, type(None)))}
    safe["base_url"] = domain(report)
    safe["results"] = [
        {key: row[key] for key in ("name", "status", "score", "weight", "evidence_role")
         if key in row and isinstance(row[key], (str, int, float))}
        for row in report.get("results", []) if isinstance(row, dict)
    ]
    perf = report.get("performance") or {}
    usage = perf.get("usage") or {}
    def numeric(source, keys):
        return {key: source[key] for key in keys
                if isinstance(source.get(key), (int, float)) and not isinstance(source[key], bool)
                and math.isfinite(source[key]) and source[key] >= 0}
    safe["performance"] = numeric(perf, ("ttft_ms", "total_latency_ms", "tokens_per_second", "request_count"))
    safe["performance"]["usage"] = numeric(usage, ("input_tokens", "output_tokens"))
    safe["performance"]["usage_complete"] = perf.get("usage_complete", True) is True
    safe["performance_complete"] = report.get("performance_complete", True) is True
    return safe


def account_owner(secret: str, job_id: str) -> str:
    digest = hmac.new(secret.encode(), f"gewu-account-report:{job_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def account_grant(root: Path, job_id: str, secret: str) -> str:
    """Called only by the authenticated account server after checking ownership.

    A per-report capability cannot read other users' account reports. Rotation
    of the internal service key invalidates old account grants, not reports.
    Anonymous reports can never be claimed through this bridge.
    """
    data = _load(root, job_id)
    if not data or data.get("account_managed") is not True:
        raise PermissionError("not an account report")
    owner = account_owner(secret, job_id)
    digest = _digest(owner)
    if not hmac.compare_digest(data["owner_digest"], digest):
        data["owner_digest"] = digest
        data.update(share_nonce="", share_digest="")
        _save(_path(root, job_id), data)
    return owner


def account_managed(root: Path, job_id: str) -> bool:
    data = _load(root, job_id)
    return bool(data and data.get("account_managed") is True)


def account_cookie_owner(secret: str, job_id: str, value: str, session: str) -> str:
    """Bind a report capability to the current login session and server expiry.

    Logout/account switching removes or changes the session cookie, so a
    previous report grant cannot silently survive in a shared browser.
    The JWT itself and its digest are never stored with the report.
    """
    if not secret or not session or len(value) > 160:
        return ""
    parts = value.split(".")
    if len(parts) != 3:
        return ""
    owner, expiry, signature = parts
    if not valid_owner(owner) or not re.fullmatch(r"[0-9]{10,12}", expiry) or not _DIGEST_RE.fullmatch(signature):
        return ""
    if int(expiry) <= time.time():
        return ""
    payload = f"gewu-account-view\n{job_id}\n{owner}\n{expiry}\n{_digest(session)}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return owner if hmac.compare_digest(expected, signature) else ""

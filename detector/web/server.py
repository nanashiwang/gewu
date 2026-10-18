"""格物 FastAPI app — POST /api/detect, GET /r/{id}, GET /r/{id}.jpg."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from xml.sax.saxutils import escape as xml_escape

from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.responses import (
    HTMLResponse, JSONResponse, Response,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.concurrency import run_in_threadpool

from . import jobs, deployment_gate, leaderboard
from .job_feedback import job_feedback
from .observations import monitoring_snapshot
from .monitor_health import cached_monitor_health
from relay_detector.ranking import assess_ranking_eligibility
from relay_detector.core.assessment import assess_report
from relay_detector.model_catalog import catalog_view, choices as catalog_choices, model_protocol, model_vendor
from .brand import brand
from .faq_data import FAQ_CATEGORIES, faqpage_jsonld, total_question_count
from .featured_pricing import FEATURED_DOMAIN, FEATURED_WEBSITE_URL
from .market_pricing import get_market_pricing
from . import report_access
from .image_report import render_report_jpg
from .image_cache import ImageQueueBusy, report_images
from .probe import probe_model_alive, probe_relay
from .public_rankings import (
    BLACK_RANKING,
    EXCLUDED_RANKING_DOMAINS,
    RED_RANKING,
    UPDATED_AT,
    PublicRankingSite,
)
from .ratelimit import check_rate
from .security import (
    MAX_API_KEY_LENGTH,
    MAX_MODEL_LENGTH,
    TargetValidationError,
    insecure_api_allowed,
    validate_target_url,
)


HERE = Path(__file__).resolve().parent
TEMPLATE_DIR = HERE / "templates"
STATIC_DIR = HERE / "static"

logger = logging.getLogger("gewu")
logger.setLevel(logging.INFO)

_MAX_API_REQUEST_BODY_BYTES = 16 * 1024


class _RequestBodyTooLarge(Exception):
    pass


class DeploymentAdmissionMiddleware:
    """Cover validation/preflight as well as enqueue; release after the response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = str(scope.get("path", ""))
        if scope["type"] != "http" or scope.get("method") != "POST" or not (
            path.startswith("/api/detect") or path == "/api/probe"
        ):
            await self.app(scope, receive, send)
            return
        guard = deployment_gate.admission(jobs.JOBS_DIR)
        try:
            guard.__enter__()
        except deployment_gate.MaintenanceError:
            await JSONResponse(
                {"detail": "检测服务正在更新，暂不接受新检测，请稍后重试。已有检测继续运行。"},
                status_code=503, headers={"Retry-After": "15", "Cache-Control": "no-store"},
            )(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            guard.__exit__(None, None, None)


class RequestBodyLimitMiddleware:
    """Enforce transport and size limits before Starlette buffers API forms."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = str(scope.get("path", ""))
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or not path.startswith("/api/")
        ):
            await self.app(scope, receive, send)
            return

        sensitive_endpoint = (
            path == "/api/probe"
            or path == "/api/wishlist"
            or path.startswith("/api/detect")
            or path.startswith("/api/jobs/")
            or path.startswith("/api/status/")
        )
        if (
            sensitive_endpoint
            and scope.get("scheme") != "https"
            and not insecure_api_allowed()
        ):
            await JSONResponse(
                {
                    "detail": (
                        "当前入口未启用 HTTPS，为保护敏感信息已拒绝提交请求"
                    )
                },
                status_code=426,
                headers={"Cache-Control": "no-store"},
            )(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length")
        try:
            content_length = int(raw_length) if raw_length is not None else None
        except (TypeError, ValueError):
            content_length = None
        if content_length is not None and content_length > self.max_bytes:
            await Response(
                content="request body too large",
                status_code=413,
                media_type="text/plain",
            )(scope, receive, send)
            return

        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _RequestBodyTooLarge
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _RequestBodyTooLarge:
            if response_started:
                raise
            await Response(
                content="request body too large",
                status_code=413,
                media_type="text/plain",
            )(scope, receive, send)


@asynccontextmanager
async def lifespan(_app):
    jobs.startup()
    report_images.startup()
    try:
        yield
    finally:
        try:
            await jobs.shutdown()
        finally:
            await report_images.shutdown()


app = FastAPI(title=brand.english_name, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(DeploymentAdmissionMiddleware)
app.add_middleware(
    RequestBodyLimitMiddleware, max_bytes=_MAX_API_REQUEST_BODY_BYTES
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))
templates.env.globals["brand"] = brand
templates.env.globals["model_catalog"] = catalog_view
from relay_detector.wire_apis import WIRE_APIS
templates.env.globals["wire_apis"] = WIRE_APIS


_CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com",
    )
)


@app.middleware("http")
async def security_and_cache_headers(request: Request, call_next):
    """Apply browser security boundaries and prevent stale HTML.

    HTML pages reference versioned CSS/JS via ?v=N query strings, but the
    cache-bust only works if the browser refetches the HTML in the first place.
    Without an explicit Cache-Control, browsers apply a heuristic that can hold
    HTML for hours — making style/template iterations invisible to returning
    visitors. `no-cache` (NOT no-store) lets the browser keep a copy but
    forces revalidation against the server every time, so updates appear
    immediately while still serving 304s for unchanged pages.
    """
    initial_owner = None
    if request.method == "GET" and request.url.path in {"/", "/claude", "/openai", "/gemini"}:
        if not report_access.valid_owner(_owner_cookie(request)):
            initial_owner = secrets.token_urlsafe(32)
    response = await call_next(request)
    if initial_owner:
        _set_owner_cookie(response, request, initial_owner)
        response.headers["Cache-Control"] = "no-store"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"
    )
    response.headers.setdefault("Content-Security-Policy", _CONTENT_SECURITY_POLICY)
    if brand.site_url.startswith("https://"):
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    ctype = response.headers.get("content-type", "")
    report_route = request.url.path.startswith(("/r/", "/api/status/", "/api/result/"))
    if report_route:
        # Authenticated reports and revoked shares must never be served from a
        # browser/CDN cache, including errors. Explicit public reports may index.
        response.headers["Cache-Control"] = "no-store"
        response.headers.setdefault("X-Robots-Tag", "noindex, nofollow, noarchive")
    elif ctype.startswith("text/html"):
        response.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
    elif request.method == "POST" and request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


_VALID_MODES = {"quick", "standard", "full"}
_VALID_WISHLIST_PROTOCOLS = {"openai", "gemini"}
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
WISHLIST_PATH = Path(
    os.environ.get("GEWU_WISHLIST_PATH")
    or "/opt/gewu-detector/web_data/wishlist.txt"
)


def _protocol_from_model(model: str) -> str:
    return model_protocol(model) or "openai"


def _model_choices() -> list[dict[str, str]]:
    """Current public Claude lineup; free-form legacy IDs remain accepted."""
    suggestions = catalog_choices("anthropic")
    return [{"id": s, "label": s} for s in suggestions]


def _openai_model_choices() -> list[dict[str, str]]:
    from relay_detector.protocols.openai import model_choices

    return [{"id": s, "label": s} for s in model_choices()]


def _gemini_model_choices() -> list[dict[str, str]]:
    return next(v["models"] for v in catalog_view()["vendors"] if v["id"] == "google")


_PUBLIC_RANKINGS_TTL_S = 60.0
_public_rankings_cached_at = 0.0
_public_rankings_cache: dict[str, object] | None = None
_public_detail_cache: dict[
    str, tuple[float, tuple[leaderboard.RelayStats, list[leaderboard.JobEntry]] | None]
] = {}
_RED_SCORE_THRESHOLD = 70


def _compute_public_ranking_snapshot() -> dict[str, object]:
    """Only approved reports may claim first-party provenance."""
    sites = {
        site.domain: site
        for site in (*RED_RANKING, *BLACK_RANKING)
        if site.domain.lower() not in EXCLUDED_RANKING_DOMAINS
        and site.source_kind == "external_snapshot"
    }
    latest = UPDATED_AT
    relays, _summary = leaderboard.aggregate(max_age_days=30)
    historical_relays, _ = leaderboard.aggregate()
    recent_domains = {relay.domain for relay in relays}
    relays = [*relays, *(r for r in historical_relays if r.domain not in recent_domains)]
    for relay in relays:
        if (
            not relay.domain
            or relay.domain.lower() in EXCLUDED_RANKING_DOMAINS
        ):
            continue
        current = sites.get(relay.domain)
        local_checked = (
            relay.last_checked.date().isoformat()
            if relay.last_checked
            else UPDATED_AT
        )
        latest = max(latest, local_checked)
        local_protocols = tuple(sorted(relay.by_protocol.keys()))
        protocols = local_protocols
        source_kind = "gewu_test"
        if current is not None:
            use_local_score = local_checked >= current.last_checked
            if use_local_score:
                score = round(relay.overall_median)
                last_checked = local_checked
                report_count = relay.total_count
                protocols = local_protocols
                source_kind = "gewu_test"
            else:
                score = current.score
                last_checked = current.last_checked
                report_count = current.report_count
                protocols = current.protocols
                source_kind = current.source_kind
        else:
            score = round(relay.overall_median)
            last_checked = local_checked
            report_count = relay.total_count
        sites[relay.domain] = PublicRankingSite(
            domain=relay.domain,
            score=max(0, min(100, score)),
            report_count=max(1, report_count),
            last_checked=last_checked,
            protocols=protocols,
            website_url=current.website_url if current is not None else None,
            source_kind=source_kind,
        )

    red_sites = tuple(sorted(
        (site for site in sites.values() if site.is_current and site.score >= _RED_SCORE_THRESHOLD),
        key=lambda site: (
            -site.score,
            -site.confidence_score,
            -site.report_count,
            site.domain,
        ),
    ))
    black_sites = tuple(sorted(
        (site for site in sites.values() if site.is_current and site.score < _RED_SCORE_THRESHOLD),
        key=lambda site: (site.score, -site.report_count, site.domain),
    ))
    total_reports = sum(site.report_count for site in sites.values())
    historical_sites = tuple(sorted(
        (site for site in sites.values() if not site.is_current),
        key=lambda site: (site.last_checked, site.domain), reverse=True,
    ))
    first_party_sites = tuple(site for site in sites.values() if site.source_kind == "gewu_test")
    external_sites = tuple(site for site in sites.values() if site.source_kind != "gewu_test")
    first_party_updated_at = max(
        (site.last_checked for site in first_party_sites), default="—"
    )
    metrics: dict[str, int | str] = {
        "site_count": len(sites),
        "report_count": total_reports,
        "red_count": len(red_sites),
        "black_count": len(black_sites),
        "current_count": len(red_sites) + len(black_sites),
        "historical_count": len(historical_sites),
        "site_count_label": f"{len(sites):,}",
        "report_count_label": f"{total_reports:,}",
        "updated_at": latest,
        "first_party_site_count": len(first_party_sites),
        "first_party_report_count": sum(site.report_count for site in first_party_sites),
        "first_party_updated_at": first_party_updated_at,
        "external_site_count": len(external_sites),
        "external_report_count": sum(site.report_count for site in external_sites),
        "external_updated_at": UPDATED_AT,
        "anthropic_site_count": sum(
            "anthropic" in site.protocols for site in sites.values()
        ),
        "openai_site_count": sum(
            "openai" in site.protocols for site in sites.values()
        ),
        "gemini_site_count": sum(
            "gemini" in site.protocols for site in sites.values()
        ),
    }
    return {
        "red_sites": red_sites,
        "black_sites": black_sites,
        "historical_sites": historical_sites,
        "metrics": metrics,
    }


def _public_ranking_snapshot() -> dict[str, object]:
    global _public_rankings_cached_at, _public_rankings_cache
    now = time.monotonic()
    if (
        _public_rankings_cache is None
        or now - _public_rankings_cached_at >= _PUBLIC_RANKINGS_TTL_S
    ):
        _public_rankings_cache = _compute_public_ranking_snapshot()
        _public_rankings_cached_at = now
    return _public_rankings_cache


def _homepage_metrics() -> dict[str, int | str]:
    return _public_ranking_snapshot()["metrics"]  # type: ignore[return-value]


def _public_ranking_detail(
    domain: str,
) -> tuple[leaderboard.RelayStats, list[leaderboard.JobEntry]] | None:
    """Cache per-domain report scans to keep crawler traffic from amplifying I/O."""
    now = time.monotonic()
    cached = _public_detail_cache.get(domain)
    if cached is not None and now - cached[0] < _PUBLIC_RANKINGS_TTL_S:
        return cached[1]
    detail = leaderboard.aggregate_one(domain)
    if len(_public_detail_cache) >= 128:
        _public_detail_cache.clear()
    _public_detail_cache[domain] = (now, detail)
    return detail


@app.get("/", response_class=HTMLResponse)
async def hub(request: Request) -> HTMLResponse:
    snapshot = _public_ranking_snapshot()
    all_sites = (*snapshot["red_sites"], *snapshot["black_sites"], *snapshot.get("historical_sites", ()))
    return templates.TemplateResponse(
        request,
        "hub.html",
        {
            "coverage": _homepage_metrics(),
            "ranking_sites": snapshot["red_sites"][:6],
            "all_ranking_sites": all_sites,
            "quick_models": {
                "claude": _model_choices(),
                "openai": _openai_model_choices(),
                "gemini": _gemini_model_choices(),
            },
        },
    )


@app.get("/claude", response_class=HTMLResponse)
async def claude_index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request, "index.html",
        {"models": _model_choices()},
    )


@app.get("/openai", response_class=HTMLResponse)
async def openai_index(request: Request) -> HTMLResponse:
    vendors = [v for v in catalog_view()["vendors"] if v["route"] == "openai"]
    chosen = request.query_params.get("vendor") or model_vendor(request.query_params.get("model") or "gpt-")
    vendor = next((v for v in vendors if v["id"] == chosen), vendors[0])
    return templates.TemplateResponse(
        request,
        "openai.html",
        {"models": vendor["models"], "vendors": vendors, "vendor": vendor},
    )


@app.get("/leaderboard/models", response_class=HTMLResponse)
async def models_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "models.html", {"catalog": catalog_view()})


@app.get("/leaderboard/sources", response_class=HTMLResponse)
async def sources_page(request: Request) -> HTMLResponse:
    from .provider_status import SOURCES, HUB_URL
    from relay_detector.baselines import baseline_inventory
    return templates.TemplateResponse(request, "sources.html", {
        "catalog": catalog_view(), "sources": SOURCES, "hub_url": HUB_URL,
        "baselines": await run_in_threadpool(baseline_inventory),
    })


@app.get("/api/status/provider-status")
async def provider_status_api() -> JSONResponse:
    from .provider_status import cached_status
    return JSONResponse(await run_in_threadpool(cached_status), headers={"Cache-Control": "no-store"})


@app.get("/api/status/detection-scope")
async def detection_scope_api(
    protocol: Literal["anthropic", "openai", "gemini"],
    model: str = Query(min_length=1, max_length=128),
    mode: Literal["quick", "standard", "full"] = "full",
    wire_api: str | None = Query(default=None, max_length=32),
    include_long_context: bool = False,
    include_long_context_extreme: bool = False,
) -> JSONResponse:
    from .detection_scope import detection_scope
    try:
        result = await run_in_threadpool(detection_scope, protocol, model, mode, wire_api,
                                        include_long_context, include_long_context_extreme)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.get("/gemini", response_class=HTMLResponse)
async def gemini_index(request: Request) -> HTMLResponse:
    from relay_detector.wire_apis import WIRE_APIS, capability_notes
    return templates.TemplateResponse(
        request,
        "gemini.html",
        {"models": _gemini_model_choices(), "gemini_apis": {key: value for key, value in WIRE_APIS.items() if "gemini" in value["protocols"]},
         "native_scope": " ".join(capability_notes("interactions")[1:])},
    )


@app.get("/leaderboard", response_class=HTMLResponse)
async def leaderboard_page(request: Request) -> HTMLResponse:
    """Render the public quality ranking and risk watchlist."""
    snapshot = _public_ranking_snapshot()
    metrics = snapshot["metrics"]
    return templates.TemplateResponse(
        request,
        "leaderboard.html",
        {
            "red_sites": snapshot["red_sites"],
            "black_sites": snapshot["black_sites"],
            "historical_sites": snapshot.get("historical_sites", ()),
            "coverage": metrics,
            "updated_at": metrics["updated_at"],
            "featured_domain": FEATURED_DOMAIN,
            "featured_website_url": FEATURED_WEBSITE_URL,
        },
    )


@app.get("/pricing", response_class=HTMLResponse)
async def pricing_page(request: Request) -> HTMLResponse:
    """Show disclosed commercial data without mixing it into quality scores."""
    return templates.TemplateResponse(
        request,
        "pricing.html",
        {
            "pricing": await get_market_pricing(),
        },
    )


@app.get("/ranking-governance", response_class=HTMLResponse)
async def ranking_governance_page(request: Request) -> HTMLResponse:
    """Explain ranking eligibility, review and no-cost appeal rules."""
    return templates.TemplateResponse(request, "ranking_governance.html", {})


@app.get("/leaderboard/compare", response_class=HTMLResponse)
async def compare_page(request: Request) -> HTMLResponse:
    """Compare up to three validated public ranking entries."""
    requested = request.query_params.get("domains", "")[:1024].split(",")
    snapshot = _public_ranking_snapshot()
    site_by_domain = {
        site.domain: site
        for site in (*snapshot["red_sites"], *snapshot["black_sites"], *snapshot.get("historical_sites", ()))
    }
    selected: list[PublicRankingSite] = []
    seen: set[str] = set()
    for raw_domain in requested:
        domain = raw_domain.strip().lower()
        if domain in seen or not leaderboard.is_valid_domain(domain):
            continue
        site = site_by_domain.get(domain)
        if site is not None:
            selected.append(site)
            seen.add(domain)
        if len(selected) == 3:
            break
    return templates.TemplateResponse(
        request,
        "compare.html",
        {"sites": selected},
    )


_monitor_cached_at = 0.0
_monitor_cache: dict | None = None


@app.get("/leaderboard/monitor", response_class=HTMLResponse)
async def monitor_page(request: Request) -> HTMLResponse:
    """Browse evidence by model/observed endpoint without triggering detection."""
    global _monitor_cached_at, _monitor_cache
    now = time.monotonic()
    if _monitor_cache is None or now - _monitor_cached_at >= _PUBLIC_RANKINGS_TTL_S:
        _monitor_cache = monitoring_snapshot()
        _monitor_cached_at = now
    health = await run_in_threadpool(cached_monitor_health, jobs.JOBS_DIR)
    return templates.TemplateResponse(request, "monitor.html", {
        **_monitor_cache, "monitor_health": health["summary"], "health_available": health["available"],
    })


@app.get("/leaderboard/{domain}", response_class=HTMLResponse)
async def leaderboard_domain_page(request: Request, domain: str) -> HTMLResponse:
    """Render a safe decision page for every domain in the public ranking."""
    domain = domain.strip().lower()
    if not leaderboard.is_valid_domain(domain):
        raise HTTPException(status_code=404, detail="relay not found")

    snapshot = _public_ranking_snapshot()
    sites = (*snapshot["red_sites"], *snapshot["black_sites"], *snapshot.get("historical_sites", ()))
    site = next((candidate for candidate in sites if candidate.domain == domain), None)
    if site is None:
        raise HTTPException(status_code=404, detail="relay not found")

    local = _public_ranking_detail(domain)
    relay = local[0] if local else None
    history = local[1] if local else []
    failed_summary: list[tuple[str, int]] = []
    if relay is not None:
        failed_counts: dict[str, int] = {}
        for protocol in relay.by_protocol.values():
            for name, count in protocol.failed_detectors.items():
                failed_counts[name] = failed_counts.get(name, 0) + count
        failed_summary = sorted(
            failed_counts.items(), key=lambda item: (-item[1], item[0])
        )[:8]

    return templates.TemplateResponse(
        request,
        "leaderboard_detail.html",
        {
            "site": site,
            "relay": relay,
            "history": history,
            "failed_summary": failed_summary,
            "protocol_labels": leaderboard.PROTOCOL_LABELS,
            "verdict_labels": leaderboard.VERDICT_LABELS,
        },
    )




@app.get("/faq", response_class=HTMLResponse)
async def faq_index(request: Request) -> HTMLResponse:
    """Standalone FAQ page — single source of truth in faq_data.py drives
    both the rendered HTML and the FAQPage JSON-LD schema in <head>."""
    return templates.TemplateResponse(
        request,
        "faq.html",
        {
            "categories": FAQ_CATEGORIES,
            "total_count": total_question_count(),
            "jsonld": json.dumps(faqpage_jsonld(), ensure_ascii=False),
        },
    )


@app.post("/api/wishlist")
async def api_wishlist(
    request: Request,
    email: str = Form(...),
    protocol: str = Form(...),
) -> JSONResponse:
    email = email.strip()
    protocol = protocol.strip().lower()
    _enforce_rate_limit(
        request,
        scope="wishlist",
        limit=_WISHLIST_RATE_LIMIT,
        window_s=_WISHLIST_RATE_WINDOW_S,
    )
    if protocol not in _VALID_WISHLIST_PROTOCOLS:
        raise HTTPException(status_code=400, detail="unsupported protocol")
    if len(email) > 320 or not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="email looks invalid")

    WISHLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {"ts": int(time.time()), "protocol": protocol, "email": email},
        ensure_ascii=False,
    )
    with WISHLIST_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return JSONResponse({"ok": True})


def _client_ip(request: Request) -> str:
    """Resolve the originating client IP.

    Uvicorn only trusts the explicitly configured local reverse proxy, so a
    public client cannot forge X-Forwarded-For to evade rate limits. Fall back
    to "unknown" if the request somehow lacks a client.
    """
    return request.client.host if request.client else "unknown"


# Probe is cheap (one upstream GET) but accepts arbitrary base_url + api_key,
# making it a tempting key-scanning oracle. 15/min/IP is generous enough for
# a real user editing/correcting fields and tight enough to slow scanners.
# Preflight (per-model alive check) shares the same bucket — both are "fan
# one cheap upstream call out from this proxy" operations.
_PROBE_RATE_LIMIT = 15
_PROBE_RATE_WINDOW_S = 60.0
_DETECT_RATE_LIMIT = 6
_DETECT_RATE_WINDOW_S = 60.0
_WISHLIST_RATE_LIMIT = 5
_WISHLIST_RATE_WINDOW_S = 3600.0


def _enforce_rate_limit(
    request: Request,
    *,
    scope: str,
    limit: int,
    window_s: float,
) -> None:
    ip = _client_ip(request)
    allowed, retry_after = check_rate(
        f"{scope}:{ip}", limit=limit, window_s=window_s
    )
    if not allowed:
        wait = int(retry_after) + 1
        raise HTTPException(
            status_code=429,
            detail="请求过于频繁，请稍后重试",
            headers={"Retry-After": str(wait)},
        )


async def _validated_target_or_400(base_url: str) -> str:
    try:
        return await validate_target_url(base_url)
    except TargetValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _validated_api_key_or_400(api_key: str) -> str:
    cleaned = api_key.strip()
    if (
        len(cleaned) < 8
        or len(cleaned) > MAX_API_KEY_LENGTH
        or any(ord(char) < 32 or ord(char) == 127 for char in cleaned)
    ):
        raise HTTPException(
            status_code=400,
            detail=f"api_key 长度必须在 8–{MAX_API_KEY_LENGTH} 个字符之间且不能包含控制字符",
        )
    return cleaned


def _validated_model_or_400(model: str) -> str:
    cleaned = model.strip()
    if (
        not cleaned
        or len(cleaned) > MAX_MODEL_LENGTH
        or any(ord(char) < 32 or ord(char) == 127 for char in cleaned)
    ):
        raise HTTPException(
            status_code=400,
            detail=f"model 长度必须在 1–{MAX_MODEL_LENGTH} 个字符之间且不能包含控制字符",
        )
    return cleaned


def _owner_cookie(request: Request) -> str:
    return request.cookies.get(report_access.cookie_name(request.url.scheme == "https"), "")


def _internal_authorized(request: Request) -> bool:
    expected = os.environ.get("GEWU_INTERNAL_API_TOKEN", "").strip()
    supplied = request.headers.get("X-Gewu-Internal-Token", "")
    return bool(expected and supplied and secrets.compare_digest(expected, supplied))


def _restricted(job_id: str, job) -> bool:
    return report_access.restricted(jobs.JOBS_DIR, job_id,
                                   version=getattr(job, "access_version", 0), report=job.report)


def _job_owner(request: Request, job_id: str) -> str:
    prefix = "__Host-" if request.url.scheme == "https" else ""
    for token in (_owner_cookie(request), request.cookies.get(f"{prefix}gewu_report_{job_id}", "")):
        if report_access.owned(jobs.JOBS_DIR, job_id, token):
            return token
    return ""


def _owned(request: Request, job_id: str) -> bool:
    return bool(_job_owner(request, job_id))


def _require_report_read(request: Request, job_id: str, job) -> None:
    if _restricted(job_id, job) and not (_owned(request, job_id) or _internal_authorized(request)):
        raise HTTPException(status_code=404, detail="报告不可用，请使用提交检测时的浏览器打开")


async def _submit_or_503(request: Request, *args, **kwargs) -> str:
    owner = _owner_cookie(request)
    if not report_access.valid_owner(owner):
        owner = secrets.token_urlsafe(32)
    if _internal_authorized(request):
        kwargs["account_owner_secret"] = os.environ["GEWU_INTERNAL_API_TOKEN"].strip()
        request.state.account_submission = True
    else:
        request.state.report_owner = owner
        kwargs["owner_token"] = owner
    try:
        return await jobs.submit(*args, **kwargs)
    except deployment_gate.MaintenanceError as exc:
        raise HTTPException(
            status_code=503,
            detail="检测服务正在更新，暂不接受新检测，请稍后重试。已有检测继续运行。",
            headers={"Retry-After": "15", "Cache-Control": "no-store"},
        ) from exc
    except jobs.JobQueueFull as exc:
        raise HTTPException(
            status_code=503,
            detail="当前检测任务较多，请稍后重试",
            headers={"Retry-After": "15"},
        ) from exc


def _set_owner_cookie(response: Response, request: Request, owner: str) -> None:
    secure = request.url.scheme == "https"
    response.set_cookie(report_access.cookie_name(secure), owner, httponly=True,
                        secure=secure, samesite="lax", max_age=report_access.COOKIE_AGE, path="/")


def _submission_response(request: Request, job_id: str, headers=None) -> JSONResponse:
    response = JSONResponse(
        {"job_id": job_id, "status_url": f"/api/status/{job_id}"},
        headers={**(headers or {}), "Cache-Control": "no-store"},
    )
    owner = getattr(request.state, "report_owner", "")
    if owner:
        # One cookie for the browser, not a growing cookie per report. Host-only
        # on HTTPS; never put the owner capability in a URL, JSON or JS storage.
        _set_owner_cookie(response, request, owner)
    elif not getattr(request.state, "account_submission", False):
        # Preserve old non-browser integrations which only issued cancellation
        # capabilities. New public submissions always take the owner path.
        token = jobs.issue_cancel_token(job_id)
        if token:
            response.set_cookie(f"gewu_cancel_{job_id}", token, httponly=True,
                                secure=request.url.scheme == "https", samesite="strict", max_age=7200)
    return response


async def _preflight_or_422(
    request: Request,
    base_url: str,
    api_key: str,
    model: str,
    protocol: str,
) -> None:
    """Run model-alive preflight; raise HTTPException 422 with structured
    detail if the model is dead so the frontend can offer a one-click swap
    to the protocol's recommended model.

    Honors the same per-IP probe rate limit. force=true on the request body
    skips preflight entirely (escape hatch when relays false-negative on
    our 4-token ping).
    """
    form = await request.form()
    if str(form.get("force") or "").lower() in ("1", "true", "yes"):
        return

    ip = _client_ip(request)
    allowed, retry_after = check_rate(
        f"probe:{ip}", limit=_PROBE_RATE_LIMIT, window_s=_PROBE_RATE_WINDOW_S
    )
    if not allowed:
        # Rate limited preflight — DON'T block submission. The detector
        # itself will surface the model_not_found if there is one; we just
        # skip the early-warning path until backoff expires.
        return

    alive, err = await probe_model_alive(base_url, api_key, model, protocol)
    if alive:
        return

    raise HTTPException(
        status_code=422,
        detail={
            "code": "model_not_alive",
            "message": (
                f"模型 {model} 在该中转站实际不可用。中转站把它列在 /v1/models "
                "里,但真实请求被上游拒绝。"
            ),
            "model": model,
            "protocol": protocol,
            "upstream_error": err or "",
        },
    )


@app.post("/api/probe")
async def api_probe(
    request: Request,
    base_url: str = Form(...),
    api_key: str = Form(...),
) -> JSONResponse:
    """Probe a relay's /v1/models for the form's pre-submit pill.

    Always returns 200 with a structured payload — the frontend renders any
    upstream error inline rather than as a fetch failure. Exception: a 429
    is returned (with Retry-After) when the per-IP rate limit is exhausted,
    so the browser can back off and the frontend can show a clear "too
    many probes" pill instead of a generic upstream error.
    """
    ip = _client_ip(request)
    allowed, retry_after = check_rate(
        f"probe:{ip}", limit=_PROBE_RATE_LIMIT, window_s=_PROBE_RATE_WINDOW_S
    )
    if not allowed:
        wait = int(retry_after) + 1
        return JSONResponse(
            {
                "ok": False,
                "auth_ok": True,
                "error": f"探测过于频繁,请在 {wait} 秒后再试",
                "rate_limited": True,
            },
            status_code=429,
            headers={"Retry-After": str(wait)},
        )

    try:
        base_url = await validate_target_url(base_url)
    except TargetValidationError as exc:
        return JSONResponse(
            {"ok": False, "error": str(exc)},
            status_code=200,
        )
    api_key = api_key.strip()
    if (
        len(api_key) < 8
        or len(api_key) > MAX_API_KEY_LENGTH
        or any(ord(char) < 32 or ord(char) == 127 for char in api_key)
    ):
        return JSONResponse(
            {"ok": False, "error": "api_key looks invalid"},
            status_code=200,
        )

    payload = await probe_relay(base_url, api_key)
    return JSONResponse(payload)


@app.post("/api/detect")
@app.post("/api/detect/claude")
async def api_detect_claude(
    request: Request,
    base_url: str = Form(...),
    api_key: str = Form(...),
    model: str = Form(...),
    mode: str = Form("full"),
    include_long_context: bool = Form(False),
    include_long_context_extreme: bool = Form(False),
) -> JSONResponse:
    base_url = await _validated_target_or_400(base_url)
    api_key = _validated_api_key_or_400(api_key)
    model = _validated_model_or_400(model)
    mode = mode.strip().lower()

    if mode not in _VALID_MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {_VALID_MODES}")
    _enforce_rate_limit(
        request,
        scope="detect",
        limit=_DETECT_RATE_LIMIT,
        window_s=_DETECT_RATE_WINDOW_S,
    )

    legacy_route = request.url.path == "/api/detect"
    legacy_headers = (
        {
            "Deprecation": "true",
            "Link": '</api/detect/claude>; rel="successor-version"',
        }
        if legacy_route
        else None
    )
    if legacy_route:
        inferred = _protocol_from_model(model)
        if inferred != "anthropic":
            await _preflight_or_422(request, base_url, api_key, model, inferred)
            job_id = await _submit_or_503(
                request, base_url, api_key, model, mode,
                protocol=inferred,
                include_long_context=include_long_context,
                include_long_context_extreme=include_long_context_extreme,
            )
            return _submission_response(request, job_id, legacy_headers)
    elif _protocol_from_model(model) == "gemini":
        raise HTTPException(
            status_code=400,
            detail="这是 Gemini 模型,请在 /gemini 页面提交检测。",
        )
    elif _protocol_from_model(model) == "openai":
        raise HTTPException(
            status_code=400,
            detail="这是 OpenAI 模型,请在 /openai 页面提交检测。",
        )

    await _preflight_or_422(request, base_url, api_key, model, "anthropic")
    job_id = await _submit_or_503(
        request, base_url, api_key, model, mode,
        protocol="anthropic",
        include_long_context=include_long_context,
        include_long_context_extreme=include_long_context_extreme,
    )
    # NOTE: never echo api_key back in the response
    return _submission_response(request, job_id, legacy_headers)


@app.post("/api/detect/openai")
async def api_detect_openai(
    request: Request,
    base_url: str = Form(...),
    api_key: str = Form(...),
    model: str = Form(...),
    mode: str = Form("standard"),
    include_long_context: bool = Form(False),
    include_long_context_extreme: bool = Form(False),
    wire_api: str = Form("chat_completions"),
) -> JSONResponse:
    base_url = await _validated_target_or_400(base_url)
    api_key = _validated_api_key_or_400(api_key)
    model = _validated_model_or_400(model)
    mode = mode.strip().lower()

    if mode not in _VALID_MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {_VALID_MODES}")
    if wire_api not in {"chat_completions", "responses"}:
        raise HTTPException(status_code=400, detail="请选择 Chat Completions 或 Responses 接口")
    if wire_api == "responses" and (include_long_context or include_long_context_extreme):
        raise HTTPException(status_code=400, detail="Responses 暂不提供长上下文检测，请关闭高级选项")
    _enforce_rate_limit(
        request,
        scope="detect",
        limit=_DETECT_RATE_LIMIT,
        window_s=_DETECT_RATE_WINDOW_S,
    )

    # Responses reuses its first core probe for access checks. Never send a
    # billable Chat Completions preflight for a different, selected endpoint.
    if wire_api == "chat_completions":
        await _preflight_or_422(request, base_url, api_key, model, "openai")
    job_id = await _submit_or_503(
        request, base_url, api_key, model, mode,
        protocol="openai",
        wire_api=wire_api,
        include_long_context=include_long_context,
        include_long_context_extreme=include_long_context_extreme,
    )
    return _submission_response(request, job_id)


@app.post("/api/detect/gemini")
async def api_detect_gemini(
    request: Request,
    base_url: str = Form(...),
    api_key: str = Form(...),
    model: str = Form(...),
    mode: str = Form("standard"),
    wire_api: str = Form("chat_completions"),
) -> JSONResponse:
    base_url = await _validated_target_or_400(base_url)
    api_key = _validated_api_key_or_400(api_key)
    model = _validated_model_or_400(model)
    mode = mode.strip().lower()

    from relay_detector.wire_apis import resolve_wire_api
    try:
        wire_api = resolve_wire_api("gemini", wire_api)
        if wire_api != "chat_completions":
            from relay_detector.protocols.gemini.native import model_id
            model_id(model)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    if mode not in _VALID_MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {_VALID_MODES}")
    _enforce_rate_limit(
        request,
        scope="detect",
        limit=_DETECT_RATE_LIMIT,
        window_s=_DETECT_RATE_WINDOW_S,
    )

    if wire_api == "chat_completions":
        await _preflight_or_422(request, base_url, api_key, model, "gemini")
    job_id = await _submit_or_503(
        request, base_url, api_key, model, mode, protocol="gemini", wire_api=wire_api
    )
    return _submission_response(request, job_id)


@app.get("/api/status/{job_id}")
async def api_status(request: Request, job_id: str) -> JSONResponse:
    j = await jobs.get(job_id)
    if j is None:
        raise HTTPException(status_code=404, detail="job not found")
    _require_report_read(request, job_id, j)
    payload = {
        "job_id": j.id,
        "protocol": j.protocol,
        "wire_api": j.wire_api,
        "status": j.status,
        "base_url": j.base_url,
        "target_model": j.target_model,
        "mode": j.mode,
        "created_at": j.created_at,
        "started_at": j.started_at,
        "finished_at": j.finished_at,
        "progress": j.progress,
    }
    if j.report is not None:
        report = j.report or {}
        assessment = assess_report(report)
        results = report.get("results")
        result_rows = results if isinstance(results, list) else []
        completed = sum(
            1
            for row in result_rows
            if isinstance(row, dict) and row.get("status") in {"pass", "fail"}
        )
        payload.update(
            {
                "result_url": f"/r/{j.id}",
                "image_url": f"/r/{j.id}.jpg",
                "total_score": (
                    float(report.get("total_score"))
                    if assessment["score_usable"] else None
                ),
                "verdict": str(report.get("verdict") or "failed") if assessment["score_usable"] else None,
                "assessment": assessment,
                "completed_checks": completed,
                "total_checks": len(result_rows),
            }
        )
    if j.status in jobs.TERMINAL_STATUSES:
        payload["feedback"] = job_feedback(j)
    if j.status in {"error", "cancelled", "interrupted"}:
        payload["error"] = j.error
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.post("/api/status/{job_id}/cancel")
@app.post("/api/jobs/{job_id}/cancel", include_in_schema=False)
async def cancel_job(request: Request, job_id: str) -> JSONResponse:
    job = await jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    expected = os.environ.get("GEWU_INTERNAL_API_TOKEN", "").strip()
    supplied = request.headers.get("X-Gewu-Internal-Token", "")
    internal = bool(expected and supplied and secrets.compare_digest(expected, supplied))
    if not internal:
        origin = request.headers.get("origin")
        if (origin and origin != f"{request.url.scheme}://{request.url.netloc}") or request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(status_code=403, detail="仅允许从原提交页面取消检测")
        if not (_owned(request, job_id) or jobs.can_cancel(job, request.cookies.get(f"gewu_cancel_{job_id}", ""))):
            raise HTTPException(status_code=403, detail="只有任务提交者可以取消检测")
    await jobs.cancel(job_id)
    return await api_status(request, job_id)


def _require_internal_result_access(request: Request) -> None:
    """Protect raw detector evidence when a shared production token is set."""
    expected = os.environ.get("GEWU_INTERNAL_API_TOKEN", "").strip()
    if not expected:
        return
    supplied = request.headers.get("X-Gewu-Internal-Token", "")
    if not supplied or not secrets.compare_digest(supplied, expected):
        # Avoid advertising that the private evidence endpoint exists.
        raise HTTPException(status_code=404, detail="result not found")


@app.get("/api/status/monitor-health/summary")
def api_monitor_health(request: Request) -> JSONResponse:
    # Fail closed even when no internal token has been configured. Never
    # accept credentials in a query string or expose target metadata publicly.
    if not os.environ.get("GEWU_INTERNAL_API_TOKEN", "").strip():
        raise HTTPException(status_code=404, detail="not found")
    _require_internal_result_access(request)
    return JSONResponse(cached_monitor_health(jobs.JOBS_DIR), headers={"Cache-Control": "no-store"})


@app.get("/api/result/{job_id}.json")
async def api_result_json(request: Request, job_id: str) -> JSONResponse:
    _require_internal_result_access(request)
    j = await jobs.get(job_id)
    if j is None or j.report is None:
        raise HTTPException(status_code=404, detail="result not ready")
    _require_report_read(request, job_id, j)
    report = dict(j.report)
    report.pop("api_key_masked", None)
    report["assessment"] = assess_report(report)
    return JSONResponse(report, headers={"Cache-Control": "no-store"})


# NOTE: declare .jpg route BEFORE the bare /r/{job_id} HTML route. Starlette
# path params match `[^/]+` greedily so `/r/{job_id}` would otherwise swallow
# `/r/foo.jpg` (job_id="foo.jpg") and shadow the image endpoint.
@app.get("/r/{job_id}.jpg")
async def result_jpg(request: Request, job_id: str) -> Response:
    j = await jobs.get(job_id)
    if j is None or j.report is None:
        raise HTTPException(status_code=404, detail="result not ready")

    _require_report_read(request, job_id, j)

    # Retain the current report format/cache key. Generation runs outside the
    # event loop, with a bounded queue and shared work for duplicate downloads.
    cache_path = jobs.image_path(job_id, j.protocol).with_suffix(".scope-v2.jpg")
    try:
        image_bytes = await report_images.get(cache_path, lambda: render_report_jpg(j.report))
    except ImageQueueBusy as exc:
        raise HTTPException(status_code=503, detail="报告图片正在生成，请稍后再下载；文字报告可继续查看。",
                            headers={"Retry-After": "3", "Cache-Control": "no-store"}) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="报告图片暂时无法生成，请稍后重试；文字报告仍可查看。",
                            headers={"Retry-After": "3", "Cache-Control": "no-store"}) from exc
    return Response(
        content=image_bytes,
        media_type="image/jpeg",
        headers={
            "Content-Disposition": f'inline; filename="gewu-{job_id}.jpg"',
            "Cache-Control": "public, max-age=86400",
        },
    )


_PROTOCOL_LABELS = {"anthropic": "Claude", "openai": "OpenAI", "gemini": "Gemini"}
_VERDICT_LABELS = {"passed": "通过", "marginal": "存在风险", "failed": "未达标"}


def _seo_meta_for_report(report: dict) -> dict[str, str]:
    """Compute SEO title + description from a finished report.

    Each `/r/{job_id}` is a permanent landing page; without per-report meta,
    every report shows the same generic description and Google can't tell
    them apart for long-tail "what does relay X look like" queries. With
    domain + score + verdict in the meta, each one becomes its own indexable
    page.
    """
    base_url = str(report.get("base_url") or "")
    domain = base_url
    if "://" in base_url:
        domain = base_url.split("://", 1)[1].split("/", 1)[0]
    domain = domain or "中转站"

    protocol = str(report.get("protocol") or "anthropic")
    proto_label = _PROTOCOL_LABELS.get(protocol, protocol)

    model = str(report.get("target_model") or "")
    assessment = assess_report(report)
    verdict_zh = assessment["headline"]
    score_label = f"{report['total_score']:.0f}/100" if assessment["score_usable"] else ""
    conclusion = f"{score_label} {verdict_zh}".strip()

    results = report.get("results") or []
    pass_count = sum(1 for r in results if isinstance(r, dict) and r.get("status") == "pass")
    fail_count = sum(1 for r in results if isinstance(r, dict) and r.get("status") == "fail")
    total = len(results)

    title = (
        f"{domain} {proto_label} 中转站检测:{conclusion} | 格物"
    )
    description = (
        f"对 {domain} 进行 {proto_label} 中转站检测的完整报告:"
        f"请求模型 {model},结论为「{conclusion}」。"
        f"{total} 项检测中 {pass_count} 项通过、{fail_count} 项未通过。"
        f"协议与能力证据不等于具体模型身份的证明。"
    )
    og_description = (
        f"{domain} 检测报告:{conclusion}({pass_count}/{total} 项通过)"
    )
    return {
        "seo_title": title[:155],
        "seo_description": description[:160],
        "seo_og_description": og_description[:155],
    }


@app.get("/r/{job_id}", response_class=HTMLResponse)
async def result_page(request: Request, job_id: str) -> HTMLResponse:
    j = await jobs.get(job_id)
    if j is None:
        raise HTTPException(status_code=404, detail="job not found")
    _require_report_read(request, job_id, j)
    private = _restricted(job_id, j)
    owner = _owned(request, job_id)
    if j.report is None:
        return templates.TemplateResponse(
            request, "running.html", {"job_id": job_id, "job": j,
                                     "can_cancel": owner or jobs.can_cancel(j, request.cookies.get(f"gewu_cancel_{job_id}", ""))},
            headers={"Cache-Control": "no-store"},
        )
    # Domain feeds the breadcrumb (首页 › 质量榜 › {domain} › 报告).
    # Goes through is_valid_domain so a malformed base_url doesn't produce
    # a broken /leaderboard/{garbage} link.
    base_url = str(j.report.get("base_url") or "")
    domain = leaderboard._extract_domain(base_url)  # noqa: SLF001
    if domain and not leaderboard.is_valid_domain(domain):
        domain = ""
    from relay_detector.baselines import official_comparison
    comparison = await run_in_threadpool(official_comparison, j.report)
    return templates.TemplateResponse(
        request, "result.html",
        {
            "job_id": job_id,
            "private_report": private,
            "report_owner": owner,
            "share_enabled": owner and report_access.enabled(jobs.JOBS_DIR, job_id),
            "report": j.report,
            "official_comparison": comparison,
            "assessment": assess_report(j.report),
            "rows": _result_rows(j.report),
            "report_notes": _report_notes(j.report),
            "ranking_approved": assess_ranking_eligibility(j.report)[0],
            "breadcrumb_domain": domain,
            **_seo_meta_for_report(j.report),
        },
        headers={"X-Robots-Tag": "index, follow"} if not private and assess_ranking_eligibility(j.report)[0] else {},
    )


def _require_share_change(request: Request, job_id: str) -> str:
    # A custom header blocks cross-site forms; Origin/fetch metadata also block
    # same-site sibling origins. No CORS is granted to third-party callers.
    origin = request.headers.get("origin")
    if (request.headers.get("X-Gewu-Action") != "report-sharing"
            or request.headers.get("sec-fetch-site") == "cross-site"
            or (origin is not None and origin != f"{request.url.scheme}://{request.url.netloc}")):
        raise HTTPException(status_code=403, detail="请在报告页面操作分享")
    if not _owned(request, job_id):
        raise HTTPException(status_code=404, detail="报告不可用")
    return _job_owner(request, job_id)


@app.post("/api/status/{job_id}/owner")
async def account_report_owner(request: Request, job_id: str) -> JSONResponse:
    if not _internal_authorized(request) or not jobs.is_valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="报告不可用")
    job = await jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="报告不可用")
    if not _restricted(job_id, job):
        return JSONResponse({"legacy": True}, headers={"Cache-Control": "no-store"})
    try:
        owner = report_access.account_grant(jobs.JOBS_DIR, job_id, os.environ["GEWU_INTERNAL_API_TOKEN"].strip())
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="报告不可用") from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="报告暂时不可用") from exc
    return JSONResponse({"owner": owner}, headers={"Cache-Control": "no-store"})


@app.post("/api/status/{job_id}/share")
async def share_report(request: Request, job_id: str) -> JSONResponse:
    if not jobs.is_valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="报告不可用")
    owner = _require_share_change(request, job_id)
    job = await jobs.get(job_id)
    if job is None or job.report is None or job.status not in jobs.TERMINAL_STATUSES:
        raise HTTPException(status_code=409, detail="检测结束后即可分享")
    try:
        token = report_access.enable(jobs.JOBS_DIR, job_id, owner)
    except (OSError, PermissionError) as exc:
        raise HTTPException(status_code=503, detail="暂时无法开启分享，请稍后重试") from exc
    return JSONResponse({"url": f"/r/{job_id}/s/{token}"}, headers={"Cache-Control": "no-store"})


@app.post("/api/status/{job_id}/share/revoke")
async def revoke_report_share(request: Request, job_id: str) -> JSONResponse:
    if not jobs.is_valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="报告不可用")
    owner = _require_share_change(request, job_id)
    try:
        report_access.revoke(jobs.JOBS_DIR, job_id, owner)
    except (OSError, PermissionError) as exc:
        raise HTTPException(status_code=503, detail="未能确认关闭分享，请稍后重试") from exc
    return JSONResponse({"shared": False}, headers={"Cache-Control": "no-store"})


async def _shared_job(job_id: str, token: str):
    if not jobs.is_valid_job_id(job_id) or not report_access.shared(jobs.JOBS_DIR, job_id, token):
        raise HTTPException(status_code=404, detail="分享链接不可用或已关闭")
    job = await jobs.get(job_id)
    if job is None or job.report is None:
        raise HTTPException(status_code=404, detail="分享链接不可用或已关闭")
    return job


@app.get("/r/{job_id}/s/{token}.jpg")
async def shared_jpg(job_id: str, token: str) -> Response:
    job = await _shared_job(job_id, token)
    safe = report_access.summary_report(job.report)
    assessment = assess_report(job.report)
    cache = jobs.image_path(job_id, job.protocol).with_suffix(".share-v1.jpg")
    try:
        content = await report_images.get(cache, lambda: render_report_jpg(safe, assessment=assessment))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="分享图片暂时无法生成，请稍后重试", headers={"Retry-After": "3"}) from exc
    # Generation yields to other requests: revocation may have happened while
    # the image was queued. Always recheck before delivering cached or new bytes.
    if not report_access.shared(jobs.JOBS_DIR, job_id, token):
        raise HTTPException(status_code=404, detail="分享链接不可用或已关闭")
    return Response(content=content, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/r/{job_id}/s/{token}", response_class=HTMLResponse)
async def shared_report(request: Request, job_id: str, token: str) -> HTMLResponse:
    job = await _shared_job(job_id, token)
    safe = report_access.summary_report(job.report)
    return templates.TemplateResponse(request, "shared_report.html", {
        "report": safe, "assessment": assess_report(job.report),
        "rows": [row for row in _result_rows(safe) if row["name"] in {item.get("name") for item in safe["results"]}],
        "share_path": f"/r/{job_id}/s/{token}",
    }, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive"})


@app.exception_handler(HTTPException)
async def report_access_error(request: Request, exc: HTTPException):
    if exc.status_code == 404 and request.url.path.startswith("/r/") and not request.url.path.endswith(".jpg"):
        return templates.TemplateResponse(request, "report_unavailable.html", {}, status_code=404,
                                          headers={"Cache-Control": "no-store"})
    from fastapi.exception_handlers import http_exception_handler
    return await http_exception_handler(request, exc)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"ok": True, "ts": time.time()})


@app.get("/readyz")
async def readyz() -> JSONResponse:
    """Report whether this process can accept jobs and persist reports."""
    jobs_dir = jobs.JOBS_DIR
    writable = (
        jobs_dir.is_dir()
        and os.access(jobs_dir, os.W_OK | os.X_OK)
    )
    return JSONResponse(
        {"ok": writable, "storage_writable": writable, "deployment": jobs.deployment_status()},
        status_code=200 if writable else 503,
        headers={"Cache-Control": "no-store"},
    )


# SEO + AI GEO surface — see docs/SEO_AI_GEO_PLAN.md §3.1.A/B/C. These three
# files MUST be served at site root (not under /static) for crawlers to find
# them by convention.
@app.get("/robots.txt")
async def robots_txt() -> Response:
    return Response(
        content=(STATIC_DIR / "robots.txt").read_text(encoding="utf-8").replace(
            "{{SITE_URL}}", brand.site_url
        ),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/llms.txt")
async def llms_txt() -> Response:
    return Response(
        content=(STATIC_DIR / "llms.txt").read_text(encoding="utf-8").replace(
            "{{SITE_URL}}", brand.site_url
        ),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# (loc, changefreq, priority, template_filename) — lastmod resolved at
# request time from the template file's mtime. /leaderboard is special:
# its content changes whenever a new report lands, so we override its
# lastmod with the most recent report timestamp.
_STATIC_SITEMAP_URLS = [
    ("/",            "weekly",  "1.0",  "hub.html"),
    ("/claude",      "weekly",  "0.9",  "index.html"),
    ("/openai",      "weekly",  "0.9",  "openai.html"),
    ("/gemini",      "weekly",  "0.9",  "gemini.html"),
    ("/leaderboard/models", "weekly", "0.8", "models.html"),
    ("/leaderboard/sources", "weekly", "0.7", "sources.html"),
    ("/leaderboard", "daily",   "0.85", "leaderboard.html"),
    ("/leaderboard/monitor", "daily", "0.85", "monitor.html"),
    ("/ranking-governance", "monthly", "0.65", "ranking_governance.html"),
    ("/pricing",     "daily",   "0.75", "pricing.html"),
    ("/faq",         "monthly", "0.8",  "faq.html"),
]

_SITEMAP_REPORT_DIRS = [
    jobs.JOBS_DIR / "anthropic",
    jobs.JOBS_DIR / "openai",
    jobs.JOBS_DIR / "gemini",
    jobs.JOBS_DIR,  # legacy top-level
]


def _template_lastmod(filename: str) -> str:
    """Date string from a template's mtime, or '' if missing/unreadable."""
    try:
        mtime = (TEMPLATE_DIR / filename).stat().st_mtime
    except OSError:
        return ""
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%d")


@app.get("/sitemap.xml")
async def sitemap_xml() -> Response:
    """Dynamic sitemap — static product pages + reports + per-domain pages.

    `lastmod` is included for every URL so search engines know when to
    revisit. Static pages use the underlying template's mtime (≈ deploy
    time); /leaderboard uses the most recent report timestamp because its
    content is data-driven.
    """
    # Aggregate once so /leaderboard's lastmod follows the latest report.
    relays, _ = leaderboard.aggregate()
    relay_last_checked = [r.last_checked for r in relays if r.last_checked]
    leaderboard_lastmod = (
        max(relay_last_checked).strftime("%Y-%m-%d")
        if relay_last_checked else ""
    )

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']

    for path, freq, prio, tpl in _STATIC_SITEMAP_URLS:
        loc = brand.url(path)
        if path == "/leaderboard":
            # Data-driven page: lastmod follows the data, not the template.
            lastmod = leaderboard_lastmod or _template_lastmod(tpl)
        else:
            lastmod = _template_lastmod(tpl)
        line = f"  <url><loc>{xml_escape(loc)}</loc>"
        if lastmod:
            line += f"<lastmod>{lastmod}</lastmod>"
        line += f"<changefreq>{freq}</changefreq><priority>{prio}</priority></url>"
        lines.append(line)

    seen: set[str] = set()
    for dir_path in _SITEMAP_REPORT_DIRS:
        if not dir_path.is_dir():
            continue
        for json_path in sorted(dir_path.glob("*.json")):
            job_id = json_path.stem
            if job_id in seen or not jobs.is_valid_job_id(job_id) or json_path.is_symlink():
                continue
            seen.add(job_id)
            try:
                report = json.loads(json_path.read_text(encoding="utf-8"))
                if not isinstance(report, dict) or not assess_ranking_eligibility(report)[0]:
                    continue
                if report_access.restricted(jobs.JOBS_DIR, job_id, report=report):
                    continue
                lastmod = datetime.fromtimestamp(
                    json_path.stat().st_mtime, tz=timezone.utc
                ).strftime("%Y-%m-%d")
            except (OSError, ValueError, UnicodeError):
                continue
            lines.append(
                f"  <url><loc>{xml_escape(brand.url(f'/r/{job_id}'))}</loc>"
                f"<lastmod>{lastmod}</lastmod>"
                f"<changefreq>monthly</changefreq>"
                f"<priority>0.6</priority></url>"
            )

    lines.append("</urlset>\n")
    return Response(
        content="\n".join(lines),
        media_type="application/xml; charset=utf-8",
        headers={"Cache-Control": "public, max-age=600"},
    )


# ----- helpers shared with templates -----


_DETECTOR_DISPLAY = {
    "anthropic": [
        ("identity", "身份一致性"),
        ("behavioral_signature", "行为签名验证"),
        ("thinking_signature", "思维签名验证"),
        ("consistency", "模型一致性"),
        ("knowledge", "知识准确度"),
        ("pdf", "PDF 文档识别"),
        ("structured_output", "结构化输出"),
        ("protocol", "协议规范性"),
        ("integrity", "响应完整性"),
        ("token_usage", "Token 用量"),
        ("message_id", "消息标识规范"),
        ("long_context", "长上下文真实性"),
    ],
    "openai": [
        ("basic_request", "基础请求"),
        ("model_consistency", "模型一致性"),
        ("function_calling", "函数调用"),
        ("structured_output", "结构化输出"),
        ("protocol", "协议规范性"),
        ("integrity", "流式一致性"),
        ("token_billing", "Token 计费"),
        ("long_context", "长上下文真实性"),
    ],
    "gemini": [
        ("basic_request", "基础请求"),
        ("model_info", "模型响应形状"),
        ("function_calling", "函数调用"),
        ("structured_output", "结构化输出"),
        ("protocol", "协议规范性"),
        ("integrity", "流式一致性"),
        ("token_usage", "Token 用量"),
    ],
}


def _result_rows(report: dict) -> list[dict]:
    """Flatten results into the order/labels the result template expects."""
    by_name = {
        r.get("name"): r for r in report.get("results") or []
        if isinstance(r, dict)
    }
    out = []
    protocol = str(report.get("protocol") or "anthropic")
    display = _DETECTOR_DISPLAY.get(protocol, _DETECTOR_DISPLAY["anthropic"])
    responses = report.get("wire_api") in {"responses", "interactions", "generate_content"}
    if responses:
        prefix = "responses" if report.get("wire_api") == "responses" else "gemini"
        display = [("basic_request", "基础回复"), (prefix + "_stream", "流式完整性"),
                   (prefix + "_schema", "结构化输出"), (prefix + "_tools", "工具调用往返")]
    for name, label in display:
        r = by_name.get(name) or {"status": "skip", "score": 0.0}
        status = str(r.get("status") or "skip")
        score = float(r.get("score") or 0.0)
        if status == "pass":
            label_short, css = "通过", "ok"
        elif responses and status == "skip":
            reason = str((r.get("details") or {}).get("skip_reason") or "")
            label_short, css = ("未开放 / 未验证" if "未开放" in reason else "未测试"), "muted"
        elif responses and status == "error":
            label_short, css = "证据不足", "warn"
        elif status == "skip" and name == "long_context":
            # long_context is opt-in. Skip can mean "user didn't check the
            # box", "model context too small", or "all tiers rate-limited".
            # The detail's summary clarifies which; the badge stays neutral.
            label_short, css = "未启用", "muted"
        elif status == "skip" and name in {"token_billing", "token_usage"}:
            label_short, css = "无法判断", "muted"
        elif status == "skip":
            label_short, css = "跳过", "muted"
        elif status == "error":
            label_short, css = "执行错误", "warn"
        elif score >= 70:
            label_short, css = "警告", "warn"
        else:
            label_short, css = "未通过", "fail"
        if report.get("scoring_version") == "evidence-v2" and r.get("evidence_role") == "observation":
            label = r.get("display_name") or label
            if status not in {"skip", "error"}:
                label_short, css = "仅观察 · 不计分", "muted"
        out.append({
            "name": name,
            "label": label,
            "status": status,
            "label_short": label_short,
            "css": css,
            "score": score,
        })
    return out


def _report_notes(report: dict) -> list[dict[str, str]]:
    """Human-readable report notes for the result page.

    These are deliberately plain Chinese explanations. The raw detector JSON
    is useful for debugging, but public reports need to say what happened in
    terms a non-implementer can act on.
    """
    protocol = str(report.get("protocol") or "anthropic")
    if report.get("wire_api") in {"responses", "interactions", "generate_content"}:
        from relay_detector.wire_apis import capability_notes
        notes = [{"title": WIRE_APIS[report["wire_api"]]["label"] + " 检测范围", "body": " ".join(capability_notes(report["wire_api"]))}]
        for row in report.get("results") or []:
            if row.get("status") == "pass":
                continue
            reason = str(row.get("error") or (row.get("details") or {}).get("skip_reason") or "本次响应没有满足该能力探针的预期，请结合脱敏证据复核。")
            reason = {"mode-excluded": "本次检测深度未包含此项目，未验证这项能力。", "authentication-blocked": "鉴权失败后停止后续请求，此项目未测试。"}.get(reason, reason)
            notes.append({"title": row.get("display_name", "检测项目"), "body": reason[:400]})
        return notes
    if protocol == "gemini":
        return _gemini_report_notes(report)
    if protocol == "anthropic":
        return _anthropic_report_notes(report)
    if protocol != "openai":
        return []

    results = {
        r.get("name"): r for r in report.get("results") or []
        if isinstance(r, dict)
    }
    notes: list[dict[str, str]] = []

    structured = results.get("structured_output") or {}
    sd = structured.get("details") if isinstance(structured.get("details"), dict) else {}
    if structured.get("status") == "fail":
        text = str(sd.get("response_text") or "").strip().replace("\n", " ")
        if len(text) > 180:
            text = text[:180] + "..."
        # Two distinct failure modes — different actionable signals:
        # - Markdown-fenced JSON: relay forwarded response_format and the
        #   model attempted JSON, but produced a code-fenced block instead of
        #   raw JSON. Likely a model behavior / weak strict-mode honoring.
        # - No JSON at all: the response_format was probably stripped by the
        #   relay's adapter layer.
        markdown_seen = bool(sd.get("markdown_json_seen"))
        if markdown_seen:
            message = (
                "底层模型把 JSON 包在 Markdown 代码块里(```json ... ```),"
                "本次未满足 strict 模式的裸 JSON 要求。"
                "可能涉及模型能力或适配层处理，单凭这一项不能确认参数是否透传或后端模型身份。"
            )
        else:
            message = (
                "返回的不是 JSON 也没有代码块包装。请求已发送 "
                "response_format=json_schema strict=true，但本次返回未满足要求。"
                "建议核对模型是否支持该能力，并联系服务商复核适配层；不能据此断言模型被替换。"
            )
        if text:
            message += f" 实际返回片段: {text}"
        notes.append({
            "title": "结构化输出没有真正生效",
            "body": message,
        })

    protocol_result = results.get("protocol") or {}
    pd = (
        protocol_result.get("details")
        if isinstance(protocol_result.get("details"), dict)
        else {}
    )
    issue_codes: set[str] = set()
    for issue in pd.get("issues") or []:
        if isinstance(issue, dict) and isinstance(issue.get("code"), str):
            issue_codes.add(issue["code"])
    impersonation_codes = issue_codes & {
        "usage_contains_claude_fields",
        "usage_contains_gemini_fields",
        "usage_source_non_openai",
    }
    if impersonation_codes:
        # Adapter fields can be copied; they do not authenticate the backend.
        notes.append({
            "title": "响应字段存在协议差异",
            "body": (
                "响应的 usage 字段里出现了 Anthropic / Google 风格的字段(如 "
                "claude_cache_creation_*、gemini_* 或 usage_source 自报非 openai)。"
                "这些字段可能来自适配层或被复制，建议联系服务商核对转换逻辑。"
                "字段差异本身不能证明实际后端厂商或模型身份。"
            ),
        })
    elif "usage_mixed_token_fields" in issue_codes:
        # Lower-severity: just naming residue, may or may not mean translation.
        notes.append({
            "title": "响应里有适配层痕迹",
            "body": (
                "返回的 usage 同时含有 OpenAI 的 prompt_tokens/completion_tokens 和 "
                "Anthropic/Responses 风格的 input_tokens/output_tokens。"
                "通常说明中间有转换层,但还不足以确认换了后端。"
            ),
        })
    token_billing = results.get("token_billing") or {}
    td = (
        token_billing.get("details")
        if isinstance(token_billing.get("details"), dict)
        else {}
    )
    if token_billing:
        if token_billing.get("status") == "skip":
            notes.append({
                "title": "暂时无法判断 Token 是否虚报",
                "body": (
                    "接口没有给出足够完整的 Token 用量信息,所以这次不能确认它有没有多算。"
                ),
            })
        elif token_billing.get("status") == "fail":
            stream_only = td.get("non_stream_supported") is False
            notes.append({
                "title": (
                    "Token 统计自洽,但缺少交叉验证"
                    if stream_only
                    else "Token 计费存在风险"
                ),
                "body": (
                    "接口仅支持流式请求,现有 Token 数内部自洽,"
                    "但无法做独立的流式/非流式对照。"
                    if stream_only
                    else td.get("evaluation_zh") or (
                        "Token 统计有明显偏差,建议留意是否存在多算或统计错误。"
                    )
                ),
            })
        # Note: when token_billing passes, the green check in the detector
        # list already conveys this. We deliberately don't add a redundant
        # "Token 计费正常" note — report notes should only carry signal that
        # needs user attention.
    integrity = results.get("integrity") or {}
    idetails = (
        integrity.get("details")
        if isinstance(integrity.get("details"), dict)
        else {}
    )
    if integrity and integrity.get("status") == "fail":
        target_failed = (
            idetails.get("non_stream_target_match") is False
            or idetails.get("stream_target_match") is False
        )
        notes.append({
            "title": "目标响应不正确" if target_failed else "流式响应存在偏差",
            "body": (
                "stream 或 non-stream 没有正确返回指定标记,不能仅凭两次错误答案相同就判定一致。"
                if target_failed
                else "stream 与 non-stream 的结束原因或 usage 字段没有对齐。"
            ),
        })
    return notes


def _anthropic_report_notes(report: dict) -> list[dict[str, str]]:
    results = {
        r.get("name"): r for r in report.get("results") or []
        if isinstance(r, dict)
    }
    token_usage = results.get("token_usage") or {}
    td = (
        token_usage.get("details")
        if isinstance(token_usage.get("details"), dict)
        else {}
    )
    if not token_usage:
        return []
    if token_usage.get("status") == "skip":
        return [{
            "title": "暂时无法判断 Token 是否虚报",
            "body": "接口没有返回完整 usage 字段,所以这次不能确认它有没有多算。",
        }]
    if token_usage.get("status") == "fail":
        return [{
            "title": "Token 用量存在风险",
            "body": td.get("evaluation_zh") or (
                "usage 字段缺失或统计不自洽,建议不要直接依赖该中转站返回的 token 数做计费核算。"
            ),
        }]
    return []


def _gemini_report_notes(report: dict) -> list[dict[str, str]]:
    results = {
        r.get("name"): r for r in report.get("results") or []
        if isinstance(r, dict)
    }
    notes: list[dict[str, str]] = []

    structured = results.get("structured_output") or {}
    sd = structured.get("details") if isinstance(structured.get("details"), dict) else {}
    if structured.get("status") == "fail":
        notes.append({
            "title": "结构化输出没有真正生效",
            "body": sd.get("evaluation_zh") or (
                "请求已发送 OpenAI 兼容的 response_format=json_schema strict=true,"
                "但 Gemini 中转站返回内容无法按 schema 解析。"
            ),
        })

    token_usage = results.get("token_usage") or {}
    td = (
        token_usage.get("details")
        if isinstance(token_usage.get("details"), dict)
        else {}
    )
    if token_usage.get("status") == "fail":
        notes.append({
            "title": "Token 用量存在风险",
            "body": td.get("evaluation_zh") or (
                "usage 字段不完整或统计不自洽,建议不要直接依赖它做计费核算。"
            ),
        })

    integrity = results.get("integrity") or {}
    idetails = (
        integrity.get("details")
        if isinstance(integrity.get("details"), dict)
        else {}
    )
    if integrity.get("status") == "fail":
        notes.append({
            "title": "流式响应存在偏差",
            "body": idetails.get("evaluation_zh") or (
                "stream 与 non-stream 的文本、结束原因或 usage 字段没有对齐。"
            ),
        })

    if not notes and all(results.get(name, {}).get("status") == "pass" for name in (
        "basic_request", "model_info", "function_calling", "structured_output", "protocol", "integrity", "token_usage",
    )):
        notes.append({
            "title": "Gemini OpenAI 兼容协议表现良好",
            "body": (
                "基础请求、模型字段、tool 调用、结构化输出、流式响应和 Token 用量字段基本符合 "
                "OpenAI Chat Completions 规范。"
            ),
        })
    return notes

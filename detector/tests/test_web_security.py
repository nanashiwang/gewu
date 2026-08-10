"""Adversarial tests for the hosted web security boundary."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from web import security
from web.ratelimit import reset as reset_rate_limits


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    [
        "http://127.0.0.1:8000",
        "http://[::1]/v1",
        "http://10.0.0.1/v1",
        "http://172.16.0.1/v1",
        "http://192.168.1.1/v1",
        "http://169.254.169.254/latest/meta-data",
        "http://0.0.0.0",
        "http://localhost/v1",
        "http://service.internal/v1",
        "http://printer.local/v1",
    ],
)
async def test_private_and_metadata_targets_are_rejected(target: str):
    with pytest.raises(security.TargetValidationError):
        await security.validate_target_url(target)


@pytest.mark.asyncio
async def test_public_literal_target_is_accepted():
    assert await security.validate_target_url("https://1.1.1.1/v1/") == (
        "https://1.1.1.1/v1"
    )


@pytest.mark.asyncio
async def test_dns_rebinding_shape_with_any_private_answer_is_rejected(monkeypatch):
    async def mixed_answers(hostname: str, port: int) -> set[str]:
        assert hostname == "relay.example"
        assert port == 443
        return {"93.184.216.34", "127.0.0.1"}

    monkeypatch.setattr(security, "_resolve_addresses", mixed_answers)
    with pytest.raises(security.TargetValidationError, match="内网"):
        await security.validate_target_url("https://relay.example/v1")


@pytest.mark.asyncio
async def test_public_dns_answers_are_accepted(monkeypatch):
    async def public_answers(_hostname: str, _port: int) -> set[str]:
        return {"93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"}

    monkeypatch.setattr(security, "_resolve_addresses", public_answers)
    assert await security.validate_target_url("https://relay.example/v1/") == (
        "https://relay.example/v1"
    )


@pytest.mark.asyncio
async def test_private_target_requires_explicit_self_hosted_opt_in():
    assert await security.validate_target_url(
        "http://192.168.1.9:3000/v1/", allow_private=True
    ) == "http://192.168.1.9:3000/v1"


def test_gewu_private_target_setting_is_explicit(monkeypatch):
    monkeypatch.setenv("GEWU_ALLOW_PRIVATE_TARGETS", "0")
    assert security.private_targets_allowed() is False
    monkeypatch.setenv("GEWU_ALLOW_PRIVATE_TARGETS", "1")
    assert security.private_targets_allowed() is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    [
        "ftp://example.com/v1",
        "https://user:pass@example.com/v1",
        "https://example.com/v1?token=secret",
        "https://example.com/v1#fragment",
        "https://example.com:99999/v1",
        "https://example.com/a/../b",
        "https://example.com/v1\nX-Test: injected",
    ],
)
async def test_ambiguous_or_credential_bearing_urls_are_rejected(target: str):
    with pytest.raises(security.TargetValidationError):
        await security.validate_target_url(target, allow_private=True)


def test_recursive_secret_redaction_covers_values_and_keys():
    secret = "sk-reflected-secret-123"
    value = {
        "message": f"upstream echoed {secret}",
        f"header-{secret}": [secret, {"nested": f"Bearer {secret}"}],
    }
    redacted = security.redact_secret(value, secret)
    rendered = repr(redacted)
    assert secret not in rendered
    assert rendered.count(security.REDACTED) == 4


def test_handoff_script_never_persists_api_key():
    script = (Path(__file__).parents[1] / "web" / "static" / "app.js").read_text(
        encoding="utf-8"
    )
    assert "api_key: apiKeyInput" not in script
    assert "data.api_key" not in script
    assert "sessionStorage.setItem('gewu:handoff'" in script
    assert "apiKeyInput.disabled = true" in script
    assert "location.protocol === 'https:'" in script

    wishlist_template = (
        Path(__file__).parents[1] / "web" / "templates" / "coming_soon.html"
    ).read_text(encoding="utf-8")
    assert "email.disabled = true" in wishlist_template
    assert "location.protocol !== 'https:'" in wishlist_template


def test_security_headers_and_private_target_http_rejection():
    from web.server import app

    reset_rate_limits()
    client = TestClient(app)
    home = client.get("/")
    assert home.status_code == 200
    assert home.headers["x-frame-options"] == "DENY"
    assert home.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'none'" in home.headers["content-security-policy"]
    assert home.headers["referrer-policy"] == "no-referrer"

    response = client.post(
        "/api/detect/openai",
        data={
            "base_url": "http://169.254.169.254/latest/meta-data",
            "api_key": "sk-test-secret",
            "model": "gpt-test",
            "mode": "quick",
        },
    )
    assert response.status_code == 400
    assert "元数据" in response.json()["detail"] or "在线版" in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"


def test_public_plain_http_rejects_sensitive_forms_before_parsing(monkeypatch):
    from web.server import app

    with monkeypatch.context() as env:
        env.delenv("GEWU_ALLOW_INSECURE_API", raising=False)
        client = TestClient(app)
        response = client.post(
            "/api/detect/openai",
            data={
                "base_url": "https://relay.example/v1",
                "api_key": "sk-must-never-be-parsed",
                "model": "gpt-test",
                "mode": "quick",
            },
        )
        wishlist = client.post(
            "/api/wishlist",
            data={"email": "private@example.com", "protocol": "openai"},
        )

    assert response.status_code == 426
    assert response.headers["cache-control"] == "no-store"
    assert "HTTPS" in response.json()["detail"]
    assert "sk-must-never-be-parsed" not in response.text
    assert wishlist.status_code == 426
    assert wishlist.headers["cache-control"] == "no-store"
    assert "private@example.com" not in wishlist.text


def test_health_and_readiness_cover_process_and_report_storage(tmp_path, monkeypatch):
    from web import server

    monkeypatch.setattr(server.jobs, "JOBS_DIR", tmp_path)
    client = TestClient(server.app)

    health = client.get("/healthz")
    assert health.status_code == 200
    assert health.json()["ok"] is True

    ready = client.get("/readyz")
    assert ready.status_code == 200
    assert ready.json() == {"ok": True, "storage_writable": True}

    monkeypatch.setattr(server.jobs, "JOBS_DIR", tmp_path / "missing")
    not_ready = client.get("/readyz")
    assert not_ready.status_code == 503
    assert not_ready.json() == {"ok": False, "storage_writable": False}


def test_oversized_api_body_is_rejected_before_form_parsing():
    from web.server import _MAX_API_REQUEST_BODY_BYTES, app

    client = TestClient(app)
    response = client.post(
        "/api/probe",
        content=b"x" * (_MAX_API_REQUEST_BODY_BYTES + 1),
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"
    assert "too large" in response.text


def test_detect_rate_limit_cannot_be_bypassed_with_force(monkeypatch):
    from web import server

    reset_rate_limits()

    async def safe_target(value: str) -> str:
        return value

    async def alive(*_args, **_kwargs) -> None:
        return None

    counter = 0

    async def submit(*_args, **_kwargs) -> str:
        nonlocal counter
        counter += 1
        return f"jobid{counter:03d}"

    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "_preflight_or_422", alive)
    monkeypatch.setattr(server.jobs, "submit", submit)

    client = TestClient(server.app)
    payload = {
        "base_url": "https://relay.example/v1",
        "api_key": "sk-test-secret",
        "model": "gpt-test",
        "mode": "quick",
        "force": "1",
    }
    responses = [client.post("/api/detect/openai", data=payload) for _ in range(7)]
    assert [response.status_code for response in responses[:6]] == [200] * 6
    assert responses[6].status_code == 429
    assert counter == 6


def test_legacy_detect_route_returns_deprecation_headers(monkeypatch):
    from web import server

    reset_rate_limits()

    async def safe_target(value: str) -> str:
        return value

    async def alive(*_args, **_kwargs) -> None:
        return None

    async def submit(*_args, **_kwargs) -> str:
        return "legacyjob123"

    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "_preflight_or_422", alive)
    monkeypatch.setattr(server.jobs, "submit", submit)
    response = TestClient(server.app).post(
        "/api/detect",
        data={
            "base_url": "https://relay.example",
            "api_key": "sk-test-secret",
            "model": "claude-test",
            "mode": "quick",
        },
    )
    assert response.status_code == 200
    assert response.headers["deprecation"] == "true"
    assert "successor-version" in response.headers["link"]
    assert "sk-test-secret" not in response.text


def test_status_api_exposes_score_only_after_completion(monkeypatch):
    from web import jobs, server

    report = {
        "total_score": 91.2,
        "verdict": "passed",
        "results": [
            {"name": "basic_request", "status": "pass", "score": 100},
            {"name": "protocol", "status": "fail", "score": 70},
            {"name": "long_context", "status": "skip", "score": 0},
        ],
    }

    async def get_job(_job_id: str):
        return jobs.Job(id="scorejob123", status="done", report=report)

    monkeypatch.setattr(server.jobs, "get", get_job)
    response = TestClient(server.app).get("/api/status/scorejob123")
    payload = response.json()

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert payload["total_score"] == pytest.approx(91.2)
    assert payload["verdict"] == "passed"
    assert payload["completed_checks"] == 2
    assert payload["total_checks"] == 3
    assert payload["result_url"] == "/r/scorejob123"


def test_result_page_labels_score_as_quality_not_probability(monkeypatch):
    from web import jobs, server

    report = {
        "total_score": 91.0,
        "verdict": "passed",
        "protocol": "openai",
        "target_model": "gpt-test",
        "mode": "standard",
        "base_url": "https://relay.example/v1",
        "results": [],
        "performance": {},
    }

    async def get_job(_job_id: str):
        return jobs.Job(id="scorejob123", status="done", report=report)

    monkeypatch.setattr(server.jobs, "get", get_job)
    response = TestClient(server.app).get("/r/scorejob123")

    assert response.status_code == 200
    assert "91" in response.text
    assert "/100" in response.text
    assert "协议质量分,不是模型真伪概率" in response.text
    assert "不会自动参与公共榜单评分" in response.text
    assert "91%" not in response.text


def test_detection_frontend_uses_advisory_preflight_and_honest_model_wording():
    static_dir = Path(__file__).resolve().parents[1] / "web" / "static"
    script = (static_dir / "app.js").read_text(encoding="utf-8")

    assert "接口声明" in script
    assert "个候选" in script
    assert "继续完整检测并生成分数" in script
    assert "单次预检未通过,尚未生成检测分数" in script
    assert "该模型在中转站实际不可用" not in script
    assert "setTimeout(() => ctrl.abort(), 30000)" in script


def test_raw_result_json_requires_internal_token_and_omits_key_mask(monkeypatch):
    from web import jobs, server

    report = {
        "total_score": 91.0,
        "verdict": "marginal",
        "api_key_masked": "sk-partial...xy",
        "results": [{"name": "protocol", "status": "fail", "details": {}}],
    }

    async def get_job(_job_id: str):
        return jobs.Job(id="privatejob123", status="done", report=report)

    monkeypatch.setattr(server.jobs, "get", get_job)
    monkeypatch.setenv("GEWU_INTERNAL_API_TOKEN", "internal-test-token")
    client = TestClient(server.app)

    assert client.get("/api/result/privatejob123.json").status_code == 404
    assert client.get(
        "/api/result/privatejob123.json",
        headers={"X-Gewu-Internal-Token": "wrong-token"},
    ).status_code == 404

    response = client.get(
        "/api/result/privatejob123.json",
        headers={"X-Gewu-Internal-Token": "internal-test-token"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "api_key_masked" not in response.json()


def test_server_side_detector_client_sends_internal_token():
    source_path = (
        Path(__file__).resolve().parents[2] / "src" / "lib" / "relayDetection.ts"
    )
    if not source_path.is_file():
        pytest.skip("Next.js integration source is not part of standalone detector deploys")
    source = source_path.read_text(encoding="utf-8")
    assert "X-Gewu-Internal-Token" in source
    assert "process.env.GEWU_INTERNAL_API_TOKEN" in source

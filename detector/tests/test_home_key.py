"""Homepage Key handoff stays transient, same-origin and inference-free."""
from dataclasses import replace
from html.parser import HTMLParser
import json
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from relay_detector.model_catalog import catalog_view
from starlette.responses import Response
from web import server


PATH = "/api/status/prepare"
KEY = "sk-synthetic-home-key-not-a-real-secret"
VENDORS = catalog_view()["vendors"]


class Controls(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def by_id(self, element_id):
        return next(attrs for _, attrs in self.elements if attrs.get("id") == element_id)


@pytest.fixture(autouse=True)
def no_network_or_jobs(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Preparing a form must not resolve/probe an upstream or enqueue a job")

    for name in ("validate_target_url", "probe_relay", "probe_model_alive", "_submit_or_503"):
        monkeypatch.setattr(server, name, forbidden)
    monkeypatch.setitem(server.templates.env.globals, "brand",
                        replace(server.brand, analytics_id="G-SYNTHETIC-HOME"))


def data_for(vendor_entry=None, **overrides):
    vendor = vendor_entry or next(v for v in VENDORS if v["id"] == "openai")
    return {"vendor": vendor["id"], "model": vendor["models"][0]["id"] if vendor["models"] else "",
            "base_url": "https://relay.example/v1", "api_key": KEY, **overrides}


def post(data=None, *, headers=None, app=None):
    return TestClient(app or server.app, base_url="https://testserver").post(
        PATH, data=data if data is not None else data_for(),
        headers={"origin": "https://testserver", **(headers or {})}, follow_redirects=False)


def test_home_has_a_password_field_and_direct_detection_action():
    client = TestClient(server.app, base_url="https://testserver")
    client.get("/")  # The second request already has its owner cookie.
    response = client.get("/")
    controls = Controls(response.text)
    form = controls.by_id("quick-check")
    assert form["method"] == "post"
    assert form["action"] == "/api/detect/claude"
    assert "data-direct-detection" in form
    plan = json.loads(form["data-responses-plan"])
    assert plan["checks"]["full"] == 10 and plan["requests"]["full"] == 12
    assert any(tag == "option" and attrs.get("value") == "full" and "selected" in attrs for tag, attrs in controls.elements)
    assert "disabled" in controls.by_id("quick-start")
    assert '/static/home-detect.js?v=expanded-checks-1' in response.text
    key = controls.by_id("quick-api-key")
    assert key["type"] == "password" and key["name"] == "api_key"
    assert key["autocomplete"] == "new-password"
    assert key["maxlength"] == "4096" and "required" in key
    assert "value" not in key
    assert "直接进入检测进度与结果页" in response.text
    assert "首页不收集密钥" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert "googletagmanager.com" not in response.text


@pytest.mark.parametrize("vendor", VENDORS, ids=lambda v: v["id"])
def test_each_vendor_keeps_the_address_key_and_exact_model(vendor, caplog):
    data = data_for(vendor)
    response = post(data)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "noindex" in response.headers["x-robots-tag"]
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "location" not in response.headers and "set-cookie" not in response.headers
    controls = Controls(response.text)
    assert controls.by_id("detect-form")["data-endpoint"] == "/api/detect/" + vendor["route"]
    assert controls.by_id("detect-form")["data-prepared"] == "true"
    assert controls.by_id("api_key")["value"] == KEY
    assert controls.by_id("base_url")["value"] == data["base_url"]
    selected = [attrs["value"] for tag, attrs in controls.elements
                if tag == "option" and "selected" in attrs]
    assert data["model"] in selected
    if vendor["route"] == "openai":
        assert vendor["id"] in selected
    assert KEY not in str(response.url) and KEY not in str(response.headers)
    assert KEY not in caplog.text
    assert "googletagmanager.com" not in response.text
    assert "google-analytics.com" not in response.headers["content-security-policy"]


@pytest.mark.parametrize("path", ["/", "/claude", "/openai", "/gemini"])
def test_key_pages_are_not_cached_or_given_third_party_scripts(path):
    client = TestClient(server.app)
    client.get(path)
    response = client.get(path)
    assert response.headers["cache-control"] == "no-store"
    assert "googletagmanager.com/gtag" not in response.text
    assert "googletagmanager.com" not in response.headers["content-security-policy"]
    assert "google-analytics.com" not in response.headers["content-security-policy"]


def test_key_is_escaped_not_interpreted_as_html():
    key = 'sk-synthetic-"/><script>alert(1)</script>&'
    response = post(data_for(api_key=key))
    assert response.status_code == 200
    assert Controls(response.text).by_id("api_key")["value"] == key
    assert key not in response.text
    assert '<script>alert(1)</script>' not in response.text
    assert '&lt;script&gt;' in response.text


@pytest.mark.parametrize("updates", [
    {"api_key": ""}, {"api_key": "short"}, {"api_key": "sk-abc\nsecret"}, {"api_key": "s" * 4097},
    {"vendor": "unknown"}, {"model": ""}, {"model": "claude-fable-5-1"},
    {"model": '<script>alert(1)</script>'}, {"base_url": ""}, {"base_url": "javascript:alert(1)"},
    {"base_url": "https://user:password@relay.example/v1"},
    {"base_url": "https://relay.example/v1?api_key=synthetic"},
    {"base_url": "https://relay.example/v1#synthetic"},
    {"base_url": "https://relay.example:99999/v1"},
    {"base_url": "https://relay.example/\nx"}, {"base_url": "https://relay.example/" + "x" * 2048},
])
def test_bad_forms_never_echo_the_key(updates, caplog):
    response = post(data_for(**updates))
    assert response.status_code == 400
    assert response.headers["cache-control"] == "no-store"
    assert KEY not in response.text and KEY not in caplog.text
    assert "input" not in response.json()


@pytest.mark.parametrize("origin,fetch_site", [
    ("https://evil.example", "cross-site"), ("https://testserver.evil.example", "same-site"),
    ("https://sub.testserver", "same-site"), ("null", "same-site"), ("null", "cross-site"), ("null", "none"), ("https://testserver", "cross-site"),
])
def test_cross_origin_posts_are_rejected(origin, fetch_site):
    response = post(headers={"origin": origin, "sec-fetch-site": fetch_site})
    assert response.status_code == 403 and KEY not in response.text


def test_no_origin_is_rejected():
    response = TestClient(server.app, base_url="https://testserver").post(PATH, data=data_for())
    assert response.status_code == 403


def test_plain_http_is_rejected_before_reading_the_key(monkeypatch):
    monkeypatch.delenv("GEWU_ALLOW_INSECURE_API", raising=False)
    response = TestClient(server.app).post(PATH, data=data_for(), headers={"origin": "http://testserver"})
    assert response.status_code == 426
    assert response.headers["cache-control"] == "no-store"
    assert KEY not in response.text


def test_body_size_limit_also_applies_to_prepare():
    response = post(data_for(api_key="s" * 18000))
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"


def test_duplicate_and_unknown_fields_are_rejected():
    client = TestClient(server.app, base_url="https://testserver")
    for suffix in ("&api_key=second-secret", "&unexpected=value"):
        response = client.post(PATH, content=urlencode(data_for()) + suffix,
                               headers={"origin": "https://testserver", "content-type": "application/x-www-form-urlencoded"})
        assert response.status_code == 400
        assert KEY not in response.text and "second-secret" not in response.text


def test_json_or_file_uploads_are_not_accepted():
    response = TestClient(server.app, base_url="https://testserver").post(
        PATH, json=data_for(), headers={"origin": "https://testserver"})
    assert response.status_code == 415 and KEY not in response.text


def test_existing_shared_domain_route_is_sufficient():
    async def existing_proxy(scope, receive, send):
        if scope["path"].startswith("/api/status/"):
            await server.app(scope, receive, send)
        else:
            await Response(status_code=404)(scope, receive, send)

    assert post(app=existing_proxy).status_code == 200


def test_another_visit_does_not_get_the_previous_key():
    client = TestClient(server.app, base_url="https://testserver")
    assert client.post(PATH, data=data_for(), headers={"origin": "https://testserver"}).status_code == 200
    for route in ("/", "/claude", "/openai", "/gemini"):
        assert KEY not in client.get(route).text
    assert KEY not in str(client.cookies)


@pytest.mark.parametrize("origin", [None, "null"])
def test_same_origin_navigation_with_no_referrer_policy(origin):
    headers = {"sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate"}
    if origin is not None:
        headers["origin"] = origin
    response = TestClient(server.app, base_url="https://testserver").post(PATH, data=data_for(), headers=headers)
    assert response.status_code == 200
    assert Controls(response.text).by_id("api_key")["value"] == KEY

"""Adversarial coverage: catalogs must not silently change identity or score scope."""
from datetime import date
import importlib.util
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from relay_detector.model_catalog import VENDORS, catalog_view, choices, model_protocol, model_vendor
from relay_detector.core.models import Mode
from relay_detector.protocols.openai import build_config, build_detectors
from relay_detector.protocols.openai.client import OpenAIChatClient, _sanitize_body
from relay_detector.protocols.openai.runner import Runner
from relay_detector.protocols.anthropic.config import lookup_model
from relay_detector.protocols.anthropic.detectors.structured_output import StructuredOutputDetector
from web.server import app, _protocol_from_model


@pytest.mark.parametrize("vendor", VENDORS, ids=lambda v: v["id"])
def test_every_vendor_is_selectable_with_source_and_valid_chat_ids(vendor):
    page = TestClient(app).get("/leaderboard/models")
    assert page.status_code == 200
    assert vendor["source"] in page.text
    for model in vendor["models"]:
        assert model_vendor(model) == vendor["id"]
        assert model_protocol(model) == ("anthropic" if vendor["route"] == "claude" else vendor["route"])
        assert model in page.text
    form = TestClient(app).get(f'/{vendor["route"]}?vendor={vendor["id"]}').text
    assert f'value="{vendor["models"][0]}"' in form


def test_catalog_links_stay_inside_detector_proxy_namespace():
    client = TestClient(app)
    for path in ("/", "/claude", "/openai", "/gemini"):
        html = client.get(path).text
        assert 'href="/leaderboard/models"' in html
        assert 'href="/models"' not in html
    assert client.get("/models").status_code == 404
    assert "/leaderboard/models</loc>" in client.get("/sitemap.xml").text


def test_stale_catalog_exposes_review_warning_instead_of_claiming_latest():
    assert not catalog_view(date(2026, 10, 11))["stale"]
    assert catalog_view(date(2026, 11, 11))["stale"]


@pytest.mark.parametrize("model", ["gpt-image-2", "gemini-3.8-live", "grok-imagine-video", "qwen3.7-text-embedding", "gpt-6-pro", "gpt-5-codex", "gemini-3.8-flash-tts"])
def test_non_chat_models_are_never_suggested_for_chat_probe(model):
    assert model_protocol(model) is None


def test_prefixed_new_vendor_models_route_without_changing_id():
    assert _protocol_from_model("DeepSeek/deepseek-flash") == "openai"
    assert model_vendor("Alibaba/qwen3.8-max") == "qwen"
    assert _protocol_from_model("custom-future-model") == "openai"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6.1-sol"])
async def test_new_gpt_models_never_send_unsupported_chat_tool_calls(model):
    runner = Runner(None, build_detectors(), build_config(Mode.STANDARD))
    assert "function_calling" not in {d.name for d in runner._select_detectors(model)}
    sent = _sanitize_body({"model": model, "temperature": 0, "top_p": .5, "max_completion_tokens": 8})
    assert sent["model"] == model
    assert sent["reasoning_effort"] == "low"
    assert sent["max_completion_tokens"] >= 1024
    assert "temperature" not in sent and "top_p" not in sent


def test_gpt6_chat_tools_use_supported_reasoning_setting():
    assert _sanitize_body({"model": "gpt-6-luna"})["reasoning_effort"] == "none"
    runner = Runner(None, build_detectors(), build_config(Mode.STANDARD))
    assert "function_calling" in {d.name for d in runner._select_detectors("gpt-6-luna")}


def test_responses_request_never_receives_chat_only_reasoning_field():
    body = _sanitize_body({"model": "gpt-6-astra", "temperature": 0, "max_output_tokens": 100}, responses=True)
    assert body["reasoning"] == {"effort": "low"}
    assert "reasoning_effort" not in body
    assert body["max_output_tokens"] == 4096
    assert "max_completion_tokens" not in body and "max_tokens" not in body
    other = _sanitize_body({"model": "glm-5.3", "max_output_tokens": 100}, responses=True)
    assert "reasoning_effort" not in other
    assert "max_tokens" not in other


@pytest.mark.parametrize("model", ["deepseek-flash", "qwen3.8-max", "kimi-k3", "glm-5.3", "MiniMax-M3", "grok-4.7", "unknown-model"])
def test_generic_vendors_do_not_inherit_openai_fingerprint_or_billing_tests(model):
    runner = Runner(None, build_detectors(), build_config(Mode.STANDARD))
    assert {d.name for d in runner._select_detectors(model)} == {"basic_request", "integrity"}


@pytest.mark.asyncio
async def test_glm_v4_path_and_exact_model_survive_real_http_serialization():
    seen = []
    def handler(request):
        import json
        body = json.loads(request.content)
        seen.append((str(request.url), body))
        return httpx.Response(200, json={"choices": []})
    async with OpenAIChatClient("https://relay.example/api/paas/v4", "test-only", trust_env=False) as client:
        await client._client.aclose()
        client._client = httpx.AsyncClient(base_url=client.base_url, transport=httpx.MockTransport(handler))
        await client.chat_completions_create(model="ZAI/glm-5.3", max_completion_tokens=8, temperature=0, messages=[])
    url, body = seen[0]
    assert url == "https://relay.example/api/paas/v4/chat/completions"
    assert body["model"] == "ZAI/glm-5.3"
    assert body["reasoning_effort"] == "low"
    assert body["max_tokens"] >= 1024
    assert "max_completion_tokens" not in body and "temperature" not in body


@pytest.mark.asyncio
async def test_always_thinking_claude_does_not_fail_for_forced_tool_choice():
    for model in ["claude-fable-5-1", "claude-opus-5-5"]:
        result = await StructuredOutputDetector().run(None, model)
        assert result.status == "skip"
        assert "官方限制" in result.details["skip_reason"]
    assert lookup_model("claude-fable-5").alias == "claude-fable-5"
    assert lookup_model("claude-fable-5-1").alias == "claude-fable-5-1"
    assert lookup_model("claude-opus-5-5-20260922").alias == "claude-opus-5-5"
    assert lookup_model("claude-opus-5-500") is None


def test_audit_detects_new_and_removed_ids_but_ignores_embedded_scripts():
    path = Path(__file__).parents[1] / "scripts/check_model_catalog.py"
    spec = importlib.util.spec_from_file_location("catalog_audit", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.extract_ids('<p>gpt-6-astra</p><script>gpt-fake</script>', "openai") == ["gpt-6-astra"]
    assert module.compare_snapshot({"openai": {"ids": ["gpt-old"]}}, {"openai": {"ids": ["gpt-new"]}}) == {
        "openai": {"added": ["gpt-new"], "removed": ["gpt-old"]}}

"""Regression tests for the current public model catalog shown in the UI."""

from pathlib import Path
from fastapi.testclient import TestClient

from web.server import app, _model_choices


TEMPLATES = Path(__file__).parents[1] / "web" / "templates"


def test_claude_dropdown_is_current_public_lineup():
    assert [item["id"] for item in _model_choices()] == [
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
    ]


def test_frontend_offers_each_provider_catalog_without_auto_selection():
    expected = {
        "/claude": 'value="claude-fable-5-1"',
        "/openai": 'value="gpt-6-astra"',
        "/gemini": 'value="gemini-3.8-flash"',
    }
    for route, marker in expected.items():
        page = TestClient(app).get(route).text
        assert marker in page
        assert '<option value="" selected disabled>' in page


def test_openai_catalog_excludes_non_chat_specialized_variants():
    from relay_detector.protocols.openai import model_choices

    choices = model_choices()
    assert "gpt-5.4-pro" not in choices
    assert "gpt-5.5-pro" not in choices
    assert not any("codex" in model for model in choices)


def test_frontend_copy_does_not_recommend_shut_down_gemini_models():
    page = (TEMPLATES / "gemini.html").read_text(encoding="utf-8")
    assert "gemini-3-pro-preview" not in page
    assert "gemini-3.1-flash-lite-preview" not in page
    assert "gemini-3-flash-preview(2026 stable)" not in page

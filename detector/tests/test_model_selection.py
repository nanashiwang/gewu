"""The quick launcher and protocol forms use explicit model selection."""

from html.parser import HTMLParser

import pytest
from fastapi.testclient import TestClient

from web.server import app


class ModelControls(HTMLParser):
    def __init__(self):
        super().__init__()
        self.elements = []

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))


@pytest.mark.parametrize("route,control", [
    ("/", "quick-model"), ("/claude", "model"),
    ("/openai", "model"), ("/gemini", "model"),
])
def test_model_control_requires_explicit_selection(route, control, monkeypatch):
    async def no_pricing():
        return None

    monkeypatch.setattr("web.server.get_market_pricing", no_pricing)
    response = TestClient(app).get(route)
    assert response.status_code == 200
    parser = ModelControls()
    parser.feed(response.text)
    matches = [(tag, attrs) for tag, attrs in parser.elements if attrs.get("id") == control]
    assert len(matches) == 1
    tag, attrs = matches[0]
    assert tag == "select"
    assert "required" in attrs
    assert attrs.get("aria-describedby")
    assert any(tag == "option" and attrs.get("value") == "" and "disabled" in attrs
               and "selected" in attrs for tag, attrs in parser.elements)

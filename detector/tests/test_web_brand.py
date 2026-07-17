from __future__ import annotations

import importlib

import pytest

import web.brand as brand_module


def test_gewu_brand_environment_configures_public_site(monkeypatch):
    with monkeypatch.context() as env:
        env.setenv("GEWU_SITE_URL", "https://gewu.example")
        reloaded = importlib.reload(brand_module)
        assert reloaded.brand.name == "格物"
        assert reloaded.brand.site_url == "https://gewu.example"
    importlib.reload(brand_module)


@pytest.mark.parametrize(
    "value",
    [
        "https://user:secret@gewu.example",
        "https://gewu.example?token=secret",
        "https://gewu.example/#fragment",
    ],
)
def test_public_site_url_rejects_credentials_and_noncanonical_parts(value):
    with pytest.raises(RuntimeError):
        brand_module._normalise_site_url(value)


@pytest.mark.parametrize(
    "value",
    [
        "https://user:secret@example.com/repo",
        "https://example.com/repo?token=secret",
        "https://example.com/repo#fragment",
    ],
)
def test_source_url_rejects_credentials_and_tracking_parts(monkeypatch, value):
    monkeypatch.setenv("GEWU_SOURCE_URL", value)
    with pytest.raises(RuntimeError):
        brand_module._optional_http_url("GEWU_SOURCE_URL")

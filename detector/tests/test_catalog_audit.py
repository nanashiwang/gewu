"""Audit alerts must be actionable without hiding source or permission failures."""
import asyncio
import importlib.util
import json
from pathlib import Path

import httpx
import pytest

spec = importlib.util.spec_from_file_location(
    'catalog_audit', Path(__file__).parents[1] / 'scripts/check_model_catalog.py'
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def test_visible_model_ids_exclude_navigation_assets_and_scripts():
    page = '''<a href="kimi-navigation">kimi-k3.1-pro</a>
    <img src="kimi-context.svg"><p>kimi-context.svg kimi-k3-quickstart kimi-api</p>
    <script>kimi-script</script><style>kimi-style</style><noscript><pre>kimi-k3</pre></noscript>
    <code>kimi-k2.7-code-highspeed</code>'''
    assert audit.extract_ids(page, 'moonshot') == ['kimi-k2.7-code-highspeed', 'kimi-k3', 'kimi-k3.1-pro']


@pytest.mark.parametrize('report_only,expected', [(False, 1), (True, 0)])
def test_review_items_have_an_explicit_nonfatal_reporting_mode(tmp_path, monkeypatch, report_only, expected):
    snapshot = tmp_path / 'snapshot.json'
    snapshot.write_text(json.dumps({'openai': {'source': 'https://example.org/models', 'ids': ['gpt-5']}}))
    monkeypatch.setattr(audit, 'SNAPSHOT', snapshot)
    monkeypatch.setattr(audit, 'VENDORS', [{'id': 'openai', 'source': 'https://example.org/models'}])
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda req: httpx.Response(200, text='<code>gpt-6</code>'))
    monkeypatch.setattr(audit.httpx, 'AsyncClient', lambda **kw: original(transport=transport, **kw))
    output = tmp_path / 'report.json'
    assert asyncio.run(audit.audit(report_only=report_only, output=output)) == expected
    assert json.loads(output.read_text())['official_identifier_changes']['openai'] == {
        'added': ['gpt-6'], 'removed': ['gpt-5']
    }
    assert 'gpt-5' in snapshot.read_text()  # reporting never acknowledges changes


@pytest.mark.parametrize('status,body', [(503, 'unavailable'), (200, '<p>no models</p>')])
def test_report_mode_does_not_hide_unavailable_or_unparseable_sources(tmp_path, monkeypatch, status, body):
    monkeypatch.setattr(audit, 'VENDORS', [{'id': 'openai', 'source': 'https://example.org/models'}])
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda req: httpx.Response(status, text=body))
    monkeypatch.setattr(audit.httpx, 'AsyncClient', lambda **kw: original(transport=transport, **kw))
    output = tmp_path / 'report.json'
    assert asyncio.run(audit.audit(report_only=True, output=output)) == 2
    assert not output.exists()

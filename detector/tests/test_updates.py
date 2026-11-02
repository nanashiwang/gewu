import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from web import updates
from web.server import app


def row(**changes):
    return {"id": 227, "title": "测试动态", "content": "公开消息正文", "category_name": "产品更新",
            "posted_at": "2026-10-31T05:42:26.000Z", "source_url": "https://x.com/OpenAI/status/123", **changes}



@pytest.fixture(autouse=True)
def isolated_seed(tmp_path, monkeypatch):
    seed = tmp_path / 'seed.json'
    seed.write_text(json.dumps({
        'version': 1, 'last_success_at': '2026-11-01T00:00:00+00:00',
        'last_error': None, 'items': [row()],
    }))
    monkeypatch.setattr(updates, 'SEED', seed)


def html(rows):
    payload = '1:{"latestUpdates":{"title":"动态"}}\n2:' + json.dumps({"latestUpdates": rows}, ensure_ascii=False)
    middle = len(payload) // 2
    return ''.join('<script>self.__next_f.push(' + json.dumps([1, part], ensure_ascii=False) + ')</script>'
                   for part in [payload[:middle], payload[middle:]])


def test_parse_flight_chunks_and_ignore_translation_key():
    items = updates.parse_page(html([row(), row(id=228, posted_at="2026-11-01T00:00:00Z")]))
    assert [item['id'] for item in items] == [228, 227]
    assert items[1]['posted_at'] == '2026-10-31T05:42:26+00:00'


@pytest.mark.parametrize('rows', [[], [row(), row()], [row(posted_at="2026-10-31T05:42:26")], [row(title="")]])
def test_reject_changed_empty_or_invalid_source(rows):
    with pytest.raises(ValueError):
        updates.parse_page(html(rows))


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'https://x.com.evil.example/a', 'https://x.com@evil.example/',
                                  'https://x.com:443@127.0.0.1/', 'http://x.com/a', 'https://x.com\\@evil.example/a'])
def test_untrusted_links_are_not_published(url):
    assert updates.parse_page(html([row(source_url=url)]))[0]['source_url'] == ''


def test_merge_deduplicate_update_and_failure_preserves_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(updates, 'fetch_page', lambda: html([row(), row(id=228)]))
    assert updates.sync_once(directory=tmp_path) == 0
    monkeypatch.setattr(updates, 'fetch_page', lambda: html([row(title='更正后的标题')]))
    assert updates.sync_once(directory=tmp_path) == 0
    data = updates.load_snapshot(tmp_path)
    assert len(data['items']) == 2
    assert next(item for item in data['items'] if item['id'] == 227)['title'] == '更正后的标题'
    stamp = data['last_success_at']
    monkeypatch.setattr(updates, 'fetch_page', lambda: '<html>来源结构变化</html>')
    assert updates.sync_once(directory=tmp_path) == 1
    data = updates.load_snapshot(tmp_path)
    assert data['last_success_at'] == stamp and len(data['items']) == 2
    assert data['last_error'] == 'source_unavailable'
    assert not list(tmp_path.glob('.updates-*'))


def test_first_import_limit_and_stale_display(tmp_path, monkeypatch):
    monkeypatch.setattr(updates, 'fetch_page', lambda: html([row(), row(id=228, posted_at='2026-11-01T00:00:00Z')]))
    assert updates.sync_once(limit=1, directory=tmp_path) == 0
    assert len(updates.load_snapshot(tmp_path)['items']) == 2  # latest plus existing seed
    data = updates.load_snapshot(tmp_path)
    data['last_success_at'] = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    updates._write(tmp_path / 'snapshot.json', data)
    view = updates.page_data(tmp_path)
    assert view['stale'] is True
    assert next(item for item in view['items'] if item['id'] == 227)['date_label'] == '2026年10月31日 13:42'


def test_page_escapes_remote_text_and_does_not_fetch(tmp_path, monkeypatch):
    monkeypatch.setattr(updates, 'storage_dir', lambda: tmp_path)
    monkeypatch.setattr(updates, 'fetch_page', lambda: pytest.fail('page must not fetch'))
    data = updates.load_snapshot(tmp_path)
    data['items'] = [row(title='<script>alert(1)</script>', content='<img src=x onerror=alert(1)>')]
    data['last_error'] = 'source_unavailable'
    updates._write(tmp_path / 'snapshot.json', data)
    client = TestClient(app)
    response = client.get('/updates')
    assert response.status_code == 200
    assert '<script>alert(1)</script>' not in response.text
    assert '&lt;script&gt;' in response.text and '&lt;img' in response.text
    assert '最近一次同步未成功' in response.text
    assert '北京时间' in response.text and '查看原文' in response.text
    assert '中转神探' not in response.text
    assert 'https://x.com/OpenAI/status/123' in response.text
    assert 'href="/updates" aria-current="page"' in response.text
    assert '/updates</loc>' in client.get('/sitemap.xml').text


def test_fetch_rejects_redirects_and_large_pages(respx_mock):
    respx_mock.get(updates.SOURCE_URL).mock(return_value=httpx.Response(302, headers={'Location': 'https://example.org/'}))
    with pytest.raises(httpx.HTTPStatusError):
        updates.fetch_page()
    respx_mock.get(updates.SOURCE_URL).mock(return_value=httpx.Response(200, content=b'x' * (updates.MAX_BYTES + 1)))
    with pytest.raises(ValueError):
        updates.fetch_page()


def test_concurrent_sync_skips_without_fetching(tmp_path, monkeypatch):
    import fcntl
    monkeypatch.setattr(updates, 'fetch_page', lambda: pytest.fail('locked sync must not fetch'))
    with (tmp_path / 'sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert updates.sync_once(directory=tmp_path) == 0
    assert not (tmp_path / 'snapshot.json').exists()


def test_network_failure_preserves_initial_article(tmp_path, monkeypatch):
    def fail():
        raise httpx.ReadTimeout('remote failure')
    monkeypatch.setattr(updates, 'fetch_page', fail)
    assert updates.sync_once(directory=tmp_path) == 1
    data = updates.load_snapshot(tmp_path)
    assert len(data['items']) == 1
    assert data['last_error'] == 'source_unavailable'

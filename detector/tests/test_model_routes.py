
import httpx
import pytest
from fastapi.testclient import TestClient

from web import model_routes, server
from web.market_pricing import MarketModelPrice, MarketPricing, OKEN_API_BASE

MODEL = 'gpt-example'


def item(model=MODEL, method=1):
    return MarketModelPrice(model, 'OpenAI', method, ('编码',), 1, 1, 2, .1, 1, 10, 20, 2, None)


def row(**values):
    return {'id': 1, 'model_name': MODEL, 'pricing_method': 1, 'shop_name': '示例站', 'group_name': '线路一',
            'sort_level': 'S', 'is_official': 0, 'identity_passed': 1, 'cache_label': '官方一致',
            'min_input_price': ['0.5'], 'min_output_price': ['2.5'], 'min_cache_price': ['0'],
            'response_at': '2026-11-02T10:00:00', 'response_text': '近7天监测100次',
            'stability': 98.2, 'response_time': 700, 'tps': 20, **values}


def payload(rows=None, total=None):
    rows = [row()] if rows is None else rows
    return {'code': 0, 'data': {'list': rows, 'total': len(rows) if total is None else total}}


@pytest.fixture(autouse=True)
def cache_reset():
    model_routes._cache.clear()
    yield
    model_routes._cache.clear()


def test_price_units_zero_unknown_grades_and_missing_monitoring():
    data = model_routes.parse_routes(payload([row(), row(id=2, sort_level='X', response_at='', stability=0)]), MODEL, 1)
    assert data['rows'][0]['input'] == .5  # supplier data already per million, no multiplication
    assert data['rows'][0]['cache'] == 0
    assert data['rows'][1]['grade'] == ''
    assert data['rows'][1]['stability'] is None
    assert data['rows'][1]['latency'] is None
    assert model_routes.price(['NaN']) is None
    assert model_routes.price(['1', '3']) is None


@pytest.mark.parametrize('rows', [[row(model_name='different')], [row(pricing_method=2)], [row(), row()], [row(id=False)]])
def test_refuse_wrong_model_units_and_duplicates(rows):
    with pytest.raises(ValueError):
        model_routes.parse_routes(payload(rows), MODEL, 1)


def test_partial_and_empty_and_count_billing():
    data = model_routes.parse_routes(payload(total=500), MODEL, 1)
    assert data['partial'] and data['total'] == 500
    assert model_routes.parse_routes(payload([]), MODEL, 1)['rows'] == []
    data = model_routes.parse_routes(payload([row(pricing_method=2, min_count_price=['.04'])]), MODEL, 2)
    assert data['rows'][0]['count_price'] == .04
    assert data['rows'][0]['input'] is None


@pytest.mark.asyncio
async def test_fixed_endpoint_cache_and_query_encoding(respx_mock):
    route = respx_mock.get(OKEN_API_BASE + '/suppliers').mock(return_value=httpx.Response(200, json=payload()))
    result = await model_routes.get_model_routes(MODEL, 1)
    assert result is not None
    assert await model_routes.get_model_routes(MODEL, 1) is result
    assert route.call_count == 1
    assert route.calls[0].request.url.params['sku_name'] == MODEL
    assert route.calls[0].request.url.params['pricing_type'] == '1'
    assert route.calls[0].request.url.params['page_size'] == '200'
    url = model_routes.comparison_url('org/model?x=<script>', 1)
    assert 'model=org%2Fmodel%3Fx%3D%3Cscript%3E' in url


@pytest.mark.asyncio
async def test_bounded_cache_and_failure_no_stale_result(respx_mock, monkeypatch):
    respx_mock.get(OKEN_API_BASE + '/suppliers').mock(return_value=httpx.Response(302, headers={'Location': 'https://other.example'}))
    monkeypatch.setattr(model_routes, 'CACHE_SIZE', 2)
    for model in ['one', 'two', 'three']:
        assert await model_routes.get_model_routes(model, 1) is None
    assert len(model_routes._cache) == 2
    assert ('one', 1) not in model_routes._cache


@pytest.mark.asyncio
async def test_large_or_non_json_response_is_unavailable(respx_mock, monkeypatch):
    monkeypatch.setattr(model_routes, 'MAX_BYTES', 10)
    route = respx_mock.get(OKEN_API_BASE + '/suppliers')
    route.mock(return_value=httpx.Response(200, json=payload()))
    assert await model_routes.get_model_routes(MODEL, 1) is None
    model_routes._cache.clear()
    route.mock(return_value=httpx.Response(200, text='login required'))
    assert await model_routes.get_model_routes(MODEL, 1) is None


def test_model_link_to_comparison_escaping_and_no_request_for_unknown(monkeypatch):
    async def pricing():
        return MarketPricing((item(),), '2026-11-02')
    calls = []
    async def routes(model, billing):
        calls.append((model, billing))
        return model_routes.parse_routes(payload([row(shop_name='<script>alert(1)</script>', input_price_display='Top up 100')]), model, billing)
    monkeypatch.setattr(server, 'get_market_pricing', pricing)
    monkeypatch.setattr(model_routes, 'get_model_routes', routes)
    client = TestClient(server.app)
    page = client.get('/pricing')
    assert 'href="/leaderboard/models/compare?model=gpt-example&amp;billing=1"' in page.text
    detail = client.get(item().comparison_url)
    assert detail.status_code == 200
    assert 'S / A / B / C 为第三方线路评级' in detail.text
    assert '&lt;script&gt;' in detail.text
    assert '<small class="mc-price-condition">Top up 100</small>' in detail.text
    assert '<script>alert(1)</script>' not in detail.text
    assert '¥0.5' in detail.text and '98.2%' in detail.text
    assert client.get('/leaderboard/models/compare?model=unknown').status_code == 404
    assert client.get('/leaderboard/models/compare?model=gpt-example&billing=9').status_code == 422
    assert len(calls) == 1


def test_source_failure_visible_with_http_503(monkeypatch):
    async def pricing():
        return MarketPricing((item(),), '2026-11-02')
    async def unavailable(*args):
        return None
    monkeypatch.setattr(server, 'get_market_pricing', pricing)
    monkeypatch.setattr(model_routes, 'get_model_routes', unavailable)
    response = TestClient(server.app).get(item().comparison_url)
    assert response.status_code == 503 and '线路数据暂时无法读取' in response.text
    monkeypatch.setattr(server, 'get_market_pricing', unavailable)
    assert TestClient(server.app).get(item().comparison_url).status_code == 503


@pytest.mark.asyncio
async def test_concurrent_readers_share_one_request(monkeypatch):
    import asyncio
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    result = {'rows': []}
    async def load(*args):
        calls.append(args)
        entered.set()
        await release.wait()
        return result
    monkeypatch.setattr(model_routes, '_load_model_routes', load)
    owner = asyncio.create_task(model_routes.get_model_routes(MODEL, 1))
    await entered.wait()
    follower = asyncio.create_task(model_routes.get_model_routes(MODEL, 1))
    await asyncio.sleep(0)
    release.set()
    assert await owner is result and await follower is result
    assert len(calls) == 1 and not model_routes._inflight


@pytest.mark.asyncio
async def test_cancelled_follower_does_not_cancel_owner(monkeypatch):
    import asyncio
    entered, release = asyncio.Event(), asyncio.Event()
    async def load(*args):
        entered.set()
        await release.wait()
        return {'rows': []}
    monkeypatch.setattr(model_routes, '_load_model_routes', load)
    owner = asyncio.create_task(model_routes.get_model_routes(MODEL, 1))
    await entered.wait()
    follower = asyncio.create_task(model_routes.get_model_routes(MODEL, 1))
    await asyncio.sleep(0)
    follower.cancel()
    with pytest.raises(asyncio.CancelledError):
        await follower
    release.set()
    assert await owner == {'rows': []}
    assert not model_routes._inflight


@pytest.mark.asyncio
async def test_owner_cancellation_releases_followers_and_capacity(monkeypatch):
    import asyncio
    entered = asyncio.Event()
    async def load(*args):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(model_routes, '_load_model_routes', load)
    monkeypatch.setattr(model_routes, 'MAX_INFLIGHT', 1)
    owner = asyncio.create_task(model_routes.get_model_routes(MODEL, 1))
    await entered.wait()
    assert await model_routes.get_model_routes('different', 1) is None
    follower = asyncio.create_task(model_routes.get_model_routes(MODEL, 1))
    await asyncio.sleep(0)
    owner.cancel()
    with pytest.raises(asyncio.CancelledError):
        await owner
    assert await follower is None
    assert not model_routes._inflight


def test_source_that_ignores_page_size_can_return_more_than_200_rows():
    rows = [row(id=i + 1) for i in range(250)]
    parsed = model_routes.parse_routes(payload(rows), MODEL, 1)
    assert len(parsed['rows']) == 250 and not parsed['partial']
    with pytest.raises(ValueError):
        model_routes.parse_routes(payload([row(id=i + 1) for i in range(1001)]), MODEL, 1)


def test_details_have_unique_controls_and_matching_column_span(monkeypatch):
    async def pricing():
        return MarketPricing((item(),), '2026-11-02')
    async def routes(model, billing):
        return model_routes.parse_routes(payload([row(), row(id=2)]), model, billing)
    monkeypatch.setattr(server, 'get_market_pricing', pricing)
    monkeypatch.setattr(model_routes, 'get_model_routes', routes)
    response = TestClient(server.app).get(item().comparison_url)
    assert response.status_code == 200
    assert 'aria-controls="mc-detail-1"' in response.text
    assert 'aria-controls="mc-detail-2"' in response.text
    assert 'id="mc-detail-1" hidden><td colspan="9"' in response.text
    assert 'id="mc-next"' in response.text

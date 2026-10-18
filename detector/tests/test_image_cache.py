"""Offline concurrency and cleanup checks for public report JPG downloads."""
import asyncio
from pathlib import Path
import threading
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from web import server
from web.image_cache import ImageQueueBusy, ReportImageCache, _render_atomic

JPEG = b'\xff\xd8fixture-jpeg\xff\xd9'


@pytest_asyncio.fixture
async def cache():
    item = ReportImageCache(max_pending=2)
    yield item
    await item.shutdown()
    assert not item._tasks and not item._active, 'image tasks must finish'


async def wait_started(event):
    assert await asyncio.wait_for(asyncio.to_thread(event.wait, 2), 3)


@pytest.mark.asyncio
async def test_existing_image_is_reused_without_rendering(cache, tmp_path):
    path = tmp_path/'existing.jpg'
    path.write_bytes(JPEG)
    assert await cache.get(path, lambda: pytest.fail('cached report rendered')) == JPEG
    assert not cache._tasks


@pytest.mark.asyncio
async def test_duplicate_requests_share_one_render_and_do_not_block_loop(cache, tmp_path):
    start, finish = threading.Event(), threading.Event()
    calls = []
    def render():
        calls.append(threading.get_ident())
        start.set()
        assert finish.wait(3)
        return JPEG
    first = asyncio.create_task(cache.get(tmp_path/'image.jpg', render))
    second = None
    try:
        await wait_started(start)
        second = asyncio.create_task(cache.get(tmp_path/'image.jpg', render))
        await asyncio.sleep(0.02)
        assert len(calls) == 1
        assert calls[0] != threading.get_ident()
        assert not (tmp_path/'image.jpg').exists()
        finish.set()
        assert await first == await second == JPEG
    finally:
        finish.set()
        await asyncio.gather(*[t for t in (first, second) if t], return_exceptions=True)
    assert not list(tmp_path.glob('.gewu-image-*'))


@pytest.mark.asyncio
async def test_queue_limit_still_allows_cached_images(cache, tmp_path):
    start, finish = threading.Event(), threading.Event()
    calls=[]
    def render():
        calls.append(True)
        start.set()
        assert finish.wait(3)
        return JPEG
    first=asyncio.create_task(cache.get(tmp_path/'first.jpg',render))
    second=None
    try:
        await wait_started(start)
        second=asyncio.create_task(cache.get(tmp_path/'second.jpg',lambda: JPEG))
        for _ in range(50):
            if len(cache._tasks)==2: break
            await asyncio.sleep(0.005)
        with pytest.raises(ImageQueueBusy): await cache.get(tmp_path/'third.jpg',lambda: JPEG)
        (tmp_path/'cached.jpg').write_bytes(JPEG)
        assert await cache.get(tmp_path/'cached.jpg',lambda: pytest.fail('unneeded work'))==JPEG
        assert len(calls)==1
        finish.set()
        assert await first == await second == JPEG
    finally:
        finish.set()
        await asyncio.gather(*[t for t in (first,second) if t],return_exceptions=True)


@pytest.mark.asyncio
async def test_disconnect_does_not_cancel_shared_work(cache,tmp_path):
    start,finish=threading.Event(),threading.Event()
    count=[]
    def render():
        count.append(True)
        start.set()
        assert finish.wait(3)
        return JPEG
    first=asyncio.create_task(cache.get(tmp_path/'image.jpg',render))
    second=None
    try:
        await wait_started(start)
        first.cancel()
        with pytest.raises(asyncio.CancelledError): await first
        second=asyncio.create_task(cache.get(tmp_path/'image.jpg',render))
        await asyncio.sleep(0.02)
        assert len(count)==1
        finish.set()
        assert await second==JPEG
    finally:
        finish.set()
        await asyncio.gather(*[t for t in (first,second) if t],return_exceptions=True)


@pytest.mark.asyncio
async def test_shutdown_cancels_waiting_work_and_joins_active_thread(cache,tmp_path):
    start,finish=threading.Event(),threading.Event()
    def render():
        start.set()
        assert finish.wait(3)
        return JPEG
    active=asyncio.create_task(cache.get(tmp_path/'active.jpg',render))
    waiting=closing=None
    try:
        await wait_started(start)
        waiting=asyncio.create_task(cache.get(tmp_path/'waiting.jpg',lambda: pytest.fail('must not start while stopping')))
        for _ in range(50):
            if len(cache._tasks)==2: break
            await asyncio.sleep(0.005)
        closing=asyncio.create_task(cache.shutdown())
        await asyncio.sleep(0.02)
        assert not closing.done()
        with pytest.raises(ImageQueueBusy): await cache.get(tmp_path/'new.jpg',lambda: JPEG)
        finish.set()
        await closing
        assert await active == JPEG
        with pytest.raises(asyncio.CancelledError): await waiting
        assert not (tmp_path/'waiting.jpg').exists()
    finally:
        finish.set()
        await asyncio.gather(*[t for t in (active,waiting,closing) if t],return_exceptions=True)


@pytest.mark.asyncio
async def test_renderer_failure_can_retry_without_partial_file(cache,tmp_path,caplog):
    path=tmp_path/'failed.jpg'
    def fail(): raise ValueError('private-report-secret')
    with pytest.raises(ValueError): await cache.get(path,fail)
    await asyncio.sleep(0)
    assert not path.exists()
    assert 'private-report-secret' not in caplog.text
    assert await cache.get(path,lambda: JPEG)==JPEG


def test_atomic_write_failure_keeps_previous_bytes_and_removes_temporary_file(tmp_path,monkeypatch):
    path=tmp_path/'old.jpg'
    path.write_bytes(b'incomplete')
    def fail(*a): raise OSError('injected disk failure')
    monkeypatch.setattr('web.image_cache.os.replace',fail)
    with pytest.raises(OSError): _render_atomic(path,lambda: JPEG)
    assert path.read_bytes()==b'incomplete'
    assert not list(tmp_path.glob('.gewu-image-*'))


@pytest.mark.asyncio
async def test_incomplete_legacy_cache_is_regenerated(cache,tmp_path):
    path=tmp_path/'legacy.jpg'
    path.write_bytes(b'\xff\xd8half-image')
    assert await cache.get(path,lambda: JPEG)==JPEG
    assert path.read_bytes()==JPEG


@pytest.mark.asyncio
async def test_web_health_remains_responsive_during_jpg_render(cache,tmp_path,monkeypatch):
    start,finish=threading.Event(),threading.Event()
    def render(report):
        start.set()
        assert finish.wait(3)
        return JPEG
    async def job(_): return SimpleNamespace(report={'protocol':'openai'},protocol='openai')
    monkeypatch.setattr(server,'report_images',cache)
    monkeypatch.setattr(server,'render_report_jpg',render)
    monkeypatch.setattr(server.jobs,'get',job)
    monkeypatch.setattr(server.jobs,'image_path',lambda *a:tmp_path/'report.jpg')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),base_url='https://test') as client:
        request=asyncio.create_task(client.get('/r/abcdefgh.jpg'))
        try:
            await wait_started(start)
            health=await asyncio.wait_for(client.get('/healthz'),1)
            assert health.status_code==200
            finish.set()
            result=await request
            assert result.status_code==200 and result.content==JPEG
            assert result.headers['content-type']=='image/jpeg'
        finally:
            finish.set()
            await asyncio.gather(request,return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('error',[ImageQueueBusy('full'),OSError('private-file-path')])
async def test_export_failure_returns_retry_without_sensitive_details(tmp_path,monkeypatch,error):
    async def get(*a): raise error
    async def job(_): return SimpleNamespace(report={'protocol':'openai'},protocol='openai')
    monkeypatch.setattr(server,'report_images',SimpleNamespace(get=get))
    monkeypatch.setattr(server.jobs,'get',job)
    monkeypatch.setattr(server.jobs,'image_path',lambda *a:tmp_path/'image.jpg')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),base_url='https://test') as client:
        result=await client.get('/r/abcdefgh.jpg')
    assert result.status_code==503
    assert result.headers['retry-after']=='3'
    assert result.headers['cache-control']=='no-store'
    assert '文字报告' in result.json()['detail']
    assert 'private-file-path' not in result.text

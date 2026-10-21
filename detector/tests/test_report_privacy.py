"""Anonymous ownership, all access paths, revocation and minimal safe sharing.

Every report is synthetic. No upstream API or business data is touched.
"""
import asyncio
import copy
import json
import hashlib
import hmac
import time
import secrets
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from web import jobs, server, report_access
from web.image_cache import ReportImageCache
from relay_detector.ranking import assess_ranking_eligibility

OWNER = secrets.token_urlsafe(32)
OTHER = secrets.token_urlsafe(32)
JOB = 'privatejob123'
HEADERS = {'X-Gewu-Action': 'report-sharing', 'Origin': 'https://testserver'}
JPEG = b'\xff\xd8synthetic-image\xff\xd9'


def account_cookie(key, job_id, owner, session, expiry=None):
    expiry = expiry or int(time.time()) + 300
    payload = f"gewu-account-view\n{job_id}\n{owner}\n{expiry}\n{hashlib.sha256(session.encode()).hexdigest()}"
    return f"{owner}.{expiry}." + hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


@pytest_asyncio.fixture(autouse=True)
async def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, 'JOBS_DIR', tmp_path)
    monkeypatch.setattr(jobs, '_JOBS', {})
    monkeypatch.setattr(jobs, '_TASKS', {})
    monkeypatch.setattr(jobs, '_STOP_REASONS', {})
    monkeypatch.setattr(jobs, '_SEMA', asyncio.Semaphore(0))
    monkeypatch.setattr(jobs, '_LOCK', asyncio.Lock())
    monkeypatch.setattr(jobs, '_ACCEPTING', True)
    monkeypatch.setattr(server, '_SITEMAP_REPORT_DIRS', [tmp_path / 'openai', tmp_path])
    monkeypatch.delenv('GEWU_INTERNAL_API_TOKEN', raising=False)
    async def no_upstream(*args, **kwargs):
        raise AssertionError('privacy tests must not call upstream')
    for name in ('_run_openai', '_run_anthropic', '_run_gemini'):
        monkeypatch.setattr(jobs, name, no_upstream)
    yield
    await jobs.shutdown()
    assert not jobs._TASKS, 'all synthetic detection tasks must exit'


def sample_report():
    # Free text includes fake private path and reflected content in multiple
    # locations. The sharing code must copy a display allowlist, not redact a
    # single top-level URL while accidentally leaking evidence elsewhere.
    return {
        'protocol': 'openai', 'wire_api': 'chat_completions', 'mode': 'quick',
        'target_model': 'gpt-example', 'base_url': 'https://relay.example/private/customer-123/v1',
        'timestamp': '2026-10-18T00:00:00+00:00', 'total_score': 100,
        'verdict': 'passed', 'api_key_masked': 'sk-old-fragment',
        'summary': 'secret-summary', 'self_reported_identity': 'secret-identity',
        'results': [{'name': 'basic_request', 'display_name': 'secret-display', 'score': 100,
                     'weight': 100, 'status': 'pass',
                     'details': {'response_text': 'secret-response', 'url': '/private/customer-123/v1'}}],
        'performance': {'ttft_ms': 42, 'total_latency_ms': 120,
                        'usage': {'input_tokens': 8, 'output_tokens': 4}, 'raw': 'secret-performance'},
        'ranking_evidence': {'verification_reference': 'secret-review'},
    }


def private_job(owner=OWNER, job_id=JOB):
    report = sample_report()
    report['_web_access'] = report_access.VERSION
    job = jobs.Job(id=job_id, protocol='openai', status='done', report=report,
                   target_model=report['target_model'], base_url=report['base_url'], mode='quick',
                   access_version=report_access.VERSION)
    report_access.create(jobs.JOBS_DIR, job_id, owner)
    jobs._atomic_json(jobs.report_path(job_id, 'openai'), report)
    jobs._save_state(job)
    jobs._JOBS[job_id] = job
    return job


def client(owner=None, app=None, secure=True):
    result = httpx.AsyncClient(transport=httpx.ASGITransport(app=app or server.app),
                              base_url=('https' if secure else 'http') + '://testserver')
    if owner:
        result.cookies.set(report_access.cookie_name(secure), owner)
    return result


@pytest.mark.parametrize('endpoint,model', [('/api/detect/claude', 'claude-test'),
    ('/api/detect/openai', 'gpt-test'), ('/api/detect/gemini', 'gemini-test'),
    ('/api/detect', 'claude-test'), ('/api/detect', 'gpt-test')])
async def test_submission_needs_no_extra_field_or_login_and_sets_private_cookie(monkeypatch, endpoint, model):
    async def validated(value): return value
    async def preflight(*args): pass
    monkeypatch.setattr(server, '_validated_target_or_400', validated)
    monkeypatch.setattr(server, '_preflight_or_422', preflight)
    monkeypatch.setattr(server, '_enforce_rate_limit', lambda *args, **kwargs: None)
    async with client() as browser:
        response = await browser.post(endpoint, data={'base_url': 'https://relay.example/private',
            'api_key': 'sk-synthetic-only', 'model': model, 'mode': 'quick'})
        assert response.status_code == 200
        cookie = response.headers['set-cookie']
        assert all(value in cookie for value in ('__Host-gewu_report_owner=', 'HttpOnly', 'Secure', 'SameSite=lax', 'Path=/'))
        assert 'Domain=' not in cookie
        owner = browser.cookies.get('__Host-gewu_report_owner')
        job_id = response.json()['job_id']
        job = await jobs.get(job_id)
        assert job.access_version == 1 and report_access.owned(jobs.JOBS_DIR, job_id, owner)
        assert owner not in response.text
        assert (await browser.get(response.json()['status_url'])).status_code == 200
        assert (await browser.get(f'/r/{job_id}')).status_code == 200
        # This same cookie cancels; no extra cancellation cookie is necessary.
        assert (await browser.post(f'/api/status/{job_id}/cancel')).json()['status'] == 'cancelled'
        assert job.report['_web_access'] == 1
        assert not jobs._TASKS
        for path in jobs.JOBS_DIR.rglob('*'):
            if path.is_file():
                assert owner not in path.read_text() and 'sk-synthetic-only' not in path.read_text()
        second = await browser.post(endpoint, data={'base_url': 'https://relay.example',
            'api_key': 'sk-synthetic-only', 'model': model, 'mode': 'quick'})
        assert second.status_code == 200
        assert browser.cookies.get('__Host-gewu_report_owner') == owner


@pytest.mark.parametrize('suffix', [f'/r/{JOB}', f'/r/{JOB}.jpg', f'/api/status/{JOB}', f'/api/result/{JOB}.json'])
async def test_all_original_routes_deny_other_browser_even_with_shared_query(suffix, monkeypatch):
    private_job()
    token = report_access.enable(jobs.JOBS_DIR, JOB, OWNER)
    async with client(OTHER) as stranger:
        for extra in ('', f'?share={token}', f'?token={OWNER}'):
            response = await stranger.get(suffix + extra)
            assert response.status_code == 404
            assert 'customer-123' not in response.text and 'gpt-example' not in response.text
            assert response.headers['cache-control'] == 'no-store'
            assert 'noindex' in response.headers['x-robots-tag']
    # Neither an owner token in a URL nor a sharing token becomes a cookie.
    async with client(token) as stranger:
        assert (await stranger.get(suffix)).status_code == 404


async def test_owner_reopens_after_process_restart_and_can_download(monkeypatch):
    private_job()
    jobs._JOBS.clear()
    rendered = []
    async def image(path, render):
        rendered.append(str(path))
        return render()
    monkeypatch.setattr(server, 'report_images', SimpleNamespace(get=image))
    monkeypatch.setattr(server, 'render_report_jpg', lambda report: JPEG)
    async with client(OWNER) as browser:
        for url in (f'/r/{JOB}', f'/api/status/{JOB}', f'/api/result/{JOB}.json', f'/r/{JOB}.jpg'):
            response = await browser.get(url)
            assert response.status_code == 200
            assert response.headers['cache-control'] == 'no-store'
        body = (await browser.get(f'/r/{JOB}')).text
        assert 'data-job-id="privatejob123"' in body and '分享摘要' in body
        assert '/private/customer-123/v1' in body
    assert rendered and '.scope-v2.jpg' in rendered[0]


async def test_one_click_share_is_stable_revocable_and_uses_safe_summary(monkeypatch):
    job = private_job()
    original = copy.deepcopy(job.report)
    async def image(path, render): return render()
    def render(safe, *, assessment):
        text = json.dumps(safe)
        assert 'customer-123' not in text and 'secret-' not in text and 'sk-old' not in text
        assert safe['base_url'] == 'relay.example'
        assert assessment == server.assess_report(original)
        return JPEG
    monkeypatch.setattr(server, 'report_images', SimpleNamespace(get=image))
    monkeypatch.setattr(server, 'render_report_jpg', render)
    async with client(OWNER) as owner, client() as visitor:
        response = await owner.post(f'/api/status/{JOB}/share', headers=HEADERS)
        assert response.status_code == 200
        link = response.json()['url']
        assert (await owner.post(f'/api/status/{JOB}/share', headers=HEADERS)).json()['url'] == link
        html = await visitor.get(link)
        assert html.status_code == 200 and 'relay.example' in html.text and 'gpt-example' in html.text
        assert 'customer-123' not in html.text and 'secret-' not in html.text and 'sk-old' not in html.text
        assert html.headers['cache-control'] == 'no-store'
        assert 'noindex' in html.headers['x-robots-tag']
        assert 'no-referrer' == html.headers['referrer-policy']
        assert (await visitor.get(link + '.jpg')).content == JPEG
        assert (await visitor.post(f'/api/status/{JOB}/cancel')).status_code == 403
        assert job.report == original
        for path in jobs.JOBS_DIR.rglob('*'):
            if path.is_file():
                text = path.read_text()
                assert OWNER not in text and link.rsplit('/', 1)[-1] not in text
        assert (await owner.post(f'/api/status/{JOB}/share/revoke', headers=HEADERS)).status_code == 200
        assert (await visitor.get(link)).status_code == 404
        assert (await visitor.get(link + '.jpg')).status_code == 404
        new_link = (await owner.post(f'/api/status/{JOB}/share', headers=HEADERS)).json()['url']
        assert new_link != link and (await visitor.get(link)).status_code == 404
        assert (await visitor.get(new_link)).status_code == 200


@pytest.mark.parametrize('operation', ['share', 'share/revoke'])
@pytest.mark.parametrize('headers', [{}, {'X-Gewu-Action': 'wrong'},
    {'X-Gewu-Action': 'report-sharing', 'Origin': 'https://evil.test'},
    {'X-Gewu-Action': 'report-sharing', 'Origin': 'null'},
    {'X-Gewu-Action': 'report-sharing', 'Sec-Fetch-Site': 'cross-site'}])
async def test_sharing_mutations_require_same_origin_and_explicit_action(operation, headers):
    private_job()
    async with client(OWNER) as owner:
        assert (await owner.post(f'/api/status/{JOB}/{operation}', headers=headers)).status_code == 403


async def test_foreign_owner_internal_key_and_get_never_toggle_sharing(monkeypatch):
    private_job()
    monkeypatch.setenv('GEWU_INTERNAL_API_TOKEN', 'synthetic-internal')
    async with client(OTHER) as stranger:
        for operation in ('share', 'share/revoke'):
            path = f'/api/status/{JOB}/{operation}'
            assert (await stranger.post(path, headers=HEADERS)).status_code == 404
            assert (await stranger.post(path, headers={**HEADERS, 'X-Gewu-Internal-Token': 'synthetic-internal'})).status_code == 404
            assert (await stranger.get(path, headers=HEADERS)).status_code == 405
    async with client(OWNER, secure=False) as owner:
        monkeypatch.delenv('GEWU_ALLOW_INSECURE_API', raising=False)
        assert (await owner.post(f'/api/status/{JOB}/share', headers=HEADERS)).status_code == 426


@pytest.mark.parametrize('damage', ['missing', 'corrupt', 'invalid', 'symlink'])
async def test_metadata_damage_never_makes_report_public_even_without_task_state(damage, tmp_path):
    private_job()
    path = jobs.JOBS_DIR / '.report_access' / f'{JOB}.access'
    if damage == 'missing': path.unlink()
    elif damage == 'corrupt': path.write_text('{')
    elif damage == 'invalid': path.write_text('{"version":2}')
    else:
        path.unlink()
        path.symlink_to(tmp_path / 'missing-target')
    jobs._state_path(JOB).unlink()
    jobs._JOBS.clear()
    async with client(OWNER) as owner:
        for url in (f'/r/{JOB}', f'/r/{JOB}.jpg', f'/api/status/{JOB}', f'/api/result/{JOB}.json'):
            assert (await owner.get(url)).status_code == 404


async def test_missing_report_marker_still_respects_sidecar_and_task_metadata():
    job = private_job()
    job.report.pop('_web_access')
    job.access_version = 0
    async with client() as visitor:
        assert (await visitor.get(f'/r/{JOB}')).status_code == 404


async def test_revoke_while_rendering_prevents_image_delivery(monkeypatch):
    private_job()
    token = report_access.enable(jobs.JOBS_DIR, JOB, OWNER)
    started, done = asyncio.Event(), asyncio.Event()
    async def image(*args):
        started.set()
        await done.wait()
        return JPEG
    monkeypatch.setattr(server, 'report_images', SimpleNamespace(get=image))
    async with client(OWNER) as owner, client() as visitor:
        task = asyncio.create_task(visitor.get(f'/r/{JOB}/s/{token}.jpg'))
        try:
            await asyncio.wait_for(started.wait(), 2)
            assert (await owner.post(f'/api/status/{JOB}/share/revoke', headers=HEADERS)).status_code == 200
            done.set()
            assert (await asyncio.wait_for(task, 2)).status_code == 404
        finally:
            done.set()
            await asyncio.gather(task, return_exceptions=True)


async def test_legacy_links_continue_to_work_but_self_tests_leave_sitemap(monkeypatch):
    private_job()
    old = sample_report()
    jobs._atomic_json(jobs.report_path('legacyjob123', 'openai'), old)
    async with client() as visitor:
        html = await visitor.get('/r/legacyjob123')
        assert html.status_code == 200 and '升级前的公开报告' in html.text
        assert 'data-job-id=' not in html.text
        assert 'noindex' in html.headers['x-robots-tag']
        sitemap = (await visitor.get('/sitemap.xml')).text
        assert JOB not in sitemap and 'legacyjob123' not in sitemap
    assert assess_ranking_eligibility((await jobs.get(JOB)).report) == (False, 'private_report')


async def test_report_pages_never_send_capability_urls_to_analytics(monkeypatch):
    from dataclasses import replace
    private_job()
    # The global template brand is separate from the server import.
    monkeypatch.setitem(server.templates.env.globals, 'brand', replace(server.brand, analytics_id='G-SYNTHETIC'))
    token = report_access.enable(jobs.JOBS_DIR, JOB, OWNER)
    async with client(OWNER) as owner:
        for url in (f'/r/{JOB}', f'/r/{JOB}/s/{token}'):
            html = (await owner.get(url)).text
            assert 'googletagmanager.com/gtag' not in html and "gtag('config'" not in html


async def test_sharing_uses_existing_shared_domain_route_without_proxy_changes():
    from starlette.responses import Response
    import re
    async def proxy(scope, receive, send):
        if re.match(r'^/(?:r/|api/(?:status/|result/))', scope['path']):
            await server.app(scope, receive, send)
        else:
            await Response(status_code=404)(scope, receive, send)
    private_job()
    async with client(OWNER, app=proxy) as owner:
        response = await owner.post(f'/api/status/{JOB}/share', headers=HEADERS)
        assert response.status_code == 200
        assert (await owner.get(response.json()['url'])).status_code == 200


async def test_share_enable_and_revoke_disk_failure_does_not_claim_success(monkeypatch):
    private_job()
    def fail(*args): raise OSError('synthetic private disk path')
    monkeypatch.setattr(report_access, '_save', fail)
    async with client(OWNER) as owner:
        for operation in ('share', 'share/revoke'):
            response = await owner.post(f'/api/status/{JOB}/{operation}', headers=HEADERS)
            assert response.status_code == 503
            assert 'private disk path' not in response.text


def test_summary_handles_url_credentials_and_keeps_source_immutable():
    original = sample_report()
    original['base_url'] = 'https://name:password@relay.example:8443/private?token=secret#fragment'
    before = copy.deepcopy(original)
    safe = report_access.summary_report(original)
    assert safe['base_url'] == 'relay.example'
    assert all(value not in json.dumps(safe) for value in ('name:', 'password', 'private', 'secret', 'sk-old'))
    assert original == before


async def test_private_reports_live_outside_legacy_reader_directories():
    job_id = await jobs.submit('https://relay.example/private', 'sk-synthetic', 'gpt-test', 'quick', 'openai', owner_token=OWNER)
    await jobs.cancel(job_id)
    assert not list(jobs.JOBS_DIR.glob('*.json'))
    assert not list((jobs.JOBS_DIR / 'openai').glob('*.json'))
    path = jobs.report_path(job_id, 'openai')
    assert path.is_relative_to(jobs.JOBS_DIR / '.private_reports') and path.exists()
    # An old reader rejects the new state field and never scans this hidden
    # report directory. A new reader remains private even if sidecars vanish.
    state = json.loads(jobs._state_path(job_id).read_text())
    assert state['access_version'] == 1
    report = json.loads(path.read_text())
    report.pop('_web_access')
    path.write_text(json.dumps(report))
    (jobs.JOBS_DIR / '.report_access' / f'{job_id}.access').unlink()
    jobs._state_path(job_id).unlink()
    jobs._JOBS.clear()
    async with client() as visitor:
        assert (await visitor.get(f'/r/{job_id}')).status_code == 404


async def test_account_gateway_grant_is_per_report_and_cannot_claim_anonymous_reports(monkeypatch):
    private_job()
    key = 'synthetic-internal-key'
    monkeypatch.setenv('GEWU_INTERNAL_API_TOKEN', key)
    first = await jobs.submit('https://relay.example', 'sk-synthetic', 'gpt-test', 'quick', 'openai', account_owner_secret=key)
    second = await jobs.submit('https://relay.example', 'sk-synthetic', 'gpt-test', 'quick', 'openai', account_owner_secret=key)
    async with client() as backend, client() as browser:
        assert (await backend.post(f'/api/status/{first}/owner')).status_code == 404
        assert (await backend.post(f'/api/status/{JOB}/owner', headers={'X-Gewu-Internal-Token': key})).status_code == 404
        response = await backend.post(f'/api/status/{first}/owner', headers={'X-Gewu-Internal-Token': key})
        assert response.status_code == 200
        owner = response.json()['owner']
        assert owner == report_access.account_owner(key, first)
        browser.cookies.set('payload-token', 'synthetic-login-session')
        browser.cookies.set(f'__Host-gewu_report_{first}', account_cookie(key, first, owner, 'synthetic-login-session'))
        assert (await browser.get(f'/r/{first}')).status_code == 200
        assert (await browser.get(f'/r/{second}')).status_code == 404
        assert (await browser.post(f'/api/status/{first}/cancel')).status_code == 200
        link = (await browser.post(f'/api/status/{first}/share', headers=HEADERS)).json()['url']
        assert (await browser.get(link)).status_code == 200
        # A rotated service credential can recover account access without
        # granting anonymous ownership or retaining an old account capability.
        monkeypatch.setenv('GEWU_INTERNAL_API_TOKEN', 'rotated-synthetic')
        fresh = await backend.post(f'/api/status/{first}/owner', headers={'X-Gewu-Internal-Token': 'rotated-synthetic'})
        assert fresh.status_code == 200 and fresh.json()['owner'] != owner
        assert (await browser.get(f'/r/{first}')).status_code == 404
        assert (await browser.get(link)).status_code == 404
        browser.cookies.set(f'__Host-gewu_report_{first}', account_cookie('rotated-synthetic', first, fresh.json()['owner'], 'synthetic-login-session'))
        assert (await browser.get(f'/r/{first}')).status_code == 200


async def test_internal_api_reads_private_reports_but_wrong_key_cannot(monkeypatch):
    private_job()
    monkeypatch.setenv('GEWU_INTERNAL_API_TOKEN', 'synthetic-internal')
    async with client() as backend:
        for suffix in (f'/api/status/{JOB}', f'/api/result/{JOB}.json'):
            assert (await backend.get(suffix, headers={'X-Gewu-Internal-Token': 'wrong'})).status_code == 404
            assert (await backend.get(suffix, headers={'X-Gewu-Internal-Token': 'synthetic-internal'})).status_code == 200
        # Preserving the marker lets the account platform avoid publicly
        # returning links and free-text summaries of private reports.
        response = await backend.get(f'/api/result/{JOB}.json', headers={'X-Gewu-Internal-Token': 'synthetic-internal'})
        assert response.json()['_web_access'] == 1


async def test_first_form_visit_establishes_one_browser_identity_without_settings():
    async with client() as browser:
        first = await browser.get('/openai')
        assert first.status_code == 200
        cookie = browser.cookies.get('__Host-gewu_report_owner')
        assert report_access.valid_owner(cookie)
        assert first.headers['cache-control'] == 'no-store'
        await browser.get('/gemini')
        assert browser.cookies.get('__Host-gewu_report_owner') == cookie
        assert cookie not in first.text


async def test_private_jpg_cache_cannot_be_reused_as_a_shared_summary(monkeypatch):
    private_job()
    token = report_access.enable(jobs.JOBS_DIR, JOB, OWNER)
    complete = jobs.image_path(JOB, 'openai').with_suffix('.scope-v2.jpg')
    complete.write_bytes(b'\xff\xd8customer-private-path\xff\xd9')
    cache = ReportImageCache()
    monkeypatch.setattr(server, 'report_images', cache)
    monkeypatch.setattr(server, 'render_report_jpg', lambda report, **kwargs: JPEG)
    try:
        async with client() as visitor:
            response = await visitor.get(f'/r/{JOB}/s/{token}.jpg')
            assert response.status_code == 200 and response.content == JPEG
            assert b'customer-private-path' not in response.content
        assert complete.read_bytes() == b'\xff\xd8customer-private-path\xff\xd9'
    finally:
        await cache.shutdown()
        assert not cache._tasks and not cache._active


async def test_account_grants_expire_and_cannot_survive_logout_switching_or_cookie_relocation(monkeypatch):
    key = 'synthetic-session-bound-key'
    monkeypatch.setenv('GEWU_INTERNAL_API_TOKEN', key)
    job_id = await jobs.submit('https://relay.example', 'sk-synthetic', 'gpt-test', 'quick', 'openai', account_owner_secret=key)
    owner = report_access.account_owner(key, job_id)
    cookie = account_cookie(key, job_id, owner, 'session-one')
    async with client() as browser:
        browser.cookies.set(f'__Host-gewu_report_{job_id}', cookie)
        browser.cookies.set('payload-token', 'session-one')
        assert (await browser.get(f'/r/{job_id}')).status_code == 200
        browser.cookies.delete('payload-token')
        assert (await browser.get(f'/r/{job_id}')).status_code == 404
        browser.cookies.set('payload-token', 'session-two')
        assert (await browser.get(f'/r/{job_id}')).status_code == 404
        browser.cookies.set('payload-token', 'session-one')
        browser.cookies.set(f'__Host-gewu_report_{job_id}', account_cookie(key, job_id, owner, 'session-one', int(time.time()) - 1))
        assert (await browser.get(f'/r/{job_id}')).status_code == 404
        # Extracting the raw owner into either unbound cookie must not bypass
        # the account/session branch, including the anonymous browser cookie.
        browser.cookies.set(f'__Host-gewu_report_{job_id}', owner)
        browser.cookies.set('__Host-gewu_report_owner', owner)
        assert (await browser.get(f'/r/{job_id}')).status_code == 404


@pytest.mark.parametrize('endpoint,model,wire', [
    ('/api/detect/claude', 'claude-test', 'messages'),
    ('/api/detect/openai', 'gpt-test', 'responses'),
    ('/api/detect/openai', 'gpt-test', 'chat_completions'),
    ('/api/detect/openai', 'deepseek-chat', 'chat_completions'),
    ('/api/detect/gemini', 'gemini-test', 'chat_completions'),
    ('/api/detect/gemini', 'gemini-test', 'generate_content'),
    ('/api/detect/gemini', 'gemini-test', 'interactions'),
])
async def test_home_direct_submit_queues_once_without_extra_paid_preflight(monkeypatch, endpoint, model, wire):
    async def validated(value): return value
    async def forbidden(*args, **kwargs): pytest.fail('Direct start must not send a separate paid availability ping')
    monkeypatch.setattr(server, '_validated_target_or_400', validated)
    monkeypatch.setattr(server, 'probe_model_alive', forbidden)
    monkeypatch.setattr(server, '_enforce_rate_limit', lambda *args, **kwargs: None)
    async with client() as browser:
        response = await browser.post(endpoint, data={'base_url': 'https://relay.example/private/v1',
            'api_key': 'fixture-direct-key-not-real', 'model': model, 'mode': 'quick', 'wire_api': wire,
            'force': 'true', 'include_long_context': 'false', 'include_long_context_extreme': 'false'})
        assert response.status_code == 200
        job_id = response.json()['job_id']
        assert len(jobs._JOBS) == 1
        owner = browser.cookies.get('__Host-gewu_report_owner')
        assert report_access.owned(jobs.JOBS_DIR, job_id, owner)
        for _ in range(2):
            html = (await browser.get(f'/r/{job_id}')).text
            assert '检测进度与结果' in html and '逐项检测进度' in html
            assert 'data-endpoint=' not in html and 'fixture-direct-key-not-real' not in html
            assert 'running-config' in html
        assert len(jobs._JOBS) == 1, 'Reloading the second page must never queue another job'
        async with client(OTHER) as stranger:
            assert (await stranger.get(f'/r/{job_id}')).status_code == 404
        cancelled = await browser.post(f'/api/status/{job_id}/cancel')
        assert cancelled.status_code == 200 and not jobs._TASKS
        html = (await browser.get(f'/r/{job_id}')).text
        assert '逐项检测结果' in html and 'score-unavailable' in html
        for path in jobs.JOBS_DIR.rglob('*'):
            if path.is_file(): assert 'fixture-direct-key-not-real' not in path.read_text()


async def test_finished_report_prioritizes_summary_and_checks_without_unverified_identity_claims():
    private_job()
    async with client(OWNER) as browser:
        html = (await browser.get(f'/r/{JOB}')).text
        assert html.index('result-card detection-layout') < html.index('先看结论，再看证据')
        assert '逐项检测结果' in html and '接口域名' in html and '请求接口' in html
        assert 'check-description' in html and '重新检测' in html
        assert '近似官方' not in html and 'href="/#quick-check"' in html
        assert '协议质量分,不是模型真伪概率' in html
        assert 'data-endpoint=' not in html


async def test_invalid_report_warning_stays_above_summary_and_never_gets_a_valid_score():
    job = private_job()
    job.report['run_error'] = 'synthetic-invalid-report-warning'
    async with client(OWNER) as browser:
        html = (await browser.get(f'/r/{JOB}')).text
        assert html.index('synthetic-invalid-report-warning') < html.index('result-card detection-layout')
        assert 'score-unavailable' in html
        assert 'style="--score:0"' in html
        assert '<details class="card report-context">' in html


def test_shared_usage_keeps_missing_usage_warning_and_safe_request_count():
    original = sample_report()
    original['performance'].update(usage_complete=False, request_count=12)
    safe = report_access.summary_report(original)
    assert safe['performance']['usage_complete'] is False
    assert safe['performance']['request_count'] == 12
    for invalid in (True, -1, 'secret-request-metadata', float('inf')):
        original['performance']['request_count'] = invalid
        assert 'request_count' not in report_access.summary_report(original)['performance']

"""Ten independent Responses checks using synthetic traffic, never real credits."""
import asyncio
from copy import deepcopy
import json
import re

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from relay_detector.core.models import ExecutionConfig, Mode
from relay_detector.protocols.openai import build_detectors, build_runner, make_client
from relay_detector.protocols.openai.responses import MAX_OUTPUT_TOKENS, ResponsesClient
from relay_detector.protocols.openai.responses_extended import (
    EXTENDED_CHECK_COUNTS, EXTENDED_REQUEST_LIMITS, EXTENDED_PROBE_VERSION, EXTENDED_LABELS, valid_calls,
)
from tests.test_responses_detection import BASE, MODEL, Upstream, response, report
from web import jobs, server
from web.detection_scope import detection_scope
from web.ratelimit import reset as reset_rate


class ExtendedUpstream:
    def __init__(self, mutate=None):
        self.original = Upstream()
        self.requests = []
        self.kinds = []
        self.mutate = mutate or (lambda kind, value: value)
        self.context_output = None

    def __call__(self, request):
        assert str(request.url) == BASE + '/responses'
        body = json.loads(request.content)
        self.requests.append(body)
        assert body['model'] == MODEL and body['store'] is False
        assert body['max_output_tokens'] == MAX_OUTPUT_TOKENS
        assert 'previous_response_id' not in body
        content = body['input']
        tools = body.get('tools', [])
        names = [tool['name'] for tool in tools]
        if isinstance(content, list) and content[0].get('role') == 'developer':
            kind = 'instructions'
            marker = re.search(r'rule_[a-f0-9]+', content[0]['content'])[0]
            payload = response(marker)
        elif isinstance(content, list) and content[0].get('content', '').startswith('Remember this one-time marker'):
            if len(content) == 1:
                kind = 'context_first'
                assert body['include'] == ['reasoning.encrypted_content']
                payload = response('ACK')
                payload['output'].insert(0, {'type': 'reasoning', 'id': 'context_reasoning',
                    'summary': [], 'encrypted_content': 'fixture-private-context-reasoning'})
                self.context_output = deepcopy(payload['output'])
            else:
                kind = 'context_second'
                assert content[1:-1] == self.context_output
                marker = re.search(r'context_[a-f0-9]+', content[0]['content'])[0]
                assert marker not in content[-1]['content'], 'Marker must only be found in the previous turn'
                payload = response(marker)
        elif body.get('text', {}).get('format', {}).get('name') == 'gewu_nested':
            kind = 'nested'
            assert body['text']['format']['strict'] is True
            schema = body['text']['format']['schema']
            assert schema['additionalProperties'] is False
            assert schema['properties']['receipt']['additionalProperties'] is False
            nonce = re.search(r'nonce="([^"]+)"', content)[1]
            payload = response(json.dumps({'receipt': {'nonce': nonce, 'accepted': True},
                'items': [{'kind': 'alpha', 'count': 2}, {'kind': 'beta', 'count': 3}]}))
        elif 'gewu_selected' in names:
            kind = 'selection'
            assert body['tool_choice'] == {'type': 'function', 'name': 'gewu_selected'}
            assert body['parallel_tool_calls'] is False and len(tools) == 2
            nonce = re.search(r'nonce="([^"]+)"', content)[1]
            payload = response(output=[call('gewu_selected', nonce)])
        elif 'gewu_disabled' in names:
            kind = 'disabled'
            assert body['tool_choice'] == 'none'
            payload = response(re.search(r'plain_[a-f0-9]+', content)[0])
        elif 'gewu_first' in names:
            kind = 'parallel'
            assert body['parallel_tool_calls'] is True and body['tool_choice'] == 'required'
            nonces = re.findall(r'nonce="([^"]+)"', content)
            payload = response(output=[call(name, nonce, 'call_' + str(i)) for i, (name, nonce) in enumerate(zip(names, nonces))])
        else:
            self.kinds.append('core')
            return self.original(request)
        self.kinds.append(kind)
        return httpx.Response(200, json=self.mutate(kind, payload))


def call(name, nonce, identity='call_extended'):
    return {'type': 'function_call', 'call_id': identity, 'name': name,
            'status': 'completed', 'arguments': json.dumps({'nonce': nonce})}


async def run(upstream, mode=Mode.FULL, **overrides):
    config = ExecutionConfig.for_mode(mode, openai_wire_api='responses', responses_suite='extended')
    config = config.model_copy(update=overrides)
    async with make_client(BASE, 'synthetic-key', timeout=2, trust_env=False) as client:
        with respx.mock(assert_all_called=False) as mock:
            mock.route().mock(side_effect=upstream)
            before = set(asyncio.all_tasks())
            outcome = await build_runner(client, build_detectors(), config).run(MODEL)
            assert set(asyncio.all_tasks()) == before, 'Every owned detector task must end'
            return outcome


@pytest.mark.parametrize('mode,count,checks', [(Mode.QUICK, 2, 2), (Mode.STANDARD, 8, 6), (Mode.FULL, 12, 10)])
async def test_expanded_suite_real_requests_budget_usage_and_no_background_tasks(mode, count, checks):
    upstream = ExtendedUpstream()
    outcome = await run(upstream, mode)
    assert len(upstream.requests) == outcome.performance.request_count == count
    assert count == EXTENDED_REQUEST_LIMITS[mode]
    assert sum(row.status == 'pass' for row in outcome.results) == EXTENDED_CHECK_COUNTS[mode] == checks
    assert outcome.performance.backoff_events == 0
    assert outcome.performance.usage.input_tokens == count * 12
    assert outcome.performance.usage.output_tokens == count * 8
    assert outcome.performance.usage_complete is True
    assert all(row.status in {'pass', 'skip'} for row in outcome.results)
    rendered = json.dumps(report(outcome, mode))
    assert 'fixture-private-context-reasoning' not in rendered
    assert 'private-reasoning-fixture' not in rendered
    assert 'synthetic-key' not in rendered
    assert report(outcome, mode)['assessment']['score_usable']


@pytest.mark.parametrize('kind,name', [('instructions','responses_instructions'), ('context_second','responses_context'),
    ('nested','responses_nested_schema'), ('selection','responses_tool_selection'),
    ('disabled','responses_tool_disabled'), ('parallel','responses_parallel_tools')])
async def test_each_new_check_fails_on_canned_responses(kind, name):
    upstream = ExtendedUpstream(lambda stage, value: response('fixed canned answer') if stage == kind else value)
    outcome = await run(upstream)
    assert next(row for row in outcome.results if row.name == name).status == 'fail'
    assert outcome.performance.request_count <= 12


@pytest.mark.parametrize('mutation', ['extra-field', 'wrong-type', 'wrong-order', 'numeric-bool', 'wrong-nonce', 'markdown'])
async def test_nested_structure_rejects_imprecise_json(mutation):
    def mutate(kind, value):
        if kind != 'nested': return value
        text = value['output'][0]['content'][0]['text']
        obj = json.loads(text)
        if mutation == 'extra-field': obj['receipt']['extra'] = 'unrequested'
        elif mutation == 'wrong-type': obj['items'][0]['count'] = '2'
        elif mutation == 'wrong-order': obj['items'].reverse()
        elif mutation == 'numeric-bool': obj['receipt']['accepted'] = 1
        elif mutation == 'wrong-nonce': obj['receipt']['nonce'] = 'canned'
        output = '```json\n' + text + '\n```' if mutation == 'markdown' else json.dumps(obj)
        return response(output)
    outcome = await run(ExtendedUpstream(mutate))
    assert next(row for row in outcome.results if row.name == 'responses_nested_schema').status == 'fail'


@pytest.mark.parametrize('mutation', ['same-call-id', 'same-name', 'unknown-tool', 'extra-argument', 'wrong-nonce', 'one-only'])
async def test_two_tool_calls_must_be_distinct_and_have_exact_parameters(mutation):
    def mutate(kind, value):
        if kind != 'parallel': return value
        calls = value['output']
        if mutation == 'same-call-id': calls[1]['call_id'] = calls[0]['call_id']
        elif mutation == 'same-name': calls[1]['name'] = calls[0]['name']
        elif mutation == 'unknown-tool': calls[1]['name'] = 'run_arbitrary_command'
        elif mutation == 'extra-argument': calls[0]['arguments'] = '{"nonce":"synthetic", "command":"ignored"}'
        elif mutation == 'wrong-nonce': calls[0]['arguments'] = '{"nonce":"fixed"}'
        elif mutation == 'one-only': calls.pop()
        return value
    outcome = await run(ExtendedUpstream(mutate))
    assert next(row for row in outcome.results if row.name == 'responses_parallel_tools').status == 'fail'
    assert len(outcome.results) == 10


@pytest.mark.parametrize('bad', [None, {}, [], 1, 'unknown'])
def test_malformed_tool_name_cannot_crash_or_pass(bad):
    output = response(output=[call(bad, 'nonce')])
    assert valid_calls(output, {'gewu_selected': 'nonce'}) is False


async def test_late_auth_failure_halts_all_extra_calls_without_retry():
    upstream = ExtendedUpstream()
    def handler(request):
        body = json.loads(request.content)
        if isinstance(body['input'], list) and body['input'][0].get('role') == 'developer':
            upstream.requests.append(body)
            return httpx.Response(401, json={'error': {'message': 'invalid api key'}})
        return upstream(request)
    outcome = await run(handler)
    assert outcome.performance.request_count < 12
    assert not report(outcome)['assessment']['score_usable']


async def test_timeout_cancels_pending_extended_probes_and_closes_transport():
    upstream = ExtendedUpstream()
    async def slow(request):
        await asyncio.sleep(0.05)
        return upstream(request)
    outcome = await run(slow, overall_timeout_s=0.01)
    assert not report(outcome)['assessment']['score_usable']
    assert any(row.status == 'error' for row in outcome.results)


async def test_extended_budget_is_a_hard_cap():
    upstream = ExtendedUpstream()
    config = ExecutionConfig.for_mode(Mode.FULL, responses_suite='extended', openai_wire_api='responses')
    async with make_client(BASE, 'synthetic-key', timeout=2, trust_env=False) as base:
        client = ResponsesClient(base, 1)
        with respx.mock as mock:
            mock.route().mock(side_effect=upstream)
            await client.create(MODEL, input='Reply with exactly: first')
            with pytest.raises(ValueError, match='请求预算'):
                await client.create(MODEL, input='Reply with exactly: second')
    assert len(upstream.requests) == 1
    assert config.overall_timeout_s == 360


def test_scope_uses_the_same_extended_runner_and_has_no_borrowed_baseline(monkeypatch):
    monkeypatch.setattr('web.detection_scope.baseline_status', lambda *args: {'state': 'available', 'reference': 'old-core'})
    scope = detection_scope('openai', MODEL, 'full', 'responses', responses_suite='extended')
    assert len(scope['checks']) == 10
    assert {name for name, _ in EXTENDED_LABELS} <= {row['name'] for row in scope['checks']}
    assert scope['baseline']['state'] == 'missing'
    with pytest.raises(ValueError):
        detection_scope('gemini', 'gemini-test', 'full', 'generate_content', responses_suite='extended')


def test_api_explicit_consent_preserves_old_request_budget(monkeypatch):
    calls = []
    async def validate(value): return value
    async def submit(*args, **kwargs): calls.append(kwargs); return 'synthetic-job'
    monkeypatch.setattr(server, '_validated_target_or_400', validate)
    monkeypatch.setattr(server, '_submit_or_503', submit)
    monkeypatch.setattr(server, '_enforce_rate_limit', lambda *args, **kwargs: None)
    data = {'base_url': BASE, 'api_key': 'synthetic-key', 'model': MODEL, 'wire_api': 'responses', 'mode': 'full'}
    client = TestClient(server.app)
    assert client.post('/api/detect/openai', data=data).status_code == 200
    assert calls[-1]['responses_suite'] == 'core'
    assert client.post('/api/detect/openai', data={**data, 'responses_suite': 'extended'}).status_code == 200
    assert calls[-1]['responses_suite'] == 'extended'
    for extra in ({'responses_suite':'unexpected'}, {'responses_suite':'extended','wire_api':'chat_completions'}):
        assert client.post('/api/detect/openai', data={**data,**extra}).status_code == 400
    assert len(calls) == 2


async def test_saved_extended_report_renders_ten_checks_without_changing_legacy_reports(tmp_path, monkeypatch):
    job = jobs.Job(id='extended-job', protocol='openai', wire_api='responses', responses_suite='extended', target_model=MODEL)
    monkeypatch.setattr(jobs, 'JOBS_DIR', tmp_path)
    monkeypatch.setattr(jobs, '_JOBS', {job.id:job})
    with respx.mock as mock:
        mock.route().mock(side_effect=ExtendedUpstream())
        await jobs._run(job.id, BASE, 'synthetic-key', MODEL, 'full', 'openai', wire_api='responses')
    assert job.report['probe_version'] == EXTENDED_PROBE_VERSION
    assert job.report['assessment']['score_usable']
    assert len(server._result_rows(job.report)) == 10
    assert jobs._load_state(job.id).responses_suite == 'extended'
    assert '2 / 8 / 12' in server._report_notes(job.report)[0]['body']
    legacy = deepcopy(job.report); legacy['probe_version'] = '2026-10-12-calibration-1'
    legacy['results'] = legacy['results'][:4]
    assert len(server._result_rows(legacy)) == 4
    assert '2 / 3 / 5' in server._report_notes(legacy)[0]['body']
    for path in tmp_path.rglob('*'):
        if path.is_file():
            text = path.read_text()
            assert 'synthetic-key' not in text and 'private-context-reasoning' not in text


@pytest.mark.parametrize('suite,mode,count', [('core','full',4), ('extended','quick',2),
    ('extended','standard',6), ('extended','full',10)])
def test_scope_http_endpoint_reports_actual_selected_checks(suite, mode, count):
    client = TestClient(server.app)
    response = client.get('/api/status/detection-scope', params={
        'protocol':'openai', 'wire_api':'responses', 'model':MODEL, 'mode':mode, 'responses_suite':suite})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert len(response.json()['checks']) == count
    assert response.json()['capability_only']
    for extra in ({'responses_suite':'unknown'}, {'wire_api':'chat_completions','responses_suite':'extended'}):
        invalid = client.get('/api/status/detection-scope', params={
            'protocol':'openai', 'model':MODEL, 'mode':mode, **extra})
        assert invalid.status_code == 422


@pytest.mark.parametrize('kind', ['nested', 'selection', 'parallel'])
async def test_extended_strict_json_rejects_duplicate_object_fields(kind):
    def mutate(stage, value):
        if stage != kind: return value
        if stage == 'nested':
            part = value['output'][0]['content'][0]
            part['text'] = part['text'].replace('"nonce":', '"nonce":"wrong", "nonce":', 1)
        else:
            value['output'][0]['arguments'] = value['output'][0]['arguments'].replace(
                '"nonce":', '"nonce":"wrong", "nonce":', 1)
        return value
    outcome = await run(ExtendedUpstream(mutate))
    names = {'nested':'responses_nested_schema', 'selection':'responses_tool_selection', 'parallel':'responses_parallel_tools'}
    assert next(row for row in outcome.results if row.name == names[kind]).status == 'fail'


def test_legacy_saved_state_keeps_core_and_interrupted_extended_keeps_its_version(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, 'JOBS_DIR', tmp_path)
    legacy = jobs.Job(id='legacycore123', protocol='openai', wire_api='responses', status='cancelled')
    jobs._save_state(legacy)
    state = json.loads(jobs._state_path(legacy.id).read_text())
    state.pop('responses_suite')
    jobs._state_path(legacy.id).write_text(json.dumps(state))
    assert jobs._load_state(legacy.id).responses_suite == 'core'
    assert ExecutionConfig.for_mode(Mode.FULL).overall_timeout_s == 180
    extended = jobs.Job(id='interrupted123', protocol='openai', wire_api='responses', responses_suite='extended')
    jobs._finish_failure(extended, 'interrupted', 'synthetic interrupted run')
    assert extended.report['probe_version'] == EXTENDED_PROBE_VERSION
    assert not extended.report['assessment']['score_usable']
    assert len(server._result_rows(extended.report)) == 10


async def test_ten_check_private_share_and_jpg_paths_preserve_scope_and_privacy(tmp_path, monkeypatch):
    from io import BytesIO
    from PIL import Image
    from web import report_access
    from web.image_cache import ReportImageCache

    before = set(asyncio.all_tasks())
    owner = 'x' * 43  # synthetic ownership capability, not a real user session
    job = jobs.Job(id='expandedprivate123', protocol='openai', wire_api='responses',
        responses_suite='extended', target_model=MODEL, base_url=BASE, mode='full', access_version=1)
    monkeypatch.setattr(jobs, 'JOBS_DIR', tmp_path)
    monkeypatch.setattr(jobs, '_JOBS', {job.id:job})
    monkeypatch.setattr(jobs, '_SEMA', asyncio.Semaphore(1))
    monkeypatch.setattr(jobs, '_LOCK', asyncio.Lock())
    cache = ReportImageCache()
    monkeypatch.setattr(server, 'report_images', cache)
    report_access.create(tmp_path, job.id, owner)
    reset_rate()
    try:
        with respx.mock as mock:
            mock.route().mock(side_effect=ExtendedUpstream())
            await jobs._run(job.id, BASE, 'synthetic-key', MODEL, 'full', 'openai', wire_api='responses')
        assert job.status == 'done' and job.report['performance']['request_count'] == 12
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='https://testserver') as client:
            path = f'/r/{job.id}'
            assert (await client.get(path)).status_code == 404
            client.cookies.set(report_access.cookie_name(True), owner)
            private = await client.get(path)
            assert private.status_code == 200
            assert '本次实际发送 12 次模型请求' in private.text
            for _, label in EXTENDED_LABELS: assert label in private.text
            shared = await client.post(f'/api/status/{job.id}/share', headers={
                'X-Gewu-Action':'report-sharing', 'Origin':'https://testserver'})
            assert shared.status_code == 200
            share_path = shared.json()['url']
            client.cookies.clear()
            page = await client.get(share_path)
            assert page.status_code == 200
            for _, label in EXTENDED_LABELS: assert label in page.text
            assert '/custom/v1' not in page.text
            assert 'expected_nonce' not in page.text and 'encrypted_content' not in page.text
            image = await client.get(share_path + '.jpg')
            assert image.status_code == 200
            with Image.open(BytesIO(image.content)) as rendered:
                assert rendered.format == 'JPEG' and rendered.size == (1400, 1000)
            # Also exercise the private image endpoint with ownership restored.
            client.cookies.set(report_access.cookie_name(True), owner)
            assert (await client.get(path + '.jpg')).status_code == 200
        safe = report_access.summary_report(job.report)
        assert safe['probe_version'] == EXTENDED_PROBE_VERSION
        assert len(server._result_rows(safe)) == 10
        assert safe['performance']['request_count'] == 12
        assert 'synthetic-key' not in json.dumps(safe)
    finally:
        await cache.shutdown()
        assert not cache._tasks and not cache._active
    assert set(asyncio.all_tasks()) == before, 'No report or probe tasks may remain'

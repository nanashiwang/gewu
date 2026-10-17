"""Admission races, running-task drain, crash release; no network or paid probes."""
import asyncio
import fcntl
import os
from pathlib import Path
import subprocess
import sys

import httpx
import pytest
import pytest_asyncio

from web import deployment_gate as gate, jobs, server


@pytest_asyncio.fixture(autouse=True)
async def isolated(tmp_path, monkeypatch):
    directory = tmp_path / 'jobs'
    directory.mkdir()
    monkeypatch.setattr(jobs, 'JOBS_DIR', directory)
    monkeypatch.setattr(jobs, '_JOBS', {})
    monkeypatch.setattr(jobs, '_TASKS', {})
    monkeypatch.setattr(jobs, '_STOP_REASONS', {})
    monkeypatch.setattr(jobs, '_LOCK', asyncio.Lock())
    monkeypatch.setattr(jobs, '_ACCEPTING', True)
    yield directory
    await jobs.shutdown()
    assert not jobs._TASKS


def exclusive():
    path = gate.lock_path(jobs.JOBS_DIR)
    fd = os.open(path, os.O_CREAT | os.O_RDONLY, 0o644)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


@pytest.mark.asyncio
async def test_maintenance_rejects_all_submission_routes_before_credentials_or_network(monkeypatch):
    async def never(*a, **kw):
        pytest.fail('maintenance must reject before target validation or submission')
    monkeypatch.setattr(server, '_validated_target_or_400', never)
    monkeypatch.setattr(jobs, 'submit', never)
    fd = exclusive()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(server.app), base_url='https://test') as client:
            for path in ['/api/detect', '/api/detect/claude', '/api/detect/openai', '/api/detect/gemini', '/api/probe']:
                response = await client.post(path, content='not a valid form')
                assert response.status_code == 503
                assert response.headers['retry-after'] == '15'
                assert response.headers['cache-control'] == 'no-store'
            ready = await client.get('/readyz')
            assert ready.status_code == 200  # Service stays alive while draining.
            assert ready.json()['deployment'] == {'protocol': 1, 'accepting': False, 'pending_jobs': 0, 'active_tasks': 0}
            assert (await client.get('/')).status_code == 200
            assert (await client.get('/api/status/unknown01')).status_code == 404
            # Cancellation still reaches its normal ownership/not-found checks.
            assert (await client.post('/api/status/unknown01/cancel')).status_code != 503
    finally:
        os.close(fd)
    assert jobs.deployment_status()['accepting'] is True


@pytest.mark.asyncio
async def test_existing_job_finishes_without_cancellation_and_new_job_is_rejected(monkeypatch):
    started, finish = asyncio.Event(), asyncio.Event()
    async def run(job_id, *a):
        jobs._JOBS[job_id].status = 'running'
        started.set()
        await finish.wait()
        jobs._JOBS[job_id].status = 'done'
    monkeypatch.setattr(jobs, '_run', run)
    job_id = await jobs.submit('https://relay.example', 'fixture-key', 'model', 'quick')
    await started.wait()
    fd = exclusive()
    try:
        assert jobs.deployment_status()['active_tasks'] == 1
        with pytest.raises(gate.MaintenanceError):
            await jobs.submit('https://relay.example', 'fixture-key', 'model', 'quick')
        assert len(jobs._JOBS) == 1
        finish.set()
        await jobs._TASKS[job_id]
        await asyncio.sleep(0)
        assert jobs._JOBS[job_id].status == 'done'
        assert jobs.deployment_status()['active_tasks'] == 0
        assert jobs.deployment_status()['pending_jobs'] == 0
    finally:
        os.close(fd)
    assert jobs.deployment_status()['accepting'] is True


@pytest.mark.asyncio
async def test_drain_waits_for_upstream_cleanup_after_terminal_report(monkeypatch):
    release_cleanup = asyncio.Event()
    async def run(job_id, *a):
        jobs._JOBS[job_id].status = 'done'
        await release_cleanup.wait()
    monkeypatch.setattr(jobs, '_run', run)
    job_id = await jobs.submit('https://relay.example', 'fixture-key', 'model', 'quick')
    await asyncio.sleep(0)
    assert jobs.deployment_status()['pending_jobs'] == 0
    assert jobs.deployment_status()['active_tasks'] == 1
    release_cleanup.set()
    await jobs._TASKS[job_id]


@pytest.mark.asyncio
async def test_request_admission_covers_slow_validation_and_preflight():
    entered, finish = asyncio.Event(), asyncio.Event()
    async def request_app(scope, receive, send):
        entered.set()
        await finish.wait()
    middleware = server.DeploymentAdmissionMiddleware(request_app)
    task = asyncio.create_task(middleware({'type': 'http', 'method': 'POST', 'path': '/api/detect/openai'}, None, None))
    await entered.wait()
    fd = os.open(gate.lock_path(jobs.JOBS_DIR), os.O_RDONLY)
    try:
        with pytest.raises(BlockingIOError):
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finish.set()
        await task
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        finish.set()
        await task
        os.close(fd)


def test_deployer_crash_releases_admission_without_expiring_marker():
    path = gate.lock_path(jobs.JOBS_DIR)
    code = ('import fcntl,os,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDONLY,0o644); '
            'fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.readline()')
    child = subprocess.Popen([sys.executable, '-u', '-c', code, str(path)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        import select
        assert select.select([child.stdout], [], [], 10)[0]
        assert child.stdout.readline().strip() == 'locked'
        assert gate.accepting(jobs.JOBS_DIR) is False
        child.kill()
        child.wait(timeout=10)
        assert gate.accepting(jobs.JOBS_DIR) is True
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)
    assert child.poll() is not None


@pytest.mark.parametrize('kind', ['symlink', 'fifo', 'directory', 'hardlink'])
def test_invalid_lock_fails_closed_without_hanging(tmp_path, kind):
    path = gate.lock_path(jobs.JOBS_DIR)
    if kind == 'symlink':
        path.symlink_to(tmp_path / 'unrelated')
    elif kind == 'fifo':
        os.mkfifo(path)
    elif kind == 'directory':
        path.mkdir()
    else:
        target = tmp_path / 'unrelated'
        target.write_text('keep')
        os.link(target, path)
    assert gate.accepting(jobs.JOBS_DIR) is False
    with pytest.raises(gate.MaintenanceError):
        with gate.admission(jobs.JOBS_DIR):
            pytest.fail('must not admit work')

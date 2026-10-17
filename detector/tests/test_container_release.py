"""Adversarial checks for production migration and narrowly scoped cleanup."""
from __future__ import annotations

from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

import pytest

SPEC = importlib.util.spec_from_file_location('container_release', Path(__file__).parents[1] / 'deploy/container_release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
REVISION = 'a' * 40


def manifest():
    return {'revision': REVISION, 'platform': 'linux/amd64',
            'image_id': 'sha256:' + 'b' * 64, 'archive_sha256': 'c' * 64,
            'image': release.IMAGE + '@sha256:' + 'd' * 64}


@pytest.mark.parametrize('field,value', [
    ('revision', 'main'), ('revision', 'b' * 40), ('platform', 'linux/arm64'),
    ('image_id', 'latest'), ('archive_sha256', '../file'),
    ('image', 'evil.example/image@sha256:' + 'd' * 64),
    ('image', release.IMAGE + ':latest'),
])
def test_release_rejects_wrong_revision_digest_or_registry(field, value):
    data = manifest()
    data[field] = value
    with pytest.raises(release.DeploymentError):
        release.validate_manifest(data, REVISION)


@pytest.mark.parametrize('revision', ['main', '../etc', '/etc', 'a' * 39, 'a' * 41])
def test_revision_validated_before_any_filesystem_or_service_action(monkeypatch, revision):
    monkeypatch.setattr(release, 'preflight', lambda: pytest.fail('must not touch service'))
    with pytest.raises(release.DeploymentError):
        release.deploy(revision)
    with pytest.raises(release.DeploymentError):
        release.acquire(revision)


def test_environment_values_never_enter_unit(monkeypatch):
    monkeypatch.setattr(release.shutil, 'which', lambda _: '/usr/bin/docker')
    names = release.env_names('GEWU_INTERNAL_API_TOKEN="secret with spaces"\nOPENAI_API_KEY=paid-secret\n')
    unit = release.unit_override('sha256:' + 'a' * 64, 987, 988, names)
    assert '--env GEWU_INTERNAL_API_TOKEN' in unit
    assert 'secret' not in unit and 'OPENAI_API_KEY' not in unit
    assert '--user 987:988' in unit and '--network host' in unit
    assert '--read-only' in unit and '--cap-drop ALL' in unit
    assert 'src=/opt/gewu-detector/data/baselines,dst=/opt/gewu-detector/data/baselines,readonly' in unit
    assert 'ExecStartPre=\n' in unit and 'ExecStart=\n' in unit


@pytest.mark.parametrize('content', [
    'GEWU_WISHLIST_PATH=/unmounted/report', 'GEWU_JOBS_DIR=/elsewhere',
    'GEWU_BASELINES_DIR=/private/baselines', 'GEWU_OPENAI_BASELINE_PATH=/private/data',
    'GEWU_SITE_URL=\\\nhttps://example.org',
])
def test_unmounted_or_multiline_settings_block_migration(content):
    with pytest.raises(release.DeploymentError):
        release.env_names(content)


def test_quoted_systemd_paths_supported():
    assert release.env_names('GEWU_WISHLIST_PATH="/opt/gewu-detector/web_data/wishlist.txt"') == {'GEWU_WISHLIST_PATH'}


def test_unit_rejects_specifier_injection(monkeypatch):
    monkeypatch.setattr(release.shutil, 'which', lambda _: '/usr/bin/docker')
    with pytest.raises(release.DeploymentError):
        release.unit_override('sha256:' + 'a' * 64, 1, 1, {'GEWU_X%H'})


def test_cleanup_preserves_recent_unknown_symlink_and_data(tmp_path):
    now = time.time()
    old = now - 60 * 86400
    def stage(name, stamp=old):
        p = tmp_path / name
        p.mkdir()
        (p / 'deployment-manifest.json').write_text(json.dumps({'before': 'a' * 40, 'after': 'b' * 40}))
        for x in [p / 'deployment-manifest.json', p]:
            os.utime(x, (stamp, stamp))
        return p
    safe = stage('20260101-old')
    recent = stage('20261016-recent', now)
    second = stage('20261015-keep', now - 86400)
    unknown = stage('not-a-deploy')
    symlink = stage('20260102-symlink')
    (symlink / 'report-link').symlink_to(recent)
    os.utime(symlink, (old, old))
    data = stage('20260103-data')
    (data / 'web_data').mkdir()
    os.utime(data, (old, old))
    changed = stage('20260104-used')
    (changed / 'recent-test.log').write_text('new')
    os.utime(changed, (old, old))
    candidates = release.cleanup_candidates(tmp_path, now)
    assert [x['path'] for x in candidates] == [str(safe)]
    assert all(p.exists() for p in [recent, second, unknown, symlink, data, changed, safe])


def test_cleanup_never_follows_symlink_root(tmp_path):
    real = tmp_path / 'real'
    real.mkdir()
    link = tmp_path / 'link'
    link.symlink_to(real)
    with pytest.raises(release.DeploymentError):
        release.cleanup_candidates(link)


def test_smoke_failure_removes_its_container(monkeypatch):
    removed = []
    monkeypatch.setattr(release, 'run', lambda *a, **k: None)
    monkeypatch.setattr(release, 'wait_health', lambda n: (_ for _ in ()).throw(RuntimeError('bad health')))
    monkeypatch.setattr(release, 'remove_owned', removed.append)
    monkeypatch.setattr(release, 'inspect', lambda n: None)
    with pytest.raises(RuntimeError, match='bad health'):
        release.smoke_image('test-image', 123, 456)
    assert removed == [release.SMOKE]


def test_unrelated_container_is_never_removed(monkeypatch):
    monkeypatch.setattr(release, 'inspect', lambda n: {'Config': {'Labels': {'owner': 'another-project'}}})
    monkeypatch.setattr(release, 'run', lambda *a, **k: pytest.fail('must not remove unrelated container'))
    with pytest.raises(release.DeploymentError):
        release.remove_owned(release.SMOKE)


def test_protected_comparison_allows_new_reports_but_rejects_changed_evidence(monkeypatch):
    before = {'files': {'config': 'hash'}, 'reports': {'old': 'hash'},
              'containers': {'other': ('id', 'time')}, 'account_release': 'same'}
    after = {**before, 'reports': {'old': 'hash', 'new': 'newhash'}}
    monkeypatch.setattr(release, 'protected_snapshot', lambda: after)
    release.verify_protected(before)
    after['reports']['old'] = 'modified'
    with pytest.raises(release.DeploymentError):
        release.verify_protected(before)


def test_failed_cutover_restores_previous_service(monkeypatch, tmp_path):
    root = tmp_path / 'root'
    root.mkdir()
    monkeypatch.setattr(release, 'ROOT', root)
    monkeypatch.setattr(release, 'BACKUPS', tmp_path / 'backups')
    monkeypatch.setattr(release, 'DROPIN', tmp_path / '50-container.conf')
    monkeypatch.setattr(release, 'STATE', root / 'state.json')
    monkeypatch.setattr(release, 'preflight', lambda **kw: (123, 456, set()))
    monkeypatch.setattr(release, 'resource_limits', lambda **kw: {'cpus': '1', 'memory_mib': 512})
    monkeypatch.setattr(release, 'verify_resource_limits', lambda *a, **kw: None)
    monkeypatch.setattr(release, 'deployment_window', lambda **kw: nullcontext(False))
    monkeypatch.setattr(release, 'ready_state', lambda: {'deployment': {'protocol': 1, 'accepting': release.STATE.exists()}})
    monkeypatch.setattr(release, 'healthy_service', lambda: None)
    monkeypatch.setattr(release, 'protected_snapshot', lambda: {})
    monkeypatch.setattr(release, 'acquire', lambda r: {**manifest(), 'runtime_image_id': 'sha256:' + 'e' * 64})
    monkeypatch.setattr(release, 'smoke_image', lambda *a, **kw: None)
    monkeypatch.setattr(release, 'remove_owned', lambda n: None)
    monkeypatch.setattr(release, 'idle', lambda: None)
    monkeypatch.setattr(release, 'run', lambda *a, **k: None)
    monkeypatch.setattr(release, 'unit_override', lambda *a, **kw: 'new unit')
    monkeypatch.setattr(release, 'wait_health', lambda n: (_ for _ in ()).throw(RuntimeError('not healthy')))
    restored = []
    monkeypatch.setattr(release, 'restore', restored.append)
    with pytest.raises(RuntimeError, match='not healthy'):
        release.deploy(REVISION)
    assert len(restored) == 1
    data = json.loads((restored[0] / 'rollback.json').read_text())
    assert data == {'dropin': None, 'state': None}


def test_baseline_directory_explicit_container_setting(tmp_path):
    env = {**os.environ, 'GEWU_BASELINES_DIR': str(tmp_path)}
    result = subprocess.run([os.sys.executable, '-c', 'from relay_detector.baselines import ROOT; print(ROOT)'],
                            env=env, text=True, capture_output=True, check=True)
    assert result.stdout.strip() == str(tmp_path)


def test_rollback_catches_container_created_after_service_stop(monkeypatch):
    observations = iter([None, {'Config': {'Labels': {'org.gewu.component': 'detector'}}},
                         None, None, None, None])
    monkeypatch.setattr(release, 'inspect', lambda name: next(observations))
    monkeypatch.setattr(release.time, 'sleep', lambda _: None)
    removed = []
    monkeypatch.setattr(release, 'remove_owned', removed.append)
    release.settle_stopped_container()
    assert removed == [release.NAME]


def image_info(runtime_id=None):
    data = manifest()
    return {'Id': runtime_id or data['image_id'], 'RepoDigests': [data['image']],
            'Os': 'linux', 'Architecture': 'amd64',
            'Config': {'Labels': {'org.opencontainers.image.revision': REVISION,
                                  'org.opencontainers.image.source': f'https://github.com/{release.REPO}'}}}


def setup_acquisition(monkeypatch, tmp_path, responses, data=None):
    data = data or manifest()
    directory = tmp_path / REVISION
    directory.mkdir()
    (directory / 'release.json').write_text(json.dumps(data))
    monkeypatch.setattr(release, 'RELEASES', tmp_path)
    calls = []
    pending = iter(responses)
    def fake_run(*args, **kwargs):
        calls.append(args)
        expected, code, info = next(pending)
        assert args == expected
        output = info if isinstance(info, str) else json.dumps([info]) if info else ''
        result = subprocess.CompletedProcess(args, code, output, 'secret stderr')
        if code and kwargs.get('check', True):
            raise release.DeploymentError('expected command failure')
        return result
    monkeypatch.setattr(release, 'run', fake_run)
    monkeypatch.setattr(release, 'download', lambda *a: pytest.fail('unexpected download'))
    return calls, directory


@pytest.mark.parametrize('runtime_id', [manifest()['image_id'], 'sha256:' + 'd' * 64])
@pytest.mark.parametrize('cached', [True, False])
def test_acquire_registry_digest_works_across_image_stores(monkeypatch, tmp_path, runtime_id, cached):
    data = manifest()
    responses = [] if cached else [
        (('docker', 'image', 'inspect', data['image']), 1, None),
        (('docker', 'image', 'inspect', data['image_id']), 1, None),
        (('docker', 'pull', data['image']), 0, None),
    ]
    responses.append((('docker', 'image', 'inspect', data['image']), 0, image_info(runtime_id)))
    calls, _ = setup_acquisition(monkeypatch, tmp_path, responses)
    actual = release.acquire(REVISION)
    assert actual == {**data, 'runtime_image_id': runtime_id}
    assert len(calls) == len(responses)
    assert not any('load' in call for call in calls)


def test_acquire_cached_publisher_id_does_not_need_network(monkeypatch, tmp_path):
    data = manifest()
    info = image_info()
    info['RepoDigests'] = []
    calls, _ = setup_acquisition(monkeypatch, tmp_path, [
        (('docker', 'image', 'inspect', data['image']), 1, None),
        (('docker', 'image', 'inspect', data['image_id']), 0, info),
    ])
    assert release.acquire(REVISION)['runtime_image_id'] == data['image_id']
    assert len(calls) == 2


@pytest.mark.parametrize('runtime_id', [manifest()['image_id'], 'sha256:' + 'e' * 64])
def test_archive_fallback_loads_checked_bytes_before_resolving_tag(monkeypatch, tmp_path, runtime_id):
    import hashlib
    archive_bytes = b'checksum-covered fixture'
    data = {**manifest(), 'archive_sha256': hashlib.sha256(archive_bytes).hexdigest()}
    archive = tmp_path / REVISION / 'detector-image.tar.gz'
    info = image_info(runtime_id)
    info['RepoDigests'] = []  # docker save/load need not retain registry digests.
    responses = [
        (('docker', 'image', 'inspect', data['image']), 1, None),
        (('docker', 'image', 'inspect', data['image_id']), 1, None),
        (('docker', 'pull', data['image']), 1, None),
        (('docker', 'load', '--input', str(archive)), 0, f'Loaded image: {release.IMAGE}:{REVISION}\n'),
        (('docker', 'image', 'inspect', f'{release.IMAGE}:{REVISION}'), 0, info),
    ]
    calls, _ = setup_acquisition(monkeypatch, tmp_path, responses, data)
    archive.write_bytes(archive_bytes)
    assert release.acquire(REVISION)['runtime_image_id'] == runtime_id
    assert len(calls) == 5


def test_corrupt_archive_never_loaded(monkeypatch, tmp_path):
    data = manifest()
    responses = [
        (('docker', 'image', 'inspect', data['image']), 1, None),
        (('docker', 'image', 'inspect', data['image_id']), 1, None),
        (('docker', 'pull', data['image']), 1, None),
    ]
    calls, directory = setup_acquisition(monkeypatch, tmp_path, responses)
    (directory / 'detector-image.tar.gz').write_bytes(b'corrupt cache')
    def corrupt_download(url, path, limit):
        assert not path.exists()
        path.write_bytes(b'corrupt download')
    monkeypatch.setattr(release, 'download', corrupt_download)
    with pytest.raises(release.DeploymentError, match='archive checksum mismatch'):
        release.acquire(REVISION)
    assert len(calls) == 3


@pytest.mark.parametrize('field,value,error', [
    ('RepoDigests', [], 'registry digest mismatch'),
    ('RepoDigests', [release.IMAGE + '@sha256:' + 'e' * 64], 'registry digest mismatch'),
    ('Id', 'latest', 'resolved image ID'),
    ('Architecture', 'arm64', 'platform mismatch'),
    ('Os', 'windows', 'platform mismatch'),
    ('Config', {'Labels': {'org.opencontainers.image.revision': 'f' * 40}}, 'commit label mismatch'),
    ('Config', {'Labels': {'org.opencontainers.image.revision': REVISION}}, 'source label mismatch'),
])
def test_registry_identity_is_not_weakened(monkeypatch, tmp_path, field, value, error):
    info = image_info()
    info[field] = value
    setup_acquisition(monkeypatch, tmp_path, [
        (('docker', 'image', 'inspect', manifest()['image']), 0, info),
    ])
    with pytest.raises(release.DeploymentError, match=error):
        release.acquire(REVISION)


def test_cached_id_mismatch_rejected(monkeypatch, tmp_path):
    data = manifest()
    setup_acquisition(monkeypatch, tmp_path, [
        (('docker', 'image', 'inspect', data['image']), 1, None),
        (('docker', 'image', 'inspect', data['image_id']), 0, image_info('sha256:' + 'e' * 64)),
    ])
    with pytest.raises(release.DeploymentError, match='Cached image ID mismatch'):
        release.acquire(REVISION)


@pytest.mark.parametrize('timeout', [False, True])
def test_command_failures_name_operation_but_never_disclose_arguments(monkeypatch, timeout):
    def fail(args, **kwargs):
        if timeout:
            raise subprocess.TimeoutExpired(args, 3, output='secret-output', stderr='secret-error')
        return subprocess.CompletedProcess(args, 7, 'secret-output', 'secret-error')
    monkeypatch.setattr(release.subprocess, 'run', fail)
    with pytest.raises(release.DeploymentError) as captured:
        release.run('docker', 'image', 'inspect', 'secret-argument', timeout=3)
    assert str(captured.value) == ('docker image inspect timed out after 3s' if timeout
                                   else 'docker image inspect failed (exit 7)')


def test_archive_must_confirm_overwriting_expected_tag(monkeypatch, tmp_path):
    import hashlib
    data = {**manifest(), 'archive_sha256': hashlib.sha256(b'fixture').hexdigest()}
    archive = tmp_path / REVISION / 'detector-image.tar.gz'
    responses = [
        (('docker', 'image', 'inspect', data['image']), 1, None),
        (('docker', 'image', 'inspect', data['image_id']), 1, None),
        (('docker', 'pull', data['image']), 1, None),
        (('docker', 'load', '--input', str(archive)), 0, 'Loaded image: unrelated:latest'),
    ]
    calls, _ = setup_acquisition(monkeypatch, tmp_path, responses, data)
    archive.write_bytes(b'fixture')
    with pytest.raises(release.DeploymentError, match='did not load the expected revision tag'):
        release.acquire(REVISION)
    assert len(calls) == 4  # Never inspect/trust a possibly stale revision tag.


def test_deploy_uses_resolved_id_everywhere_and_preserves_publisher_id(monkeypatch, tmp_path):
    runtime_id = 'sha256:' + 'e' * 64
    data = {**manifest(), 'runtime_image_id': runtime_id}
    for name, path in [('ROOT', tmp_path), ('BACKUPS', tmp_path / 'backups'),
                       ('DROPIN', tmp_path / '50-container.conf'), ('STATE', tmp_path / 'state.json')]:
        monkeypatch.setattr(release, name, path)
    monkeypatch.setattr(release, 'preflight', lambda **kw: (123, 456, set()))
    monkeypatch.setattr(release, 'resource_limits', lambda **kw: {'cpus': '1', 'memory_mib': 512})
    monkeypatch.setattr(release, 'verify_resource_limits', lambda *a, **kw: None)
    monkeypatch.setattr(release, 'deployment_window', lambda **kw: nullcontext(False))
    monkeypatch.setattr(release, 'ready_state', lambda: {'deployment': {'protocol': 1, 'accepting': release.STATE.exists()}})
    monkeypatch.setattr(release, 'healthy_service', lambda: None)
    monkeypatch.setattr(release, 'protected_snapshot', lambda: {})
    monkeypatch.setattr(release, 'verify_protected', lambda _: None)
    monkeypatch.setattr(release, 'acquire', lambda _: data)
    seen = []
    monkeypatch.setattr(release, 'smoke_image', lambda image, *a, **kw: seen.append(image))
    monkeypatch.setattr(release, 'base_args', lambda name, image, *a, **kw: seen.append(image) or ['docker', 'run'])
    monkeypatch.setattr(release, 'unit_override', lambda image, *a, **kw: seen.append(image) or 'unit')
    monkeypatch.setattr(release, 'remove_owned', lambda _: None)
    monkeypatch.setattr(release, 'inspect', lambda _: None)
    monkeypatch.setattr(release, 'idle', lambda: None)
    monkeypatch.setattr(release, 'wait_health', lambda _: None)
    calls = []
    monkeypatch.setattr(release, 'run', lambda *a, **k: calls.append(a))
    release.deploy(REVISION)
    assert seen == [runtime_id] * 3
    assert calls[0][4] == runtime_id  # Actual volume-probe command image.
    state = json.loads(release.STATE.read_text())
    assert state['image_id'] == manifest()['image_id']
    assert state['runtime_image_id'] == runtime_id


def test_rollback_waits_for_systemd_stop_phases_before_restoring(monkeypatch, tmp_path):
    backup = tmp_path / 'backup'
    backup.mkdir()
    (backup / 'rollback.json').write_text(json.dumps({'dropin': None, 'state': None}))
    monkeypatch.setattr(release, 'BACKUPS', tmp_path)
    monkeypatch.setattr(release, 'DROPIN', tmp_path / 'override.conf')
    monkeypatch.setattr(release, 'STATE', tmp_path / 'state.json')
    calls = []
    monkeypatch.setattr(release, 'run', lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(release, 'settle_stopped_container', lambda: None)
    monkeypatch.setattr(release, 'healthy_service', lambda: None)
    release.restore(backup)
    assert calls[0] == (('systemctl', 'stop', 'gewu.service'), {'timeout': release.STOP_TIMEOUT})
    assert release.STOP_TIMEOUT > 2 * 60  # ExecStop and main-process termination.
    assert calls[-1][0] == ('systemctl', 'start', 'gewu.service')


def gate_fixture(monkeypatch, tmp_path, states):
    (tmp_path / 'web_data').mkdir()
    monkeypatch.setattr(release, 'ROOT', tmp_path)
    stream = iter(states)
    monkeypatch.setattr(release, 'ready_state', lambda: {'deployment': next(stream)})
    monkeypatch.setattr(release, 'monitor_idle', lambda: True)
    monkeypatch.setattr(release.time, 'sleep', lambda _: None)
    return tmp_path / 'web_data/.gewu-deployment.lock'


def assert_gate_released(path):
    import fcntl
    with path.open('rb') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)


def test_drain_waits_for_jobs_and_cleanup_before_cutover(monkeypatch, tmp_path):
    open_state = {'protocol': 1, 'accepting': True}
    states = [open_state, {'protocol': 1, 'accepting': False, 'pending_jobs': 1, 'active_tasks': 1},
              {'protocol': 1, 'accepting': False, 'pending_jobs': 0, 'active_tasks': 1},
              {'protocol': 1, 'accepting': False, 'pending_jobs': 0, 'active_tasks': 0}]
    path = gate_fixture(monkeypatch, tmp_path, states)
    with release.deployment_window() as gated:
        assert gated
        import fcntl
        with path.open('rb') as lock:
            with pytest.raises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
    assert_gate_released(path)


@pytest.mark.parametrize('failure', ['timeout', 'ack', 'bad_counts', 'cutover'])
def test_failed_drain_or_cutover_always_reopens_admission(monkeypatch, tmp_path, failure):
    state = {'protocol': 1, 'accepting': failure == 'ack', 'pending_jobs': 0,
             'active_tasks': 1 if failure == 'timeout' else 'invalid' if failure == 'bad_counts' else 0}
    path = gate_fixture(monkeypatch, tmp_path, [{'protocol': 1}, state])
    with pytest.raises((release.DeploymentError, RuntimeError)):
        with release.deployment_window(wait_seconds=0):
            assert failure == 'cutover'
            raise RuntimeError('cutover failed')
    assert_gate_released(path)


def test_legacy_service_requires_explicit_bootstrap_and_idle_check(monkeypatch, tmp_path):
    (tmp_path / 'web_data').mkdir()
    monkeypatch.setattr(release, 'ROOT', tmp_path)
    monkeypatch.setattr(release, 'ready_state', lambda: {'ok': True})
    checked = []
    monkeypatch.setattr(release, 'idle', lambda: checked.append(True))
    with pytest.raises(release.DeploymentError, match='bootstrap-drain'):
        with release.deployment_window():
            pytest.fail('must not change old service')
    assert not checked
    with release.deployment_window(bootstrap=True) as gated:
        assert gated is False
        import fcntl
        with (tmp_path / 'web_data/.gewu-deployment.lock').open('rb') as lock:
            with pytest.raises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
    assert checked == [True]


def test_scheduled_monitor_prevents_cutover(monkeypatch, tmp_path):
    path = gate_fixture(monkeypatch, tmp_path, [
        {'protocol': 1}, {'protocol': 1, 'accepting': False, 'pending_jobs': 0, 'active_tasks': 0}])
    monkeypatch.setattr(release, 'monitor_idle', lambda: False)
    with pytest.raises(release.DeploymentError, match='timed out'):
        with release.deployment_window(wait_seconds=0):
            pytest.fail('monitor still running')
    assert_gate_released(path)


def host_resources(monkeypatch, memory_mib=4096, available_mib=2048, cpus=2, peak_mib=None):
    original = Path.read_text
    def read(path, *a, **k):
        if str(path) == '/proc/meminfo':
            return f'MemTotal: {memory_mib * 1024} kB\nMemAvailable: {available_mib * 1024} kB\n'
        return original(path, *a, **k)
    monkeypatch.setattr(Path, 'read_text', read)
    monkeypatch.setattr(release.os, 'cpu_count', lambda: cpus)
    monkeypatch.setattr(release, 'inspect', lambda name: None if peak_mib is None else {
        'Config': {'Labels': {'org.gewu.component': 'detector'}}, 'State': {'Running': True}})
    monkeypatch.setattr(release, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 0, str(int((peak_mib or 0) * 1024**2)), ''))


def test_resource_defaults_preserve_shared_host_headroom(monkeypatch):
    host_resources(monkeypatch, cpus=1)
    assert release.resource_limits() == {'cpus': '0.5', 'memory_mib': 512}
    host_resources(monkeypatch, peak_mib=400)
    assert release.resource_limits() == {'cpus': '1', 'memory_mib': 640}


@pytest.mark.parametrize('overrides,host', [
    ({'cpus': float('nan')}, {}), ({'cpus': 2}, {'cpus': 2}),
    ({'memory_mib': 256}, {}), ({'memory_mib': 3000}, {}),
    ({}, {'available_mib': 191}), ({}, {'available_mib': 600}), ({}, {'memory_mib': 1024}),
    ({}, {'peak_mib': 800}), ({'memory_mib': 512}, {'peak_mib': 400}),
])
def test_resource_budget_rejects_pressure_and_unsafe_overrides(monkeypatch, overrides, host):
    host_resources(monkeypatch, **host)
    with pytest.raises(release.DeploymentError):
        release.resource_limits(**overrides)


def test_explicit_memory_review_can_fit_observed_peak(monkeypatch):
    host_resources(monkeypatch, peak_mib=800)
    assert release.resource_limits(memory_mib=1280)['memory_mib'] == 1280


def test_resource_limits_apply_to_smoke_probe_and_service(monkeypatch):
    limits = {'cpus': '0.5', 'memory_mib': 768}
    for smoke in [True, False]:
        args = release.base_args(release.SMOKE, 'image', 123, 456, smoke=smoke, limits=limits)
        for option, value in [('--cpus', '0.5'), ('--memory', '768m'), ('--memory-swap', '768m')]:
            assert args[args.index(option) + 1] == value
    monkeypatch.setattr(release.shutil, 'which', lambda _: '/usr/bin/docker')
    unit = release.unit_override('sha256:' + 'a' * 64, 123, 456, set(), limits=limits)
    assert '--cpus 0.5 --memory 768m --memory-swap 768m' in unit
    assert 'docker.service' in unit


@pytest.mark.parametrize('wrong', ['Memory', 'MemorySwap', 'NanoCpus', 'OOMKilled', None])
def test_actual_docker_limits_are_verified(monkeypatch, wrong):
    config = {'Memory': 512 * 1024**2, 'MemorySwap': 512 * 1024**2, 'NanoCpus': 10**9}
    state = {'OOMKilled': wrong == 'OOMKilled'}
    if wrong in config:
        config[wrong] = 0
    monkeypatch.setattr(release, 'inspect', lambda name: {
        'Config': {'Labels': {'org.gewu.component': 'detector'}},
        'HostConfig': config, 'State': state})
    if wrong is not None:
        with pytest.raises(release.DeploymentError):
            release.verify_resource_limits(release.NAME, {'cpus': '1', 'memory_mib': 512})
    else:
        release.verify_resource_limits(release.NAME, {'cpus': '1', 'memory_mib': 512})

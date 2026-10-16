"""Adversarial checks for production migration and narrowly scoped cleanup."""
from __future__ import annotations

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
    monkeypatch.setattr(release, 'preflight', lambda: (123, 456, set()))
    monkeypatch.setattr(release, 'healthy_service', lambda: None)
    monkeypatch.setattr(release, 'protected_snapshot', lambda: {})
    monkeypatch.setattr(release, 'acquire', lambda r: manifest())
    monkeypatch.setattr(release, 'smoke_image', lambda *a: None)
    monkeypatch.setattr(release, 'remove_owned', lambda n: None)
    monkeypatch.setattr(release, 'idle', lambda: None)
    monkeypatch.setattr(release, 'run', lambda *a, **k: None)
    monkeypatch.setattr(release, 'unit_override', lambda *a: 'new unit')
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

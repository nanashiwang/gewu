"""Adversarial paired deployment guards; no local Docker or live data access."""
from contextlib import contextmanager
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest

SPEC = importlib.util.spec_from_file_location('platform_release', Path(__file__).parents[2] / 'deploy/platform/container_release.py')
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)
REV = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
OLD_IMAGE = 'sha256:' + 'c' * 64


def result(stdout='', code=0):
    return SimpleNamespace(stdout=stdout, returncode=code)


def app():
    return {'Name': '/gewu-app', 'Id': 'original-container', 'Image': OLD_IMAGE,
            'State': {'Running': True, 'StartedAt': 'same', 'Status': 'running'},
            'Config': {'Env': ['NODE_ENV=production', 'PAYLOAD_SECRET=fixture$secret$$keep', 'NODE_VERSION=22.old'],
                       'Cmd': ['node', 'server.js'], 'Entrypoint': ['docker-entrypoint.sh'], 'User': 'nextjs', 'WorkingDir': '/app',
                       'Labels': {'com.docker.compose.project': p.PROJECT, 'com.docker.compose.service': 'app', 'com.docker.compose.config-hash': 'original-hash'}},
            'HostConfig': {'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8787'}]},
                           'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}, 'Memory': 0, 'MemorySwap': 0,
                           'NanoCpus': 0, 'PidsLimit': None, 'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m'}}},
            'NetworkSettings': {'Networks': {'gewu-platform_default': {}}},
            'Mounts': [{'Type': 'volume', 'Name': 'gewu-platform_mediadata', 'Source': '/fixture/media', 'Destination': '/app/media', 'RW': True}]}


def config():
    return {'name': p.PROJECT, 'services': {'app': {'image': 'legacy:fixture', 'build': {'context': '/old/source'},
             'environment': {'PAYLOAD_SECRET': 'fixture$secret$$keep'}, 'volumes': [{'source': 'mediadata', 'target': '/app/media', 'type': 'volume'}]},
             'postgres': {'image': 'original-postgres'}, 'redis': {'image': 'original-redis'}, 'migrate': {'build': '/original'}},
            'volumes': {'mediadata': {'name': 'gewu-platform_mediadata'}}, 'networks': {'default': {'name': 'gewu-platform_default'}}}


@pytest.mark.parametrize('revision', ['main', '../other-project', 'a'*39, 'a'*41, '/tmp/script'])
def test_invalid_revision_never_reads_or_changes_services(monkeypatch, revision):
    monkeypatch.setattr(p, 'preflight', lambda: pytest.fail('must validate before server access'))
    with pytest.raises(p.ReleaseError):
        p.deploy(revision)


def test_pinned_compose_preserves_effective_env_volumes_and_other_services():
    original = config()
    updated = p.pinned(original, app(), IMAGE)
    assert updated['services']['app']['image'] == IMAGE
    assert 'build' not in updated['services']['app']
    assert updated['services']['app']['environment']['PAYLOAD_SECRET'] == 'fixture$secret$$keep'
    assert updated['services']['app']['environment']['NODE_ENV'] == 'production'
    assert 'NODE_VERSION' not in updated['services']['app']['environment']
    for service in ('postgres', 'redis', 'migrate'):
        assert updated['services'][service] == original['services'][service]
    assert updated['volumes'] == original['volumes']
    assert original['services']['app']['image'] == 'legacy:fixture'


def test_json_serialization_does_not_break_runtime_rollback_comparison():
    signature = p.runtime_signature(app())
    assert signature == json.loads(json.dumps(signature))
    changed = app()
    changed['Config']['Env'][1] = 'PAYLOAD_SECRET=changed'
    assert p.runtime_signature(changed) != signature
    changed = app()
    changed['Mounts'][0]['Name'] = 'other-project-media'
    assert p.runtime_signature(changed) != signature


def test_compose_dollars_are_escaped_once_and_not_printed(tmp_path, capsys):
    path = tmp_path / 'compose.json'
    p.write_config(path, config())
    text = path.read_text()
    assert 'fixture$$secret$$$$keep' in text
    assert json.loads(text.replace('$$', '$')) == config()
    assert path.stat().st_mode & 0o777 == 0o600
    assert not capsys.readouterr().out


def test_two_saved_compose_files_and_recorded_directory_are_used(monkeypatch, tmp_path):
    monkeypatch.setattr(p, 'ROOT', tmp_path)
    monkeypatch.setattr(p, 'STORE', tmp_path / 'releases')
    monkeypatch.setattr(p, 'BACKUPS', tmp_path / 'backups')
    work = tmp_path / 'legacy'
    work.mkdir()
    files = [work / 'docker-compose.yml', work / 'compose.release.yml']
    for file in files: file.write_text('{}')
    (work / '.env').write_text('placeholder')
    item = app()
    item['Config']['Labels'].update({'com.docker.compose.project.config_files': ','.join(map(str, files)),
                                     'com.docker.compose.project.working_dir': str(work)})
    calls = []
    def run(*args, **kwargs):
        calls.append(args)
        if '--hash' in args: return result('app original-hash\n')
        return result(json.dumps(config()).replace('$', '$$'))
    monkeypatch.setattr(p, 'run', run)
    found, found_files, env = p.read_config(item)
    assert found == config() and found_files == files and env == work / '.env'
    assert all(str(work) in command and all(str(file) in command for file in files) for command in calls)


def test_wrong_saved_hash_fails_before_recreation(monkeypatch, tmp_path):
    monkeypatch.setattr(p, 'ROOT', tmp_path)
    file = tmp_path / 'compose.yml'; file.write_text('{}')
    item = app()
    item['Config']['Labels'].update({'com.docker.compose.project.config_files': str(file), 'com.docker.compose.project.working_dir': str(tmp_path)})
    monkeypatch.setattr(p, 'run', lambda *a, **kw: result('app different-hash\n'))
    with pytest.raises(p.ReleaseError, match='saved Compose'):
        p.read_config(item)


def test_paths_cannot_follow_symlinks_to_another_project(tmp_path):
    real = tmp_path / 'real'; real.mkdir()
    link = tmp_path / 'link'; link.symlink_to(real)
    with pytest.raises(p.ReleaseError): p.save(link / 'config.json', {'secret': 'never-written'})
    assert not (real / 'config.json').exists()


def test_schema_compatibility_allows_extras_but_not_missing_columns_or_enum_values():
    expected = {'version': 1, 'columns': [{'table_name': 'users', 'column_name': 'id', 'udt_name': 'uuid'}],
                'enums': [{'name': 'role', 'value': 'admin'}]}
    actual = {'columns': [*expected['columns'], {'table_name': 'other', 'column_name': 'note', 'udt_name': 'text'}], 'enums': expected['enums']}
    p.schema_compatible(expected, actual)
    for bad in [{'columns': [], 'enums': actual['enums']}, {'columns': actual['columns'], 'enums': []},
                {'columns': [{'table_name': 'users', 'column_name': 'id', 'udt_name': 'int4'}], 'enums': actual['enums']}]:
        with pytest.raises(p.ReleaseError): p.schema_compatible(expected, bad)


def test_dump_hash_ignores_only_generated_psql_tokens(tmp_path):
    a, b = tmp_path / 'a.sql', tmp_path / 'b.sql'
    a.write_bytes(b'\\restrict random-one\nCOPY private_data FROM stdin;\n1\tactual-data\n\\unrestrict random-one\n')
    b.write_bytes(b'\\restrict random-two\nCOPY private_data FROM stdin;\n1\tactual-data\n\\unrestrict random-two\n')
    assert p.dump_hash(a) == p.dump_hash(b)
    b.write_bytes(b'\\restrict random-two\nCOPY private_data FROM stdin;\n1\tchanged-data\n\\unrestrict random-two\n')
    assert p.dump_hash(a) != p.dump_hash(b)


def test_docker_errors_never_echo_environment_or_arguments(monkeypatch):
    def fail(*args, **kwargs):
        assert kwargs['env']['DOCKER_HOST'] == 'unix:///var/run/docker.sock'
        return result('private-output', 1)
    monkeypatch.setattr(p.subprocess, 'run', fail)
    with pytest.raises(p.ReleaseError) as caught:
        p.run('docker', 'exec', 'fixture-secret-in-argument')
    assert 'fixture-secret' not in str(caught.value) and 'private-output' not in str(caught.value)


def rollback_record(tmp_path, monkeypatch, *, gateway=False):
    backups = tmp_path / 'backups'; backups.mkdir()
    folder = backups / 'one'; folder.mkdir()
    monkeypatch.setattr(p, 'BACKUPS', backups)
    monkeypatch.setattr(p, 'STATE', tmp_path / 'state.json')
    previous = folder / 'previous.json'; p.write_config(previous, config())
    record = {'previous_config': str(previous), 'previous_image': OLD_IMAGE, 'previous_gateway': gateway,
              'previous_state': None, 'runtime': p.runtime_signature(app()), 'schema_before': 'same-schema'}
    p.save(folder / 'rollback.json', record)
    monkeypatch.setattr(p, 'source_schema_hash', lambda db: 'same-schema')
    monkeypatch.setattr(p, 'inspect', lambda name: app())
    monkeypatch.setattr(p, 'private_history', lambda db: False)
    monkeypatch.setattr(p, 'wait_health', lambda **kwargs: None)
    monkeypatch.setattr(p, 'image_id', lambda item: OLD_IMAGE)
    return folder, record


def test_private_records_block_a_legacy_account_downgrade_before_service_changes(monkeypatch, tmp_path):
    folder, _ = rollback_record(tmp_path, monkeypatch)
    monkeypatch.setattr(p, 'private_history', lambda db: True)
    monkeypatch.setattr(p, 'compose', lambda *a: pytest.fail('must not stop or replace application'))
    with pytest.raises(p.ReleaseError, match='private report history'):
        p.restore_account(folder, db={})


def test_changed_schema_blocks_rollback_without_restoring_live_database(monkeypatch, tmp_path):
    folder, _ = rollback_record(tmp_path, monkeypatch)
    monkeypatch.setattr(p, 'source_schema_hash', lambda db: 'different-schema')
    monkeypatch.setattr(p, 'compose', lambda *a: pytest.fail('must leave current app running'))
    with pytest.raises(p.ReleaseError, match='schema changed'):
        p.restore_account(folder, db={'known': True})


def test_rollback_recreates_only_app_and_never_starts_dependencies(monkeypatch, tmp_path):
    folder, _ = rollback_record(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(p, 'compose', lambda *a: calls.append(a))
    p.restore_account(folder, db={'known': True})
    assert len(calls) == 1 and calls[0][-1] == 'app'
    assert all(flag in calls[0] for flag in ('--no-deps', '--no-build', '--pull', 'never'))
    assert not p.STATE.exists()


def test_partial_creation_failure_can_restore_when_app_container_is_missing(monkeypatch, tmp_path):
    folder, _ = rollback_record(tmp_path, monkeypatch)
    sequence = iter([None, app()])
    monkeypatch.setattr(p, 'inspect', lambda name: next(sequence))
    monkeypatch.setattr(p, 'compose', lambda *a: None)
    p.restore_account(folder, db={'known': True})


@pytest.mark.parametrize('old_proven', [True, False])
def test_detector_failure_only_reverts_account_when_original_detector_is_proven(monkeypatch, tmp_path, old_proven):
    folder = tmp_path / 'backup'; folder.mkdir()
    record = {'detector_before': 'old-state', 'detector_image_before': OLD_IMAGE}
    p.save(folder / 'rollback.json', record)
    events = []
    @contextmanager
    def window(**kwargs):
        events.append('closed'); yield; events.append('open')
    def fail(*args): raise RuntimeError('injected detector failure')
    detector = SimpleNamespace(deploy=fail, deployment_window=window, STATE=tmp_path/'detector-state', BACKUPS=tmp_path/'detector-backups')
    monkeypatch.setattr(p, 'preflight', lambda: None)
    monkeypatch.setattr(p, 'release_bundle', lambda revision: ({}, {}, detector, Path('/fixture/script')))
    monkeypatch.setattr(p, 'deploy_account', lambda *args: (folder, {'db': 'fixture'}))
    monkeypatch.setattr(p, 'detector_is_previous', lambda *args: old_proven)
    monkeypatch.setattr(p, 'restore_account', lambda *args, **kwargs: events.append('restore-account'))
    with pytest.raises(RuntimeError, match='injected detector'):
        p.deploy(REV)
    assert events == (['closed', 'restore-account', 'open'] if old_proven else [])


def test_probe_cleanup_refuses_another_owner_and_never_claims_zero(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(p, 'PROBES', tmp_path)
    probe = p.Probe(); probe.__enter__()
    monkeypatch.setattr(p, 'inspect', lambda name: {'Id': 'another-container', 'Config': {'Labels': {p.PROBE_LABEL: 'different-owner'}}})
    calls=[]
    def run(*args, **kwargs):
        calls.append(args)
        return result('', 1) if args[:3] == ('docker','network','inspect') else result('another-container')
    monkeypatch.setattr(p, 'run', run)
    with pytest.raises(p.ReleaseError, match='cleanup failed'):
        probe.__exit__(None,None,None)
    assert not any(args[:3] == ('docker','rm','-f') for args in calls)
    assert 'LEFTOVER_TEST_CONTAINERS=0' not in capsys.readouterr().out

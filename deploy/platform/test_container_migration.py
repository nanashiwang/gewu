#!/usr/bin/env python3
"""Real acceptance only on a fresh GitHub-hosted runner, with synthetic data."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MARKER = Path('/tmp/gewu-platform-ci-owned.json')
CI_LABEL = 'org.gewu.paired-ci'
OLD_REVISION = '0' * 40


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


p = load(HERE / 'container_release.py', 'account_release')
r = load(REPO / 'detector/deploy/container_release.py', 'paired_detector_release')


def assert_ci():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.geteuid() == 0


def cleanup():
    assert_ci()
    if not MARKER.exists():
        return
    owner = json.loads(MARKER.read_text())['owner']
    r.run('systemctl', 'stop', 'gewu.service', timeout=r.STOP_TIMEOUT, check=False)
    r.settle_stopped_container()
    ids = p.run('docker', 'ps', '-aq', '--filter', f'label={CI_LABEL}={owner}').stdout.split()
    # Probe labels are created only after this fresh-runner ownership marker.
    ids += p.run('docker', 'ps', '-aq', '--filter', f'label={p.PROBE_LABEL}').stdout.split()
    for identity in set(ids):
        item = p.inspect(identity)
        labels = item['Config'].get('Labels') or {}
        assert labels.get(CI_LABEL) == owner or labels.get(p.PROBE_LABEL)
        p.run('docker', 'rm', '-f', '-v', identity)
    for label in [f'{CI_LABEL}={owner}', p.PROBE_LABEL]:
        for identity in p.run('docker', 'network', 'ls', '-q', '--filter', 'label=' + label).stdout.split():
            p.run('docker', 'network', 'rm', identity)
    for identity in p.run('docker', 'volume', 'ls', '-q', '--filter', f'label={CI_LABEL}={owner}').stdout.split():
        p.run('docker', 'volume', 'rm', identity)
    assert not p.run('docker', 'ps', '-aq', '--filter', f'label={CI_LABEL}={owner}').stdout.strip()
    assert not p.run('docker', 'ps', '-aq', '--filter', f'label={p.PROBE_LABEL}').stdout.strip()
    assert r.inspect(r.NAME) is None and r.inspect(r.SMOKE) is None
    pid = r.run('systemctl', 'show', 'gewu.service', '-p', 'MainPID', '--value', check=False).stdout.strip()
    assert pid in {'0', ''}
    for path in [p.ROOT, r.ROOT, r.RELEASES, r.BACKUPS, r.DROPIN.parent]:
        if path.exists():
            shutil.rmtree(path)
    for path in [Path('/etc/gewu.env'), Path('/etc/systemd/system/gewu.service')]:
        path.unlink(missing_ok=True)
    r.run('systemctl', 'daemon-reload')
    MARKER.unlink()
    print('GEWU_PAIRED_LEFTOVER_TEST_CONTAINERS=0')
    print('GEWU_PAIRED_LEFTOVER_TEST_SERVICE_PROCESSES=0')


def docker_build(source, dockerfile, tag):
    with tempfile.TemporaryDirectory(prefix='gewu-pair-image-ci-') as folder:
        path = Path(folder)
        (path / 'Dockerfile').write_text(dockerfile)
        if source:
            (path / 'server.js').write_text(source)
        p.run('docker', 'build', '-t', tag, str(path), timeout=120)
    return json.loads(p.run('docker', 'image', 'inspect', tag).stdout)[0]['Id']


def install_original_detector(image, revision):
    try:
        pwd.getpwnam('gewu')
    except KeyError:
        r.run('useradd', '--system', '--user-group', '--no-create-home', 'gewu')
    (r.ROOT / 'web_data/jobs').mkdir(parents=True)
    (r.ROOT / 'data/baselines').mkdir(parents=True)
    (r.ROOT / 'data/baselines/keep.txt').write_text('synthetic baseline fixture')
    r.run('chown', '-R', 'gewu:gewu', str(r.ROOT / 'web_data'))
    Path('/etc/gewu.env').write_text('GEWU_SITE_URL="https://gewu.example"\nGEWU_INTERNAL_API_TOKEN="fixture token with spaces"\n')
    Path('/etc/gewu.env').chmod(0o600)
    (r.ROOT / 'original-server.py').write_text('''from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true,"storage_writable":true}')
HTTPServer(('127.0.0.1',8765),Handler).serve_forever()
''')
    template = (REPO / 'detector/gewu.service').read_text()
    template = re.sub(r'ExecStart=.*?\nRestart=', 'ExecStart=/usr/bin/python3 /opt/gewu-detector/original-server.py\nRestart=', template, flags=re.S)
    Path('/etc/systemd/system/gewu.service').write_text(template)
    r.run('systemctl', 'daemon-reload')
    r.run('systemctl', 'start', 'gewu.service')
    for _ in range(30):
        try:
            r.healthy_service()
            break
        except Exception:
            time.sleep(.2)
    old_data = {'revision': OLD_REVISION, 'runtime_image_id': image, 'image_id': image}
    original_acquire = r.acquire
    r.acquire = lambda _: old_data
    try:
        r.deploy(OLD_REVISION, bootstrap=True)
    finally:
        r.acquire = original_acquire


def install_original_account(old_image, owner):
    p.run('docker', 'pull', 'postgres:16-alpine', timeout=180)
    p.run('docker', 'pull', 'redis:7-alpine', timeout=120)
    work = p.ROOT / 'releases/fixture-legacy'
    work.mkdir(parents=True)
    (p.ROOT / 'shared').mkdir()
    (p.ROOT / 'shared/.env').write_text('GEWU_INTERNAL_API_TOKEN="fixture token with spaces"\n')
    (p.ROOT / 'shared/.env').chmod(0o600)
    data = {
        'name': p.PROJECT,
        'services': {
            'app': {'image': old_image, 'container_name': p.APP, 'restart': 'unless-stopped',
                    'labels': {CI_LABEL: owner}, 'depends_on': {'migrate': {'condition': 'service_completed_successfully'}},
                    'ports': [{'target': 3000, 'published': '18787', 'host_ip': '127.0.0.1', 'protocol': 'tcp'}],
                    'volumes': [{'type': 'volume', 'source': 'mediadata', 'target': '/app/media'}],
                    'environment': {'NODE_ENV': 'production', 'PAYLOAD_SECRET': 'ci-platform$payload$$secret-only-0123456789',
                                    'DATABASE_URL': 'postgres://payload:fixture-pass@postgres:5432/gewu',
                                    'REDIS_URL': 'redis://redis:6379', 'GEWU_INTERNAL_API_TOKEN': 'fixture token with spaces',
                                    'NEXT_PUBLIC_SERVER_URL': 'https://gewu.example', 'SERVER_URL': 'https://gewu.example',
                                    'MEDIA_DIR': '/app/media', 'DETECTOR_BASE_URL': 'http://127.0.0.1:1'}},
            'postgres': {'image': 'postgres:16-alpine', 'container_name': p.DB, 'labels': {CI_LABEL: owner},
                         'environment': {'POSTGRES_USER': 'payload', 'POSTGRES_PASSWORD': 'fixture-pass', 'POSTGRES_DB': 'gewu'},
                         'volumes': [{'type': 'volume', 'source': 'pgdata', 'target': '/var/lib/postgresql/data'}]},
            'redis': {'image': 'redis:7-alpine', 'container_name': p.REDIS, 'labels': {CI_LABEL: owner},
                      'volumes': [{'type': 'volume', 'source': 'redisdata', 'target': '/data'}]},
            'relay-cron': {'image': old_image, 'container_name': 'gewu-relay-cron', 'labels': {CI_LABEL: owner},
                           'command': ['node', '-e', 'setInterval(()=>{},10000)']},
            'migrate': {'image': old_image, 'labels': {CI_LABEL: owner},
                        'command': ['node', '-e', "console.error('MIGRATION_MUST_NOT_RUN');process.exit(9)"]},
        },
        'networks': {'default': {'internal': True, 'labels': {CI_LABEL: owner}}},
        'volumes': {name: {'labels': {CI_LABEL: owner}} for name in ('mediadata', 'pgdata', 'redisdata')},
    }
    first, second = work / 'docker-compose.yml', work / 'compose.release.yml'
    p.write_config(first, data)
    p.write_config(second, {'services': {'app': {'environment': {'FIXTURE_DOLLARS': 'one$two$$three'}}}})
    command = p.config_command([first, second], work, '/dev/null')
    p.run(*command, 'up', '-d', '--no-deps', 'postgres', 'redis', 'relay-cron', 'app', timeout=120)
    p.wait_postgres(p.DB, 'payload', 'gewu')
    with (REPO / 'platform-fixture/platform-ci-database.dump').open('rb') as stream:
        p.run('docker', 'exec', '-i', p.DB, 'pg_restore', '-U', 'payload', '-d', 'gewu', '--no-owner', '--no-acl', '--exit-on-error', binary=True, stdin=stream, timeout=120)
    p.wait_health()
    p.run('docker', 'exec', '--user', 'root', p.APP, 'node', '-e', "require('fs').writeFileSync('/app/media/keep.txt','synthetic media canary')")
    p.run('docker', 'run', '-d', '--name', 'gewu-pair-unrelated-ci', '--label', f'{CI_LABEL}={owner}', '--network', 'none', old_image, 'node', '-e', 'setInterval(()=>{},10000)')
    return first, second


def main():
    assert_ci()
    if '--cleanup' in sys.argv:
        cleanup()
        return
    for path in [MARKER, p.ROOT, r.ROOT, r.RELEASES, r.BACKUPS, r.DROPIN.parent, Path('/etc/gewu.env'), Path('/etc/systemd/system/gewu.service')]:
        assert not path.exists(), 'Fixture refuses pre-existing managed paths'
    for name in [p.APP, p.DB, p.REDIS, r.NAME, r.SMOKE, 'gewu-relay-cron', 'gewu-pair-unrelated-ci']:
        assert p.inspect(name) is None, 'Fixture refuses pre-existing containers'
    for kind, names in [('network', [p.PROJECT + '_default']), ('volume', [p.PROJECT + '_' + x for x in ('mediadata', 'pgdata', 'redisdata')])]:
        for name in names:
            assert p.run('docker', kind, 'inspect', name, check=False).returncode != 0
    # Diagnostics are allowed only for this guarded, synthetic CI fixture.
    # The production deployer continues withholding subprocess stderr.
    original_run = p.run
    def fixture_run(*args, **kwargs):
        checked = kwargs.pop('check', True)
        result = original_run(*args, check=False, **kwargs)
        if checked and result.returncode:
            stderr = result.stderr.decode(errors='replace') if isinstance(result.stderr, bytes) else result.stderr
            print('SYNTHETIC_CI_DIAGNOSTIC: ' + str(stderr)[-10000:], flush=True)
            raise p.ReleaseError(f'CI fixture command failed: {args[0]} exit {result.returncode}')
        return result
    p.run = fixture_run
    owner = os.environ['REVISION']
    MARKER.write_text(json.dumps({'owner': owner}))
    try:
        image = os.environ['PLATFORM_IMAGE']
        detector_image = os.environ['IMAGE']
        target = json.loads(p.run('docker', 'image', 'inspect', image).stdout)[0]['Id']
        detector_target = json.loads(p.run('docker', 'image', 'inspect', detector_image).stdout)[0]['Id']
        old_detector = docker_build('', f'FROM {detector_image}\nLABEL org.opencontainers.image.revision="{OLD_REVISION}"\nENV GEWU_RELEASE_ID={OLD_REVISION}\n', 'gewu-detector-ci-previous:fixture')
        old_server = "import { createServer } from 'node:http'; createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,db:true,legacy:true}));}).listen(3000,'0.0.0.0');"
        old_app = docker_build(old_server, f'FROM {image}\nUSER root\nCOPY --chown=nextjs:nodejs server.js /app/server.js\nUSER nextjs\n', 'gewu-platform-ci-previous:fixture')
        install_original_detector(old_detector, OLD_REVISION)
        configs = install_original_account(old_app, owner)
        # Reproduce the historical migrations: only these two columns remain
        # varchar although the generated clean-install schema uses enums.
        p.run('docker', 'exec', p.DB, 'psql', '-X', '-U', 'payload', '-d', 'gewu', '-v', 'ON_ERROR_STOP=1', '-c', """
ALTER TABLE deployment_settings
 ALTER COLUMN newapi_usage_source TYPE varchar USING newapi_usage_source::text,
 ALTER COLUMN newapi_log_scope TYPE varchar USING newapi_log_scope::text;
INSERT INTO deployment_settings (newapi_usage_source,newapi_log_scope,backup_notes)
 VALUES ('local','self','synthetic legacy canary');
""")
        original_files = {str(path): p.sha(path) for path in configs}
        _, original_others = p.inventory()
        schema = json.loads((REPO / 'platform-fixture/platform-schema.json').read_text())
        original_acquire = r.acquire
        r.acquire = lambda revision: {'revision': revision, 'image_id': detector_target, 'runtime_image_id': detector_target}
        bundle = {'revision': owner, 'runtime_image_id': target}
        original_bundle = p.release_bundle
        p.STORE.joinpath(owner).mkdir(mode=0o700, parents=True)
        checked_script = p.STORE / owner / 'detector_release.py'
        shutil.copyfile(REPO / 'detector/deploy/container_release.py', checked_script)
        p.release_bundle = lambda revision: (bundle, schema, r, checked_script)

        source_db = p.database(p.inspect(p.APP))
        def settings_snapshot():
            return p.source_db(source_db, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
                "SELECT row_to_json(s) FROM (SELECT id,newapi_usage_source,newapi_log_scope,backup_notes FROM deployment_settings ORDER BY id) s;").stdout
        schema_before = p.source_schema_hash(source_db)
        settings_before = settings_snapshot()
        assert set(p.source_schema_compatible(source_db, schema)) == set(p.LEGACY_SETTINGS_ENUMS)
        original_dump = REPO / 'platform-fixture/platform-ci-database.dump'
        # Both shapes are exercised by the same actual image, including an
        # invalid legacy row that must fail without touching the live fixture.
        p.database_probe(target, source_db, original_dump, schema)
        p.run('docker', 'exec', p.DB, 'psql', '-X', '-U', 'payload', '-d', 'gewu', '-v', 'ON_ERROR_STOP=1', '-c',
              "UPDATE deployment_settings SET newapi_usage_source='invalid-ci-value';")
        invalid_dump = p.ROOT / 'invalid-ci.dump'
        with invalid_dump.open('wb') as stream:
            p.source_db(source_db, 'pg_dump', '--format=custom', '--no-owner', '--no-acl', binary=True, stdout=stream)
        for check in (lambda: p.source_schema_compatible(source_db, schema),
                      lambda: p.database_probe(target, source_db, invalid_dump, schema)):
            try:
                check()
                raise AssertionError('invalid legacy values must fail')
            except p.ReleaseError as error:
                assert str(error).startswith('Legacy setting values are incompatible')
                assert 'invalid-ci-value' not in str(error)
        p.run('docker', 'exec', p.DB, 'psql', '-X', '-U', 'payload', '-d', 'gewu', '-v', 'ON_ERROR_STOP=1', '-c',
              "UPDATE deployment_settings SET newapi_usage_source='local';")
        assert p.source_schema_hash(source_db) == schema_before and settings_snapshot() == settings_before
        print('PASS: canonical schema accepted; invalid legacy values refused without disclosure or service cutover')

        p.deploy(owner)
        assert p.source_schema_hash(source_db) == schema_before and settings_snapshot() == settings_before
        state = json.loads(p.STATE.read_text())
        folder = Path(state['backup'])
        assert state['paired_complete'] and p.image_id(p.inspect(p.APP)) == target
        assert p.health(gateway=True)['gateway'] is True
        assert p.environment(p.inspect(p.APP))['FIXTURE_DOLLARS'] == 'one$two$$three'
        assert p.image_id(p.inspect(r.NAME)) == detector_target
        assert all(p.sha(Path(path)) == value for path, value in original_files.items())
        assert p.inspect(p.PROJECT + '-migrate-1') is None
        print('PASS: actual paired images, two-file Compose, literal dollars, media and dependencies preserved')
        # Use the exact checked deployer file while avoiding release downloads in CI.
        saved_loader = p.load_module
        p.load_module = lambda path, name: r
        p.rollback(folder)
        assert p.image_id(p.inspect(p.APP)) == old_app and p.image_id(p.inspect(r.NAME)) == old_detector
        assert p.source_schema_hash(source_db) == schema_before and settings_snapshot() == settings_before
        print('PASS: actual paired manual rollback retains live database and media')

        original_wait = p.wait_health
        def failed_account(*, gateway=False):
            if gateway:
                raise p.ReleaseError('injected account readiness failure')
            return original_wait(gateway=gateway)
        p.wait_health = failed_account
        try:
            p.deploy(owner)
            raise AssertionError('account failure must not succeed')
        except p.ReleaseError as error:
            assert str(error) == 'injected account readiness failure'
        finally:
            p.wait_health = original_wait
        assert p.image_id(p.inspect(p.APP)) == old_app and p.image_id(p.inspect(r.NAME)) == old_detector
        print('PASS: failed account replacement restores only the original account container')

        original_deploy = r.deploy
        def failed_detector(*args, **kwargs):
            raise r.DeploymentError('injected detector failure before cutover')
        r.deploy = failed_detector
        try:
            p.deploy(owner)
            raise AssertionError('detector failure must not succeed')
        except r.DeploymentError as error:
            assert str(error) == 'injected detector failure before cutover'
        finally:
            r.deploy = original_deploy
        assert p.image_id(p.inspect(p.APP)) == old_app and p.image_id(p.inspect(r.NAME)) == old_detector
        assert p.source_schema_hash(source_db) == schema_before and settings_snapshot() == settings_before
        print('PASS: legacy varchar settings survive paired deployment and both failure recoveries without schema/row changes')
        print('PASS: failed detector phase also restores the previous account image')
        assert p.inspect(p.PROJECT + '-migrate-1') is None
        assert p.run('docker', 'exec', p.DB, 'psql', '-U', 'payload', '-d', 'gewu', '-At', '-c', 'SELECT count(*) FROM gewu_release_probe_canary;').stdout.strip() == '1'
        current_others = p.inventory()[1]
        assert {k:v for k,v in current_others.items() if k != '/gewu-detector'} == {k:v for k,v in original_others.items() if k != '/gewu-detector'}
        p.load_module, p.release_bundle, r.acquire = saved_loader, original_bundle, original_acquire
    finally:
        cleanup()


if __name__ == '__main__':
    main()

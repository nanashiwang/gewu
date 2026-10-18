#!/usr/bin/env python3
"""GitHub-built account image, copied-database probe, then paired detector release.

Only gewu-app and gewu-detector are replaced. Never build on the server, migrate
or restore a live database, recreate dependencies, or prune shared Docker data.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit, unquote
from urllib.request import Request, urlopen

REPO = 'nanashiwang/gewu'
IMAGE = 'ghcr.io/nanashiwang/gewu-platform'
PROJECT = 'gewu-platform'
APP = 'gewu-app'
DB = 'gewu-postgres'
REDIS = 'gewu-redis'
ROOT = Path('/opt/gewu-platform')
STORE = ROOT / 'container-releases'
BACKUPS = ROOT / 'container-backups'
PROBES = ROOT / '.release-probes'
STATE = ROOT / '.container-release.json'
PROBE_LABEL = 'org.gewu.platform-probe'
SHA = r'[0-9a-f]{40}'
DIGEST = r'sha256:[0-9a-f]{64}'
SCHEMA_SQL = """SELECT json_build_object(
'columns',(SELECT coalesce(json_agg(c ORDER BY table_name,column_name),'[]') FROM
(SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema='public') c),
'enums',(SELECT coalesce(json_agg(e ORDER BY name,value),'[]') FROM
(SELECT t.typname AS name,e.enumlabel AS value FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname='public') e));"""


class ReleaseError(RuntimeError):
    pass


def need(value, message):
    if not value:
        raise ReleaseError(message)


def run(*args, timeout=60, check=True, env=None, binary=False, input=None, stdout=None, stdin=None):
    operation = Path(args[0]).name
    actual_env = dict(os.environ if env is None else env)
    if args[0] == 'docker':
        actual_env.update(DOCKER_CONTEXT='default', DOCKER_HOST='unix:///var/run/docker.sock')
    try:
        result = subprocess.run(args, timeout=timeout, env=actual_env, input=input,
                                stdout=stdout if stdout is not None else subprocess.PIPE,
                                stderr=subprocess.PIPE, text=not binary, stdin=stdin)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        raise ReleaseError(f'{operation}: command unavailable or timed out; arguments and output withheld') from None
    if check and result.returncode:
        raise ReleaseError(f'{operation}: command failed (exit {result.returncode}); arguments and output withheld')
    return result


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def safe_path(path):
    need(path.is_absolute() and path.resolve() == path, 'Unexpected non-absolute or symlink path')
    return path


def save(path, value):
    safe_path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.gewu-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def fetch(url, path, limit):
    safe_path(path)
    need(not path.exists(), 'Download destination already exists')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.download-', dir=path.parent)
    try:
        with urlopen(Request(url, headers={'User-Agent': 'gewu-paired-release/1'}), timeout=60) as response, os.fdopen(fd, 'wb') as out:
            length = 0
            while block := response.read(1024 * 1024):
                length += len(block)
                need(length <= limit, 'Download exceeds its size limit')
                out.write(block)
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        Path(name).unlink(missing_ok=True)


def inspect(name):
    result = run('docker', 'inspect', name, check=False)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def environment(item):
    return dict(value.split('=', 1) for value in item.get('Config', {}).get('Env', []) if '=' in value)


def inventory():
    ids = run('docker', 'ps', '-aq').stdout.split()
    entries = json.loads(run('docker', 'inspect', *ids).stdout) if ids else []
    apps = [item for item in entries if item['Name'] == '/' + APP]
    need(len(apps) == 1 and apps[0]['State']['Running'], 'Expected one running gewu-app')
    labels = apps[0]['Config'].get('Labels') or {}
    need(labels.get('com.docker.compose.project') == PROJECT and labels.get('com.docker.compose.service') == 'app', 'Account container project/service ownership mismatch')
    need(not any((item['Config'].get('Labels') or {}).get(PROBE_LABEL) for item in entries), 'A previous platform probe still exists; inspect it before retrying')
    others = {item['Name']: (item['Id'], item['State']['StartedAt'], item['State']['Status'])
              for item in entries if item['Name'] != '/' + APP}
    return apps[0], others


def clean_env():
    return {key: value for key, value in os.environ.items() if key in {'PATH', 'HOME', 'DOCKER_CONFIG'}}


def config_command(paths, working_dir, envfile):
    command = ['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(working_dir), '--env-file', str(envfile)]
    for path in paths:
        command += ['-f', str(path)]
    return command


def read_config(app):
    labels = app['Config'].get('Labels') or {}
    paths = [safe_path(Path(p)) for p in labels.get('com.docker.compose.project.config_files', '').split(',') if p]
    working = safe_path(Path(labels.get('com.docker.compose.project.working_dir', '')))
    need(working.is_dir() and working.is_relative_to(ROOT), 'Unexpected Compose working directory')
    need(1 <= len(paths) <= 3 and all(p.is_file() and p.is_relative_to(ROOT) for p in paths), 'Unexpected Compose configuration paths')
    candidates = [Path('/dev/null')] if any(p.is_relative_to(STORE) or p.is_relative_to(BACKUPS) for p in paths) else [working / '.env', ROOT / 'shared/.env', Path('/dev/null')]
    for envfile in candidates:
        if envfile != Path('/dev/null'):
            if not envfile.is_file():
                continue
            need(envfile.resolve().is_relative_to(ROOT), 'Compose environment file points outside the account platform')
        cmd = config_command(paths, working, envfile)
        hashes = run(*cmd, 'config', '--hash', '*', env=clean_env(), check=False)
        if hashes.returncode:
            continue
        found = dict(line.split() for line in hashes.stdout.splitlines())
        if found.get('app') != labels.get('com.docker.compose.config-hash'):
            continue
        raw = run(*cmd, 'config', '--format', 'json', env=clean_env()).stdout
        config = json.loads(raw.replace('$$', '$'))
        need(config.get('name') == PROJECT and 'app' in config.get('services', {}), 'Resolved Compose project mismatch')
        live = environment(app)
        need(all(live.get(k) == v for k, v in config['services']['app'].get('environment', {}).items() if v is not None), 'Compose environment differs from the running account container')
        service = config['services']['app']
        need(not service.get('deploy'), 'Swarm-style account resource settings require explicit migration review')
        declared_networks = service.get('networks') or {'default': None}
        expected_networks = {config.get('networks', {}).get(key, {}).get('name', PROJECT + '_' + key) for key in declared_networks}
        need(expected_networks == set(app['NetworkSettings']['Networks']), 'Running account networks differ from saved Compose')
        return config, paths, envfile
    raise ReleaseError('Running app does not match its saved Compose configuration; no changes made')


def compose(path, *args):
    return run(*config_command([path], ROOT, '/dev/null'), *args, env=clean_env(), timeout=150)


def write_config(path, config):
    def escape(value):
        if isinstance(value, str):
            return value.replace('$', '$$')
        if isinstance(value, dict):
            return {k: escape(v) for k, v in value.items()}
        if isinstance(value, list):
            return [escape(v) for v in value]
        return value
    save(path, escape(config))


def image_id(container):
    for candidate in [container.get('Image'), (container.get('ImageManifestDescriptor') or {}).get('digest')]:
        if not isinstance(candidate, str) or not re.fullmatch(DIGEST, candidate):
            continue
        result = run('docker', 'image', 'inspect', candidate, check=False)
        if not result.returncode:
            identity = json.loads(result.stdout)[0]['Id']
            need(re.fullmatch(DIGEST, identity), 'Invalid local image identity')
            return identity
    raise ReleaseError('Original content-addressed image unavailable; refusing cutover without rollback')


def pinned(config, app, image):
    need(re.fullmatch(DIGEST, image), 'An immutable local image ID is required')
    result = json.loads(json.dumps(config))
    service = result['services']['app']
    service.pop('build', None)
    service.update(image=image, pull_policy='never')
    # Freeze effective application settings, including image-baked defaults.
    # Node/Yarn version markers belong to the new pinned runtime, not operator configuration.
    service['environment'] = {k: v for k, v in environment(app).items() if k not in {'NODE_VERSION', 'YARN_VERSION'}}
    for target, source in [('command', 'Cmd'), ('entrypoint', 'Entrypoint'), ('working_dir', 'WorkingDir'), ('user', 'User')]:
        value = app['Config'].get(source)
        if value:
            service[target] = value
    host = app['HostConfig']
    for field, live in [('mem_limit', 'Memory'), ('memswap_limit', 'MemorySwap'), ('pids_limit', 'PidsLimit')]:
        if host.get(live):
            service[field] = host[live]
        else:
            service.pop(field, None)
    if host.get('NanoCpus'):
        service['cpus'] = host['NanoCpus'] / 1_000_000_000
    else:
        service.pop('cpus', None)
    logging = host.get('LogConfig') or {}
    if logging.get('Type'):
        service['logging'] = {'driver': logging['Type'], 'options': logging.get('Config') or {}}
    return result


def runtime_signature(app):
    host = app['HostConfig']
    return {
        'environment': {k: v for k, v in environment(app).items() if k not in {'NODE_VERSION', 'YARN_VERSION'}},
        'config': {key: app['Config'].get(key) for key in ('User', 'Cmd', 'Entrypoint', 'WorkingDir')},
        'host': {key: host.get(key) for key in ('PortBindings', 'RestartPolicy', 'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'Privileged', 'ReadonlyRootfs', 'CapAdd', 'CapDrop', 'SecurityOpt', 'LogConfig')},
        'mounts': sorted([m['Type'], m.get('Name', m['Source']), m['Destination'], m['RW']] for m in app.get('Mounts', [])),
        'networks': sorted(app['NetworkSettings']['Networks']),
    }


def health(name=APP, *, gateway=False):
    code = "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/health',{signal:AbortSignal.timeout(6000)}).then(r=>r.json()).then(d=>{if(d.ok!==true||d.db!==true)process.exit(1);console.log(JSON.stringify({ok:true,gateway:d.features?.reportOwnerGateway===1}))}).catch(()=>process.exit(1))"
    result = run('docker', 'exec', name, 'node', '-e', code, timeout=10, check=False)
    need(result.returncode == 0, 'Account health check failed')
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise ReleaseError('Unexpected account health response') from None
    need(not gateway or data.get('gateway') is True, 'Account report ownership gateway unavailable')
    return data


def wait_health(*, gateway=False):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            return health(gateway=gateway)
        except ReleaseError:
            time.sleep(1)
    raise ReleaseError('Account platform did not become healthy within 90 seconds')


def database(app):
    env = environment(app)
    need(env.get('NODE_ENV') == 'production' and env.get('PAYLOAD_DROP_DATABASE') != 'true', 'Unsafe account database startup mode')
    try:
        parsed = urlsplit(env.get('DATABASE_URL', ''))
        user, password, name = unquote(parsed.username or ''), unquote(parsed.password or ''), unquote(parsed.path.lstrip('/'))
        port = parsed.port or 5432
    except ValueError:
        raise ReleaseError('Unsupported account database configuration') from None
    need(parsed.scheme in {'postgres', 'postgresql'} and port == 5432 and name == 'gewu' and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', user) and password and '\0' not in password, 'Unsupported database endpoint/credentials layout')
    db = inspect(DB)
    redis = inspect(REDIS)
    need(db and db['State']['Running'] and redis and redis['State']['Running'], 'Existing gewu database/Redis must be running')
    need(environment(db).get('PG_MAJOR') == '16', 'Only the existing PostgreSQL 16 data layout is supported')
    aliases = {DB}
    for network, item in db['NetworkSettings']['Networks'].items():
        if network in app['NetworkSettings']['Networks']:
            aliases.update(item.get('Aliases') or [])
            aliases.add(item.get('IPAddress'))
    need(parsed.hostname in aliases, 'Account database does not target the existing gewu-postgres container')
    return {'user': user, 'password': password, 'name': name, 'image': image_id(db), 'redis_image': image_id(redis)}


def source_db(db, program, *args, binary=False, stdout=None):
    env = {**os.environ, 'PGPASSWORD': db['password'], 'PGCONNECT_TIMEOUT': '5',
           'PGOPTIONS': '-c default_transaction_read_only=on -c lock_timeout=10000 -c statement_timeout=120000'}
    return run('docker', 'exec', '--env', 'PGPASSWORD', '--env', 'PGCONNECT_TIMEOUT', '--env', 'PGOPTIONS', DB,
               'timeout', '-k', '5', '120', program, '-U', db['user'], '-d', db['name'], *args,
               timeout=135, env=env, binary=binary, stdout=stdout)


def private_history(db):
    result = source_db(db, 'psql', '-At', '-c', "SELECT EXISTS(SELECT 1 FROM public.relay_checks WHERE to_jsonb(report) ? '_web_access');")
    need(result.stdout.strip() in {'t', 'f'}, 'Private report history could not be checked')
    return result.stdout.strip() == 't'


def protected_files(app, config_paths, envfile):
    roots = [Path('/etc/nginx'), Path('/etc/gewu.env'), ROOT / 'shared', *config_paths]
    if envfile != Path('/dev/null'):
        roots.append(envfile.resolve())
    roots += [Path(m['Source']) for m in app.get('Mounts', []) if m['Destination'] == '/app/media']
    values = {}
    for root in roots:
        for path in [root] if root.is_file() else root.rglob('*') if root.is_dir() else []:
            if path.is_file() and not path.is_symlink():
                values[str(path)] = sha(path)
    return values


def verify_files(values):
    need(all(Path(path).is_file() and sha(path) == value for path, value in values.items()), 'Existing configuration/media changed during cutover')


def schema_compatible(expected, actual):
    need(isinstance(expected, dict) and expected.get('version') == 1 and isinstance(expected.get('columns'), list) and isinstance(expected.get('enums'), list), 'Invalid release schema requirements')
    columns = {(row['table_name'], row['column_name']): row['udt_name'] for row in actual['columns']}
    enums = {(row['name'], row['value']) for row in actual['enums']}
    need(all(columns.get((row['table_name'], row['column_name'])) == row['udt_name'] for row in expected['columns']), 'Database schema is incompatible; a separate migration review is required')
    need(all((row['name'], row['value']) in enums for row in expected['enums']), 'Database enum definitions are incompatible; no automatic migration is performed')


class Probe:
    """Only containers/network/bind data created under this random owner are removed."""
    def __init__(self):
        self.owner = secrets.token_hex(8)
        self.prefix = 'gewu-platform-probe-' + self.owner
        self.path = PROBES / self.owner
        self.network = self.prefix
        self.names = {part: self.prefix + '-' + part for part in ('app', 'db', 'redis')}

    def __enter__(self):
        safe_path(PROBES).mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.mkdir(mode=0o700, exist_ok=False)
        (self.path / '.owner').write_text(self.owner)
        return self

    def start(self, part, image, *args, envfile=None, command=()):
        command_args = ['docker', 'run', '-d', '--name', self.names[part], '--label', f'{PROBE_LABEL}={self.owner}',
                        '--network', self.network, '--network-alias', part, '--log-driver', 'none', '--pids-limit', '128']
        if envfile:
            command_args += ['--env-file', str(envfile)]
        return run(*command_args, *args, image, *command, timeout=45)

    def __exit__(self, exc_type, exc, tb):
        errors = []
        for name in self.names.values():
            try:
                item = inspect(name)
                if item:
                    need((item['Config'].get('Labels') or {}).get(PROBE_LABEL) == self.owner, 'Refusing cleanup of an unowned probe container')
                    run('docker', 'rm', '-f', '-v', item['Id'], timeout=30)
            except Exception:
                errors.append('container cleanup')
        try:
            result = run('docker', 'network', 'inspect', self.network, check=False)
            if not result.returncode:
                item = json.loads(result.stdout)[0]
                need((item.get('Labels') or {}).get(PROBE_LABEL) == self.owner, 'Refusing cleanup of an unowned probe network')
                run('docker', 'network', 'rm', item['Id'])
        except Exception:
            errors.append('network cleanup')
        remaining = run('docker', 'ps', '-aq', '--filter', f'label={PROBE_LABEL}={self.owner}').stdout.strip()
        need(not remaining and not errors, 'Isolated probe cleanup failed; no zero-leftover claim is made')
        need(self.path.parent == PROBES and self.path.resolve() == self.path and (self.path / '.owner').read_text() == self.owner, 'Unexpected probe data ownership')
        shutil.rmtree(self.path)
        print('GEWU_PLATFORM_LEFTOVER_TEST_CONTAINERS=0', flush=True)


def env_file(path, data):
    need(all(re.fullmatch(r'[A-Z_][A-Z0-9_]*', key) and isinstance(value, str) and '\n' not in value and '\r' not in value and '\0' not in value for key, value in data.items()), 'Invalid isolated environment')
    path.write_text(''.join(key + '=' + value + '\n' for key, value in data.items()))
    path.chmod(0o600)
    return path


def dump_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for line in stream:
            if not line.startswith((b'\\restrict ', b'\\unrestrict ')):
                digest.update(line)
    return digest.hexdigest()


def source_schema_hash(db):
    # Schema is small; no user rows or secret values are returned to the caller.
    data = source_db(db, 'pg_dump', '--schema-only', '--no-owner', '--no-acl', '--no-tablespaces', binary=True).stdout
    return hashlib.sha256(b''.join(line for line in data.splitlines(keepends=True) if not line.startswith((b'\\restrict ', b'\\unrestrict ')))).hexdigest()


def copied_dump_hash(name, path):
    # Stream the copy to an owned file rather than holding a database in RAM on
    # the small production server. The enclosing Probe removes this test copy.
    with path.open('wb') as stream:
        os.chmod(path, 0o600)
        run('docker', 'exec', name, 'timeout', '-k', '5', '90', 'pg_dump', '-U', 'probe', '-d', 'probe',
            '--no-owner', '--no-acl', '--no-tablespaces', binary=True, stdout=stream, timeout=100)
    return dump_hash(path)



def wait_postgres(name, user, database, *, seconds=45):
    # The official image temporarily listens on a Unix socket while initdb is
    # still creating POSTGRES_DB. Only TCP proves that initialization is over.
    deadline = time.monotonic() + seconds
    while run('docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', user, '-d', database, '-t', '3', check=False).returncode:
        need(time.monotonic() < deadline, 'Isolated PostgreSQL did not become ready')
        time.sleep(1)


def database_probe(image, db, dump, expected_schema):
    print('STEP: isolated account startup against a database copy; upstream network disabled', flush=True)
    with Probe() as probe:
        run('docker', 'network', 'create', '--internal', '--label', f'{PROBE_LABEL}={probe.owner}', probe.network)
        db_path = probe.path / 'postgres'
        db_path.mkdir(mode=0o700)
        password = secrets.token_hex(20)
        pg_env = env_file(probe.path / 'postgres.env', {'POSTGRES_USER': 'probe', 'POSTGRES_PASSWORD': password, 'POSTGRES_DB': 'probe'})
        probe.start('db', db['image'], '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5',
                    '--mount', f'type=bind,src={db_path},dst=/var/lib/postgresql/data', envfile=pg_env,
                    command=('postgres', '-c', 'shared_buffers=32MB', '-c', 'max_connections=20', '-c', 'autovacuum=off'))
        wait_postgres(probe.names['db'], 'probe', 'probe')
        with dump.open('rb') as stream:
            run('docker', 'exec', '-i', probe.names['db'], 'timeout', '-k', '5', '120', 'pg_restore', '-U', 'probe', '-d', 'probe', '--no-owner', '--no-acl', '--no-tablespaces', '--exit-on-error', binary=True, stdin=stream, timeout=135)
        actual = json.loads(run('docker', 'exec', probe.names['db'], 'psql', '-U', 'probe', '-d', 'probe', '-At', '-c', SCHEMA_SQL).stdout)
        schema_compatible(expected_schema, actual)
        before = copied_dump_hash(probe.names['db'], probe.path / 'copy.sql')
        probe.start('redis', db['redis_image'], '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.2',
                    command=('redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '32mb', '--maxmemory-policy', 'allkeys-lru'))
        app_env = env_file(probe.path / 'app.env', {
            'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1', 'PORT': '3000', 'HOSTNAME': '0.0.0.0',
            'PAYLOAD_SECRET': secrets.token_hex(32), 'GEWU_INTERNAL_API_TOKEN': secrets.token_hex(32),
            'DATABASE_URL': f'postgres://probe:{password}@db:5432/probe', 'REDIS_URL': 'redis://redis:6379',
            'SERVER_URL': 'http://127.0.0.1:3000', 'NEXT_PUBLIC_SERVER_URL': 'http://127.0.0.1:3000',
            'INTERNAL_SERVER_URL': 'http://127.0.0.1:3000', 'MEDIA_DIR': '/app/media',
            'DETECTOR_BASE_URL': 'http://127.0.0.1:1', 'DETECTOR_PUBLIC_URL': 'http://127.0.0.1:1',
        })
        probe.start('app', image, '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--read-only',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
                    '--tmpfs', '/app/.next/cache:rw,nosuid,nodev,size=64m,uid=1001,gid=1001,mode=700',
                    '--tmpfs', '/app/media:rw,nosuid,nodev,size=16m,uid=1001,gid=1001,mode=700', envfile=app_env)
        deadline = time.monotonic() + 90
        while True:
            try:
                health(probe.names['app'], gateway=True)
                break
            except ReleaseError:
                need(time.monotonic() < deadline, 'Isolated account health/gateway check failed; live application unchanged')
                time.sleep(1)
        route = "fetch('http://127.0.0.1:3000/v1/relay-sites/fixture/checks/fixture/report',{redirect:'manual',signal:AbortSignal.timeout(8000)}).then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1))"
        run('docker', 'exec', probe.names['app'], 'node', '-e', route, timeout=12)
        need(copied_dump_hash(probe.names['db'], probe.path / 'copy.sql') == before, 'New account startup changed the copied database; refusing live upgrade')
    print('PASS: required schema, unauthenticated report denial, and unchanged copied schema/rows', flush=True)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def release_bundle(revision):
    need(re.fullmatch(SHA, revision), 'Expected full commit SHA')
    safe_path(STORE).mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = safe_path(STORE / revision)
    directory.mkdir(mode=0o700, exist_ok=True)
    base = f'https://github.com/{REPO}/releases/download/platform-{revision}'
    manifest = directory / 'release.json'
    if not manifest.exists():
        fetch(base + '/release.json', manifest, 65536)
    data = json.loads(manifest.read_text())
    need(data.get('revision') == revision and data.get('detector_revision') == revision, 'Paired release revision mismatch')
    for field in ('detector_script_sha256', 'schema_sha256'):
        need(isinstance(data.get(field), str) and re.fullmatch(r'[0-9a-f]{64}', data[field]), 'Invalid paired release digest')
    script = directory / 'detector_release.py'
    if not script.exists():
        fetch(f'https://github.com/{REPO}/releases/download/detector-{revision}/container_release.py', script, 256 * 1024)
    need(sha(script) == data['detector_script_sha256'], 'Detector deployment script checksum mismatch')
    schema = directory / 'schema.json'
    if not schema.exists():
        fetch(base + '/schema.json', schema, 4 * 1024**2)
    need(sha(schema) == data['schema_sha256'], 'Schema requirement checksum mismatch')
    detector = load_module(script, '_gewu_paired_detector')
    account_images = load_module(script, '_gewu_account_image_acquisition')
    account_images.IMAGE, account_images.RELEASES = IMAGE, STORE
    account_images.RELEASE_PREFIX, account_images.ARCHIVE_NAME = 'platform-', 'platform-image.tar.gz'
    account_images.validate_manifest(data, revision)
    data = account_images.acquire(revision)
    return data, json.loads(schema.read_text()), detector, script


def preflight():
    need(os.geteuid() == 0, 'Run as root')
    need(run('uname', '-m').stdout.strip() == 'x86_64', 'Only Linux amd64 releases are supported')
    safe_path(ROOT)
    need(ROOT.is_dir(), 'Missing existing account platform')
    for path in (STORE, BACKUPS, PROBES):
        safe_path(path)
    app, others = inventory()
    mounts = app.get('Mounts', [])
    need(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['Destination'] == '/app/media'
         and mounts[0].get('Name') == PROJECT + '_mediadata' and mounts[0]['RW'], 'Unexpected application data mounts; no changes made')
    need(not app['HostConfig'].get('Privileged') and app['HostConfig'].get('PidMode') != 'host', 'Unexpected privileged account container')
    config, paths, envfile = read_config(app)
    before_health = health()
    db = database(app)
    if not before_health.get('gateway'):
        need(not private_history(db), 'Private account reports already exist under a legacy account image; review recovery before migration')
    detector = inspect('gewu-detector')
    shared = environment(app).get('GEWU_INTERNAL_API_TOKEN', '').strip()
    need(detector and detector['State']['Running'] and shared and environment(detector).get('GEWU_INTERNAL_API_TOKEN', '').strip() == shared, 'Existing account/detector authentication must already match; no values shown')
    db_size = int(source_db(db, 'psql', '-At', '-c', 'SELECT pg_database_size(current_database());').stdout.strip())
    need(db_size <= 512 * 1024**2, 'Database copy exceeds this release probe budget; use a separately reviewed migration')
    need(shutil.disk_usage(ROOT).free >= max(2 * 1024**3, db_size * 4 + 800 * 1024**2), 'Insufficient disk headroom for images, backup and isolated database copy')
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    need(int(memory['MemAvailable'].strip().split()[0]) >= 900 * 1024, 'At least 900 MiB available memory is required for the temporary isolated probe')
    old_image = image_id(app)
    print('PASS: account project, saved Compose, media volume, rollback image, database topology and shared authentication', flush=True)
    return app, others, config, paths, envfile, db, old_image, before_health.get('gateway') is True


def deploy_account(data, schema, detector, script):
    app, others, config, paths, envfile, db, previous_image, previous_gateway = preflight()
    detector.preflight(require_idle=False, require_account_gateway=False)
    detector.healthy_service()
    detector.acquire(data['revision'])  # Acquire both pinned images before any service cutover.
    folder = BACKUPS / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4))
    folder.mkdir(mode=0o700, parents=True, exist_ok=False)
    previous = pinned(config, app, previous_image)
    updated = pinned(config, app, data['runtime_image_id'])
    old_path, new_path = folder / 'previous.json', STORE / data['revision'] / 'compose.json'
    write_config(old_path, previous)
    write_config(new_path, updated)
    compose(old_path, 'config', '--quiet')
    compose(new_path, 'config', '--quiet')
    record = {'revision': data['revision'], 'previous_config': str(old_path), 'previous_image': previous_image,
              'previous_gateway': previous_gateway, 'previous_state': STATE.read_text() if STATE.exists() else None,
              'runtime': runtime_signature(app), 'detector_before': detector.STATE.read_text(),
              'detector_image_before': image_id(inspect('gewu-detector')), 'detector_script': str(script),
              'detector_script_sha256': sha(script), 'detector_backup': None, 'schema_before': source_schema_hash(db)}
    save(folder / 'rollback.json', record)
    dump = folder / 'database.dump'
    print('STEP: create a consistent read-only database backup', flush=True)
    with dump.open('xb') as stream:
        os.chmod(dump, 0o600)
        source_db(db, 'pg_dump', '--format=custom', '--no-owner', '--no-acl', '--no-tablespaces', '--lock-wait-timeout=10s', binary=True, stdout=stream)
    database_probe(data['runtime_image_id'], db, dump, schema)
    # Work may have continued while the image and database copy were prepared.
    current, current_others = inventory()
    need(current['Id'] == app['Id'] and current_others == others, 'Container inventory changed during preparation; retry preflight')
    need(source_schema_hash(db) == record['schema_before'], 'Database schema changed during preparation; no service cutover performed')
    protected = protected_files(current, paths, envfile)
    save(folder / 'protected.json', {'files': protected, 'others': others})
    switched = False
    with detector.deployment_window(wait_seconds=300):
        try:
            switched = True
            print('STEP: brief account maintenance; replacing only gewu-app', flush=True)
            compose(new_path, 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--force-recreate', '--timeout', '75', 'app')
            wait_health(gateway=True)
            now, remaining = inventory()
            need(image_id(now) == data['runtime_image_id'], 'Running account image differs from pinned release')
            need(runtime_signature(now) == record['runtime'], 'Account runtime configuration changed unexpectedly')
            need(remaining == others, 'Another project/container changed during account cutover')
            verify_files(protected)
            need(source_schema_hash(db) == record['schema_before'], 'Live schema changed unexpectedly; do not restore data automatically')
            detector.require_account_report_gateway()
            save(STATE, {'revision': data['revision'], 'image': data['runtime_image_id'], 'compose': str(new_path), 'backup': str(folder), 'paired_complete': False})
            switched = False
        finally:
            if switched:
                restore_account(folder, db=db)
    print('PASS: account image ready; configuration, media and other containers preserved', flush=True)
    return folder, db


def restore_account(folder, *, db=None):
    safe_path(folder)
    need(folder.parent == BACKUPS and folder.is_dir(), 'Invalid account rollback directory')
    record = json.loads((folder / 'rollback.json').read_text())
    current = inspect(APP)
    need(current is None or (current['Config'].get('Labels') or {}).get('com.docker.compose.project') == PROJECT, 'Rollback application ownership mismatch')
    need(db is not None or current is not None, 'Missing runtime database context for rollback')
    db = database(current) if db is None else db
    need(source_schema_hash(db) == record['schema_before'], 'Live schema changed; account downgrade requires a separate compatibility review')
    if not record['previous_gateway']:
        need(not private_history(db), 'Refusing legacy account rollback: private report history now exists; retain privacy-aware account code')
    path = safe_path(Path(record['previous_config']))
    need(path.parent == folder, 'Unexpected previous Compose path')
    # No database or media restore: retain all legitimate writes since backup.
    compose(path, 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--force-recreate', '--timeout', '75', 'app')
    wait_health(gateway=record['previous_gateway'])
    now = inspect(APP)
    need(image_id(now) == record['previous_image'] and runtime_signature(now) == record['runtime'], 'Account rollback runtime verification failed')
    if record['previous_state'] is None:
        STATE.unlink(missing_ok=True)
    else:
        save(STATE, json.loads(record['previous_state']))
    print('PLATFORM_ROLLBACK_SUCCESS: previous account image restored; live data retained', flush=True)


def detector_is_previous(detector, record):
    item = inspect('gewu-detector')
    if not item or not item['State']['Running']:
        return False
    try:
        detector.healthy_service()
        return image_id(item) == record['detector_image_before'] and detector.STATE.read_text() == record['detector_before']
    except Exception:
        return False


def deploy(revision):
    need(re.fullmatch(SHA, revision), 'Expected full commit SHA')
    preflight()  # Validate the intended server before downloading any images.
    data, schema, detector, script = release_bundle(revision)
    folder, db = deploy_account(data, schema, detector, script)
    record = json.loads((folder / 'rollback.json').read_text())
    try:
        print('STEP: upgrade paired detector with its normal drain and rollback checks', flush=True)
        detector.deploy(revision)
    except BaseException:
        if detector_is_previous(detector, record):
            with detector.deployment_window(wait_seconds=300):
                restore_account(folder, db=db)
        else:
            try:
                current = json.loads(detector.STATE.read_text())
                backup = safe_path(Path(current['backup']))
                if current.get('revision') == revision and backup.parent == detector.BACKUPS and json.loads((backup / 'rollback.json').read_text()).get('state') == record['detector_before']:
                    record['detector_backup'] = str(backup)
                    save(folder / 'rollback.json', record)
            except Exception:
                pass  # Never mask the original failure or guess a recovery target.
            print('PAIR_RECOVERY_REQUIRED: account kept privacy-aware because the detector was not proven restored; no live data restored', flush=True)
        raise
    state = json.loads(detector.STATE.read_text())
    record['detector_backup'] = state['backup']
    save(folder / 'rollback.json', record)
    account_state = json.loads(STATE.read_text())
    account_state['paired_complete'] = True
    save(STATE, account_state)
    health(gateway=True)
    detector.require_account_report_gateway()
    protected = json.loads((folder / 'protected.json').read_text())
    verify_files(protected['files'])
    _, others = inventory()
    expected = {k: v for k, v in protected['others'].items() if k != '/gewu-detector'}
    need({k: list(v) for k, v in others.items() if k != '/gewu-detector'} == expected, 'Unrelated container inventory changed during paired deployment')
    print('GEWU_PLATFORM_LEFTOVER_TEST_CONTAINERS=0')
    print('PAIR_DEPLOY_SUCCESS=' + revision)
    print('ACCOUNT_ROLLBACK_DIRECTORY=' + str(folder))
    print('DETECTOR_ROLLBACK_DIRECTORY=' + str(record['detector_backup']))
    print('No caches, production volumes, images or old backups were deleted.')


def rollback(folder):
    safe_path(folder)
    need(folder.parent == BACKUPS and folder.is_dir(), 'Invalid paired rollback directory')
    record = json.loads((folder / 'rollback.json').read_text())
    need(STATE.is_file() and json.loads(STATE.read_text()).get('revision') == record['revision'] and json.loads(STATE.read_text()).get('backup') == str(folder), 'Only the current account release can use this rollback record')
    script = safe_path(Path(record['detector_script']))
    need(script.is_relative_to(STORE) and sha(script) == record['detector_script_sha256'], 'Rollback deployer checksum/path mismatch')
    detector = load_module(script, '_gewu_pair_rollback')
    db = database(inspect(APP))
    need(source_schema_hash(db) == record['schema_before'], 'Live schema differs from the rollback point; no service changes made')
    if not record['previous_gateway']:
        need(not private_history(db), 'Private account reports exist; legacy account rollback is blocked before any service changes')
    with detector.deployment_window(wait_seconds=300):
        if record.get('detector_backup'):
            detector.restore(safe_path(Path(record['detector_backup'])))
        else:
            need(detector_is_previous(detector, record), 'Detector state is ambiguous; refusing account-only rollback')
        restore_account(folder, db=db)
    print('PAIR_ROLLBACK_SUCCESS: compatible previous services restored; all live data retained')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('preflight')
    deploy_command = commands.add_parser('deploy')
    deploy_command.add_argument('revision')
    rollback_command = commands.add_parser('rollback')
    rollback_command.add_argument('backup', type=Path)
    args = parser.parse_args()
    need(os.geteuid() == 0, 'Run as root')
    os.umask(0o077)
    def interrupted(signum, frame):
        raise ReleaseError('Deployment interrupted')
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    # Same lock order for every pair operation; the imported detector functions
    # use their drain window, while this holds their usual CLI deployment lock.
    with open('/run/lock/gewu-platform-deploy.lock', 'a') as app_lock, open('/run/lock/gewu-detector-deploy.lock', 'a') as detector_lock:
        fcntl.flock(app_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(detector_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'preflight':
            preflight()
        elif args.command == 'deploy':
            deploy(args.revision)
        else:
            rollback(args.backup)


if __name__ == '__main__':
    try:
        main()
    except BaseException as exc:
        if isinstance(exc, SystemExit):
            raise
        detail = str(exc) if isinstance(exc, ReleaseError) else type(exc).__name__
        print('FAIL: ' + detail, file=sys.stderr)
        sys.exit(1)

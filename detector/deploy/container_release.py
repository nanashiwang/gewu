#!/usr/bin/env python3
"""Pinned GitHub release -> isolated smoke -> reversible gewu.service migration.

Uses only the Python standard library. Never executes code from a moving branch,
prints environment values, touches another service, or prunes shared Docker data.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

REPO = 'nanashiwang/gewu'
IMAGE = 'ghcr.io/nanashiwang/gewu-detector'
ROOT = Path('/opt/gewu-detector')
RELEASES = Path('/opt/gewu-detector-releases')
BACKUPS = Path('/opt/gewu-deploy-backups')
STAGING = Path('/opt/gewu-deploy-staging')
DROPIN = Path('/etc/systemd/system/gewu.service.d/50-container.conf')
STATE = ROOT / '.container-release.json'
NAME = 'gewu-detector'
SMOKE = 'gewu-detector-release-smoke'
OWNER = 'org.gewu.component=detector'
PROTECTED = [Path('/etc/gewu.env'), Path('/etc/nginx'),
             Path('/etc/systemd/system/gewu.service'), Path('/etc/gewu-monitor'),
             Path('/etc/systemd/system/gewu-monitor@.service'),
             Path('/etc/systemd/system/gewu-monitor@.timer'),
             Path('/opt/gewu-platform/shared/.env'),
             ROOT / 'data/baselines', ROOT / 'src/data/baselines',
             ROOT / 'private_monitor', ROOT / 'private_baseline_candidates',
             ROOT / 'report_fonts']


class DeploymentError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def run(*args, timeout=60, check=True):
    # Only allowlisted operation names are safe: never echo arguments or stderr.
    operation = Path(args[0]).name
    safe_docker = {('image', 'inspect'), ('pull',), ('load',), ('ps',),
                   ('inspect',), ('run',), ('exec',), ('rm',), ('info',)}
    if operation == 'docker':
        for prefix in safe_docker:
            if tuple(args[1:1 + len(prefix)]) == prefix:
                operation += ' ' + ' '.join(prefix)
                break
    try:
        result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise DeploymentError(f'{operation} timed out after {timeout}s') from None
    if check and result.returncode:
        raise DeploymentError(f'{operation} failed (exit {result.returncode})')
    return result


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_atomic(path, value):
    require(not path.is_symlink(), f'Symlink refused: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.gewu-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def validate_manifest(data, revision):
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'Expected a full Git commit SHA')
    require(isinstance(data, dict) and data.get('revision') == revision, 'Release revision mismatch')
    require(data.get('platform') == 'linux/amd64', 'Unsupported release platform')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', data.get('image_id', '')), 'Invalid image ID')
    require(re.fullmatch(r'[0-9a-f]{64}', data.get('archive_sha256', '')), 'Invalid archive hash')
    require(re.fullmatch(re.escape(IMAGE) + r'@sha256:[0-9a-f]{64}', data.get('image', '')),
            'Unexpected image repository/digest')
    return data


def download(url, target, limit):
    request = Request(url, headers={'User-Agent': 'gewu-container-release/1'})
    require(target.resolve() == target and not target.exists(), 'Unsafe download target')
    fd, temporary = tempfile.mkstemp(prefix='.download-', dir=target.parent)
    try:
        with urlopen(request, timeout=60) as response, os.fdopen(fd, 'wb') as stream:
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                require(size <= limit, 'Release asset exceeds size limit')
                stream.write(chunk)
        os.replace(temporary, target)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        Path(temporary).unlink(missing_ok=True)


def inspect(name):
    result = run('docker', 'inspect', name, check=False)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def owned(info):
    return bool(info and info.get('Config', {}).get('Labels', {}).get('org.gewu.component') == 'detector')


def remove_owned(name):
    info = inspect(name)
    if info:
        require(owned(info), f'Refusing unrelated container: {name}')
        run('docker', 'rm', '-f', name)


def protected_snapshot():
    files = {}
    for root in PROTECTED:
        entries = [root] if root.is_file() else sorted(root.rglob('*')) if root.exists() else []
        for path in entries:
            if path.is_file():
                files[str(path)] = sha(path)
    # Existing report evidence must stay byte-for-byte intact. New reports are allowed.
    reports = {str(p): sha(p) for p in (ROOT / 'web_data/jobs').rglob('*.json') if p.is_file()}
    ids = run('docker', 'ps', '-aq').stdout.split()
    rows = run('docker', 'inspect', '--format', '{{.Name}} {{.Id}} {{.State.StartedAt}}', *ids).stdout.splitlines() if ids else []
    other = {name: (identity, started) for name, identity, started in map(str.split, rows)
             if name.lstrip('/') not in {NAME, SMOKE}}
    return {'files': files, 'reports': reports, 'containers': other,
            'account_release': str(Path('/opt/gewu-platform/current').resolve())}


def verify_protected(before):
    after = protected_snapshot()
    require(before['files'] == after['files'], 'Protected configuration/baseline changed')
    require(before['containers'] == after['containers'], 'Another container changed')
    require(before['account_release'] == after['account_release'], 'Account platform release changed')
    require(all(after['reports'].get(k) == v for k, v in before['reports'].items()),
            'Existing report evidence changed')
    print(f"PASS: protected data and {len(before['containers'])} other containers unchanged")


def idle():
    for path in (ROOT / 'web_data/jobs/.task_state').glob('*.state'):
        require(json.loads(path.read_text()).get('status') not in {'queued', 'running'},
                'Active detector job; retry during an idle window')
    active = run('systemctl', 'list-units', '--state=running', '--no-legend', 'gewu-monitor*').stdout
    require(not active.strip(), 'Scheduled monitor is running')
    logs = run('journalctl', '-u', 'gewu.service', '--since', '10 minutes ago',
               '--no-pager', '-o', 'cat').stdout
    require(not re.search(r'"POST /api/detect[^ ]* HTTP/[^" ]+" 2\d\d', logs),
            'Recent detector submission; wait for a quiet 10-minute window')
    print('PASS: detector and scheduled monitor idle')


def env_names(content):
    """Read names only; systemd itself continues parsing quoted secret values."""
    names = set()
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        match = re.match(r'([A-Z_][A-Z0-9_]*)\s*=', line)
        require(match is not None and not line.endswith('\\'), 'Unsupported multiline environment file')
        key = match.group(1)
        # Only application settings enter the web container; provider keys stay out.
        if key.startswith('GEWU_'):
            require(not key.endswith('_PATH') or key in {'GEWU_WISHLIST_PATH'},
                    f'Custom file setting requires an explicit container mount: {key}')
            expected_paths = {'GEWU_JOBS_DIR': str(ROOT / 'web_data/jobs'),
                              'GEWU_WISHLIST_PATH': str(ROOT / 'web_data/wishlist.txt'),
                              'GEWU_BASELINES_DIR': str(ROOT / 'data/baselines')}
            if key in expected_paths:
                values = shlex.split(line[match.end():].strip())
                require(values == [expected_paths[key]], f'Unexpected {key}; migration requires review')
            names.add(key)
    return names


def preflight():
    require(os.geteuid() == 0, 'Run as root')
    require(run('uname', '-m').stdout.strip() == 'x86_64', 'This release requires x86_64')
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'Unexpected detector installation')
    require(Path('/etc/gewu.env').is_file(), 'Missing /etc/gewu.env')
    require((ROOT / 'web_data/jobs').is_dir(), 'Missing persistent jobs directory')
    require((ROOT / 'data/baselines').is_dir(), 'Missing operator baseline directory')
    for path in [ROOT / 'web_data', ROOT / 'data/baselines', ROOT / 'report_fonts',
                 RELEASES, BACKUPS, STAGING, DROPIN.parent]:
        require(path.resolve() == path, f'Symlink path refused: {path}')
    account = pwd.getpwnam('gewu')
    require(account.pw_uid > 0 and account.pw_gid > 0, 'Expected non-root gewu service account')
    run('docker', 'info')
    require(shutil.disk_usage(ROOT).free >= 1024**3, 'At least 1 GiB free disk space required')
    require(run('systemctl', 'is-active', 'gewu.service', check=False).stdout.strip() == 'active',
            'Existing service must be healthy before migration')
    envfiles = run('systemctl', 'show', 'gewu.service', '-p', 'EnvironmentFiles', '--value').stdout.strip()
    require(envfiles == '/etc/gewu.env (ignore_errors=yes)', 'Unexpected service EnvironmentFile configuration')
    info = inspect(NAME)
    require(info is None or (owned(info) and DROPIN.is_file() and STATE.is_file()),
            'Container name already in use outside this deployment')
    require(inspect(SMOKE) is None, 'Existing smoke container requires inspection')
    require(not DROPIN.is_symlink() and not STATE.is_symlink(), 'Symlink deployment metadata refused')
    if DROPIN.exists():
        require(STATE.is_file() and '# Managed by gewu container release' in DROPIN.read_text(),
                'Existing unrecognized service override')
    # Refuse silently moving an already-populated legacy baseline directory.
    legacy = ROOT / 'src/data/baselines'
    require(not legacy.exists() or not any(legacy.rglob('*.json')),
            'Legacy src/data/baselines contains evidence; reconcile it before migration')
    names = env_names(Path('/etc/gewu.env').read_text())
    inline = run('systemctl', 'show', 'gewu.service', '-p', 'Environment', '--value').stdout
    for setting in shlex.split(inline):
        key, _, value = setting.partition('=')
        if key.startswith('GEWU_'):
            names.add(key)
            if key in {'GEWU_JOBS_DIR', 'GEWU_WISHLIST_PATH'}:
                expected = str(ROOT / ('web_data/jobs' if key == 'GEWU_JOBS_DIR' else 'web_data/wishlist.txt'))
                require(value == expected, f'Unexpected {key}; migration requires review')
    idle()
    print('PASS: preflight (no environment values disclosed)')
    return account.pw_uid, account.pw_gid, names


def base_args(name, image, uid, gid, *, smoke=False):
    args = ['docker', 'run', '--rm', '--name', name, '--pull', 'never',
            '--label', OWNER, '--user', f'{uid}:{gid}', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--pids-limit', '256', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
            '--network', 'none' if smoke else 'host']
    if smoke:
        args += ['--tmpfs', f'{ROOT}/web_data:rw,nosuid,nodev,size=32m,uid={uid},gid={gid},mode=700']
    else:
        args += ['--mount', f'type=bind,src={ROOT}/web_data,dst={ROOT}/web_data',
                 '--mount', f'type=bind,src={ROOT}/data/baselines,dst={ROOT}/data/baselines,readonly']
        if (ROOT / 'report_fonts').is_dir():
            args += ['--mount', f'type=bind,src={ROOT}/report_fonts,dst={ROOT}/report_fonts,readonly']
    return args


def unit_override(image, uid, gid, names):
    args = base_args(NAME, image, uid, gid)
    for key in sorted(names - {'GEWU_RELEASE_ID', 'GEWU_BASELINES_DIR'}):
        args += ['--env', key]
    args += [image]
    # Fixed paths/names only; reject systemd specifier/expansion injection.
    require(all(re.fullmatch(r'[A-Za-z0-9_./:=,@-]+', arg) for arg in args), 'Unsafe unit argument')
    docker = shutil.which('docker')
    require(docker and re.fullmatch(r'/[A-Za-z0-9_./-]+', docker), 'Unexpected Docker executable path')
    args[0] = docker
    return ('# Managed by gewu container release\n[Unit]\nRequires=docker.service\nAfter=docker.service\n'
            '[Service]\nUser=root\nGroup=root\nExecStartPre=\nExecStart=\n'
            'ExecStart=' + ' '.join(args) + '\nExecStop=\n'
            f'ExecStop={docker} stop --time 40 {NAME}\nTimeoutStopSec=60\n')


def wait_health(name):
    for _ in range(45):
        info = inspect(name)
        if info and info['State'].get('Health', {}).get('Status') == 'healthy':
            return
        if info and not info['State'].get('Running'):
            break
        time.sleep(1)
    raise DeploymentError('Container readiness check failed')


def smoke_image(image, uid, gid):
    try:
        args = base_args(SMOKE, image, uid, gid, smoke=True)
        run(*args, '-d', image)
        wait_health(SMOKE)
        code = ("import urllib.request; "
                "paths=['/','/leaderboard/sources','/api/status/detection-scope?protocol=openai&model=gpt-6-luna&wire_api=responses']; "
                "assert all(urllib.request.urlopen('http://127.0.0.1:8765'+p,timeout=5).status==200 for p in paths)")
        run('docker', 'exec', SMOKE, 'python', '-c', code)
        print('PASS: isolated image smoke test; no upstream network access')
    finally:
        remove_owned(SMOKE)
        require(inspect(SMOKE) is None, 'Smoke container cleanup failed')
        print('GEWU_LEFTOVER_TEST_CONTAINERS=0')


def acquire(revision):
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'Expected a full Git commit SHA')
    RELEASES.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = RELEASES / revision
    require(directory.resolve() == directory, 'Symlink release directory refused')
    directory.mkdir(mode=0o700, exist_ok=True)
    manifest_path = directory / 'release.json'
    base = f'https://github.com/{REPO}/releases/download/detector-{revision}'
    if not manifest_path.exists():
        download(base + '/release.json', manifest_path, 65536)
    data = validate_manifest(json.loads(manifest_path.read_text()), revision)
    # A registry digest is portable; Docker's local Id is not. Classic stores
    # expose the config digest, while containerd stores can expose a manifest ID.
    print('STEP: checking pinned registry digest', flush=True)
    result = run('docker', 'image', 'inspect', data['image'], check=False)
    source = 'registry'
    if result.returncode:
        result = run('docker', 'image', 'inspect', data['image_id'], check=False)
        source = 'publisher-id'
    if result.returncode:
        print('STEP: pulling pinned registry digest', flush=True)
        pulled = run('docker', 'pull', data['image'], timeout=300, check=False)
        if not pulled.returncode:
            result = run('docker', 'image', 'inspect', data['image'])
            source = 'registry'
        else:
            # Never trust an existing revision tag. Only resolve it immediately
            # after loading this release's checksum-verified archive.
            print('STEP: loading checksum-verified release archive', flush=True)
            archive = directory / 'detector-image.tar.gz'
            if archive.exists() and sha(archive) != data['archive_sha256']:
                archive.unlink()
            if not archive.exists():
                download(base + '/detector-image.tar.gz', archive, 1024**3)
            require(sha(archive) == data['archive_sha256'], 'Image archive checksum mismatch')
            loaded = run('docker', 'load', '--input', str(archive), timeout=300)
            tag = f'{IMAGE}:{revision}'
            require(f'Loaded image: {tag}' in loaded.stdout.splitlines(),
                    'Verified archive did not load the expected revision tag')
            result = run('docker', 'image', 'inspect', tag)
            source = 'verified-archive'
    entries = json.loads(result.stdout)
    require(isinstance(entries, list) and len(entries) == 1 and isinstance(entries[0], dict),
            'Expected exactly one inspected image')
    info = entries[0]
    runtime_id = info.get('Id', '')
    require(isinstance(runtime_id, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', runtime_id),
            'Invalid resolved image ID')
    if source == 'registry':
        require(data['image'] in (info.get('RepoDigests') or []), 'Pinned registry digest mismatch')
    elif source == 'publisher-id':
        require(runtime_id == data['image_id'], 'Cached image ID mismatch')
    labels = (info.get('Config') or {}).get('Labels') or {}
    require(labels.get('org.opencontainers.image.revision') == revision, 'Image commit label mismatch')
    require(labels.get('org.gewu.component') == 'detector', 'Image ownership label mismatch')
    require(info.get('Os') == 'linux' and info.get('Architecture') == 'amd64', 'Image platform mismatch')
    print(f'PASS: verified image {revision} via {source}; runtime ID {runtime_id}', flush=True)
    # Retain the publisher's original identity for audit; run only the validated
    # local content-addressed ID, never a mutable tag.
    return {**data, 'runtime_image_id': runtime_id}


def healthy_service():
    run('systemctl', 'is-active', '--quiet', 'gewu.service')
    with urlopen('http://127.0.0.1:8765/readyz', timeout=5) as response:
        data = json.load(response)
    require(data.get('ok') is True and data.get('storage_writable') is True, 'Service readiness failed')


def settle_stopped_container():
    # A Docker create request can finish after systemd has stopped its CLI client.
    # Require a stable empty interval before restarting the previous service.
    quiet = 0
    for _ in range(15):
        info = inspect(NAME)
        if info is not None:
            remove_owned(NAME)
            quiet = 0
        else:
            quiet += 1
            if quiet >= 4:
                return
        time.sleep(1)
    raise DeploymentError('Container did not settle after service stop')


def restore(backup):
    require(backup.parent == BACKUPS and backup.resolve() == backup and backup.is_dir(), 'Invalid rollback directory')
    data = json.loads((backup / 'rollback.json').read_text())
    run('systemctl', 'stop', 'gewu.service')
    settle_stopped_container()
    for path, key in [(DROPIN, 'dropin'), (STATE, 'state')]:
        if data[key] is None:
            path.unlink(missing_ok=True)
        else:
            write_atomic(path, data[key])
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', 'gewu.service')
    for _ in range(45):
        try:
            healthy_service()
            print('ROLLBACK_SUCCESS: previous gewu.service restored')
            return
        except Exception:
            time.sleep(1)
    raise DeploymentError('Rollback health check failed; inspect gewu.service locally')


def deploy(revision):
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'Expected a full Git commit SHA')
    uid, gid, names = preflight()
    healthy_service()
    before = protected_snapshot()
    data = acquire(revision)
    image = data['runtime_image_id']
    smoke_image(image, uid, gid)
    # Probe real volume permissions without importing jobs.py or touching report data.
    probe = ('import tempfile,os; '
             'f=tempfile.NamedTemporaryFile(dir="/opt/gewu-detector/web_data/jobs"); f.close(); '
             'assert os.access("/opt/gewu-detector/data/baselines",os.R_OK|os.X_OK)')
    try:
        run(*base_args(SMOKE, image, uid, gid), '--entrypoint', 'python', image, '-c', probe)
    finally:
        remove_owned(SMOKE)
    idle()
    backup = BACKUPS / ('container-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    rollback = {'dropin': DROPIN.read_text() if DROPIN.exists() else None,
                'state': STATE.read_text() if STATE.exists() else None}
    write_atomic(backup / 'rollback.json', json.dumps(rollback))
    write_atomic(backup / 'protected-before.json', json.dumps(before))
    changed = False
    try:
        changed = True
        run('systemctl', 'stop', 'gewu.service')
        write_atomic(DROPIN, unit_override(image, uid, gid, names))
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'gewu.service')
        wait_health(NAME)
        healthy_service()
        verify_protected(before)
        write_atomic(STATE, json.dumps({**data, 'backup': str(backup)}, indent=2) + '\n')
        changed = False
    finally:
        if changed:
            restore(backup)
    require(inspect(SMOKE) is None, 'Temporary container remains')
    print('GEWU_LEFTOVER_TEST_CONTAINERS=0')
    print('DEPLOY_SUCCESS=' + revision)
    print('ROLLBACK_DIRECTORY=' + str(backup))
    print('Host source tree and its .deployed-commit are retained for rollback/monitor tasks.')


def cleanup_candidates(root, now=None):
    """Only old, recognized staging packages; never backups, images or reports."""
    now = time.time() if now is None else now
    if not root.exists():
        return []
    require(root.resolve() == root, 'Symlink staging root refused')
    directories = sorted((p for p in root.iterdir() if p.is_dir() and not p.is_symlink()),
                         key=lambda p: p.stat().st_mtime, reverse=True)
    candidates = []
    for path in directories[2:]:  # Always keep the two most recent staging directories.
        if not re.fullmatch(r'20\d{6}-[a-z0-9-]+', path.name):
            continue
        if now - path.stat().st_mtime < 30 * 86400:
            continue
        marker = path / 'deployment-manifest.json'
        if not marker.is_file() or any(p.is_symlink() for p in path.rglob('*')):
            continue
        try:
            data = json.loads(marker.read_text())
            if not all(re.fullmatch(r'[0-9a-f]{40}', data.get(k, '')) for k in ('before', 'after')):
                continue
            # Private data directories are never interpreted as deployment garbage.
            if any(p.name in {'web_data', 'private_monitor', 'private_baseline_candidates',
                              'report_fonts', 'baselines', 'venv'} for p in path.rglob('*') if p.is_dir()):
                continue
            files = [p for p in path.rglob('*') if p.is_file()]
            # Newer contents imply the stage was recently used, even if its root is old.
            if any(now - p.stat().st_mtime < 30 * 86400 for p in files):
                continue
            candidates.append({'path': str(path), 'bytes': sum(p.stat().st_size for p in files),
                               'reason': 'recognized staging package older than 30 days'})
        except (ValueError, TypeError):
            continue
    return candidates


def cleanup(apply=False):
    require(STATE.is_file(), 'Cleanup is available only after successful container deployment')
    healthy_service()
    require(owned(inspect(NAME)), 'Expected managed detector container')
    idle()
    candidates = cleanup_candidates(STAGING)
    print(json.dumps({'cleanup_candidates': candidates, 'apply': apply}, ensure_ascii=False, indent=2))
    if apply:
        # Re-evaluate immediately before deleting, under the deployment lock.
        require(candidates == cleanup_candidates(STAGING), 'Cleanup candidates changed')
        for item in candidates:
            shutil.rmtree(item['path'])
        print('CLEANED_BYTES=' + str(sum(x['bytes'] for x in candidates)))
        print('CLEANED_DIRECTORIES=' + str(len(candidates)))
        report = RELEASES / ('cleanup-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.json')
        write_atomic(report, json.dumps(candidates, ensure_ascii=False, indent=2) + '\n')
        print('CLEANUP_REPORT=' + str(report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('preflight')
    command = commands.add_parser('deploy')
    command.add_argument('revision')
    command = commands.add_parser('rollback')
    command.add_argument('backup', type=Path)
    command = commands.add_parser('cleanup')
    command.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run as root')
    os.umask(0o077)
    def interrupted(signum, frame):
        raise DeploymentError('Deployment interrupted')
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    with open('/run/lock/gewu-detector-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'preflight':
            preflight()
        elif args.command == 'deploy':
            deploy(args.revision)
        elif args.command == 'rollback':
            restore(args.backup)
        else:
            cleanup(args.apply)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        # Exceptions never include the contents of environment files or command stderr.
        print(f'FAIL: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)

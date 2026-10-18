#!/usr/bin/env python3
"""Pinned GitHub release -> isolated smoke -> reversible gewu.service migration.

Uses only the Python standard library. Never executes code from a moving branch,
prints environment values, touches another service, or prunes shared Docker data.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import math
import stat
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
# systemd can spend TimeoutStopSec on ExecStop and again terminating the main
# process. Let both 60-second phases finish before timing out its CLI client.
STOP_TIMEOUT = 150
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
    safe_operations = {
        'docker': {('image', 'inspect'), ('pull',), ('load',), ('ps',),
                   ('inspect',), ('run',), ('exec',), ('rm',), ('info',)},
        'systemctl': {('stop',), ('start',), ('is-active',), ('daemon-reload',),
                      ('show',), ('list-units',)},
    }
    if operation in safe_operations:
        for prefix in safe_operations[operation]:
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


def preflight(*, require_idle=True):
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
    if require_idle:
        idle()
    print('PASS: preflight (no environment values disclosed)')
    return account.pw_uid, account.pw_gid, names


def resource_limits(*, cpus=None, memory_mib=None):
    """Bound only the detector, leaving headroom on a shared host."""
    mem = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        mem[key] = int(value.split()[0]) * 1024
    total_mib = mem['MemTotal'] // (1024 * 1024)
    require(mem['MemAvailable'] >= 192 * 1024**2, 'Host has less than 192 MiB available; postpone deployment')
    max_cpus = max(0.5, (os.cpu_count() or 1) / 2)
    cpus = min(1.0, max_cpus) if cpus is None else cpus
    require(math.isfinite(cpus) and 0.25 <= cpus <= max_cpus,
            'CPU budget must be at least 0.25 and at most half the host CPUs')
    info = inspect(NAME)
    peak = 0
    if info:
        require(owned(info), 'Refusing resource probe of an unrelated container')
        if info['State'].get('Running'):
            code = ("from pathlib import Path; "
                    "paths=[Path('/sys/fs/cgroup/memory.peak'),Path('/sys/fs/cgroup/memory/memory.max_usage_in_bytes')]; "
                    "print(next((p.read_text().strip() for p in paths if p.is_file()),'unknown'))")
            value = run('docker', 'exec', NAME, 'python', '-c', code).stdout.strip()
            require(value.isdecimal(), 'Cannot read detector memory peak; resource budget requires review')
            peak = int(value)
    needed = max(512, math.ceil(peak * 1.5 / (64 * 1024**2)) * 64)
    if memory_mib is None:
        cap = min(1024, total_mib // 4 // 64 * 64)
        require(needed <= cap, 'Observed detector memory peak needs more than the automatic shared-host budget; review --memory-mib')
        memory_mib = needed
    require(isinstance(memory_mib, int) and needed <= memory_mib <= total_mib // 2,
            'Memory budget must cover observed peak plus 50% headroom, at least 512 MiB, and at most half host RAM')
    require(mem['MemAvailable'] >= (memory_mib + 192) * 1024**2,
            'Insufficient available RAM for the temporary detector budget plus 192 MiB reserve; postpone deployment')
    limits = {'cpus': f'{cpus:g}', 'memory_mib': memory_mib}
    print('RESOURCE_BUDGET=' + json.dumps({**limits, 'observed_peak_mib': math.ceil(peak / 1024**2)}), flush=True)
    return limits


def verify_resource_limits(name, limits):
    info = inspect(name)
    require(owned(info), 'Expected managed detector container for resource verification')
    config = info['HostConfig']
    size = limits['memory_mib'] * 1024**2
    require(config.get('Memory') == size and config.get('MemorySwap') == size and
            config.get('NanoCpus') == round(float(limits['cpus']) * 10**9),
            'Docker did not apply the requested CPU/memory/swap limits')
    require(not info['State'].get('OOMKilled'), 'Detector exceeded its memory budget')
    print('PASS: detector CPU and memory limits applied; no additional swap', flush=True)


def ready_state():
    with urlopen('http://127.0.0.1:8765/readyz', timeout=5) as response:
        data = json.load(response)
    require(data.get('ok') is True and data.get('storage_writable') is True, 'Service readiness failed')
    return data


def monitor_idle():
    active = run('systemctl', 'list-units', '--state=running', '--no-legend', 'gewu-monitor*').stdout
    return not active.strip()


@contextmanager
def deployment_window(*, wait_seconds=300, bootstrap=False):
    """Keep admission closed until verification/rollback completes; crash releases it."""
    require(0 <= wait_seconds <= 1800, 'Drain wait must be between 0 and 1800 seconds')
    supported = ready_state().get('deployment', {}).get('protocol') == 1
    if not supported:
        require(bootstrap, 'Current service lacks drain support; first upgrade requires --bootstrap-drain and a quiet window')
    path = ROOT / 'web_data/.gewu-deployment.lock'
    require(path.resolve() == path, 'Symlink deployment lock refused')
    fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o644)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_nlink == 1, 'Invalid deployment lock')
        os.fchmod(fd, 0o644)
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, 'Timed out closing admission; service was not stopped')
                time.sleep(0.25)
        if not supported:
            # The old process ignores this lock, but the replacement must start
            # behind it so verification/rollback cannot interrupt newly accepted jobs.
            idle()
            print('BOOTSTRAP: legacy service cannot close admission; using quiet-window checks for this first upgrade', flush=True)
            yield False
            return
        last = None
        while True:
            require(os.stat(path, follow_symlinks=False).st_ino == os.fstat(fd).st_ino,
                    'Deployment admission lock replaced')
            state = ready_state().get('deployment', {})
            require(state.get('protocol') == 1 and state.get('accepting') is False,
                    'Service did not acknowledge closed admission')
            counts = (state.get('pending_jobs'), state.get('active_tasks'))
            require(all(type(n) is int and n >= 0 for n in counts), 'Invalid drain state')
            idle_monitor = monitor_idle()
            current = (*counts, idle_monitor)
            if current != last:
                print(f'DRAIN: pending={counts[0]} active={counts[1]} monitor_idle={idle_monitor}', flush=True)
                last = current
            if counts == (0, 0) and idle_monitor:
                break
            require(time.monotonic() < deadline, 'Drain timed out; existing tasks continue and admission will reopen')
            time.sleep(1)
        print('PASS: admission closed and existing detection tasks finished', flush=True)
        yield True
    finally:
        os.close(fd)
        # Do not unlink: a waiter or the replacement container can hold this inode.
        print('PASS: deployment admission lock released', flush=True)


def base_args(name, image, uid, gid, *, smoke=False, limits=None):
    limits = limits or {'cpus': '1', 'memory_mib': 512}
    args = ['docker', 'run', '--rm', '--name', name, '--pull', 'never',
            '--label', OWNER, '--user', f'{uid}:{gid}', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--cpus', limits['cpus'], '--memory', f"{limits['memory_mib']}m",
            '--memory-swap', f"{limits['memory_mib']}m",
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


def unit_override(image, uid, gid, names, *, limits=None):
    args = base_args(NAME, image, uid, gid, limits=limits)
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


def smoke_image(image, uid, gid, *, limits=None):
    try:
        args = base_args(SMOKE, image, uid, gid, smoke=True, limits=limits)
        run(*args, '-d', image)
        wait_health(SMOKE)
        if limits is not None:
            verify_resource_limits(SMOKE, limits)
        code = """import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import secrets
from web import jobs, report_access
paths=['/','/leaderboard/sources','/api/status/detection-scope?protocol=openai&model=gpt-6-luna&wire_api=responses']
assert all(urlopen('http://127.0.0.1:8765'+p,timeout=5).status==200 for p in paths)
# Only the isolated smoke container's tmpfs is written. Never mounted reports.
root=Path('/opt/gewu-detector/web_data/jobs/openai')
root.mkdir(parents=True,exist_ok=True)
(root/'jpg-smoke-2026.json').write_text(json.dumps({'protocol':'openai','model':'fixture','results':[]}))
def download(_):
    with urlopen('http://127.0.0.1:8765/r/jpg-smoke-2026.jpg',timeout=20) as response:
        assert response.headers['Content-Type']=='image/jpeg'
        return response.read()
with ThreadPoolExecutor(max_workers=4) as pool:
    images=list(pool.map(download,range(4)))
assert all(data==images[0] and data.startswith(bytes([255,216])) and data.endswith(bytes([255,217])) for data in images)
assert not list(root.glob('.gewu-image-*.tmp'))
assert urlopen('http://127.0.0.1:8765/readyz',timeout=5).status==200
# Verify anonymous ownership and the real sanitized JPG path on tmpfs only.
job='privacy-smoke-2026'
owner=secrets.token_urlsafe(32)
report_access.create(jobs.JOBS_DIR,job,owner)
report={'_web_access':1,'protocol':'openai','mode':'quick','target_model':'fixture','base_url':'https://relay.example/private-fixture','results':[]}
jobs._atomic_json(jobs.report_path(job,'openai'),report)
assert not (jobs.JOBS_DIR/'openai'/f'{job}.json').exists()
headers={'X-Forwarded-Proto':'https','Cookie':'__Host-gewu_report_owner='+owner,'X-Gewu-Action':'report-sharing'}
def request(path, *, private=False, post=False):
    return urlopen(Request('http://127.0.0.1:8765'+path,data=b'' if post else None,headers=headers if private else {}),timeout=20)
def denied(path):
    try:
        request(path)
        raise AssertionError('private report became public')
    except HTTPError as error:
        assert error.code==404
for path in [f'/r/{job}',f'/r/{job}.jpg',f'/api/status/{job}',f'/api/result/{job}.json']:
    denied(path)
    assert request(path,private=True).status==200
link=json.load(request(f'/api/status/{job}/share',private=True,post=True))['url']
with request(link) as response:
    assert response.headers['Cache-Control']=='no-store'
    html=response.read().decode()
    assert 'relay.example' in html and 'private-fixture' not in html
with request(link+'.jpg') as response:
    image=response.read()
    assert response.headers['Cache-Control']=='no-store'
    assert image.startswith(bytes([255,216])) and image.endswith(bytes([255,217]))
assert request(f'/api/status/{job}/share/revoke',private=True,post=True).status==200
denied(link)
denied(link+'.jpg')
assert not list(jobs.JOBS_DIR.rglob('.gewu-image-*.tmp'))
print('PASS: private reports, summary JPG, revocation and legacy-reader isolation')
"""
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
    require(labels.get('org.opencontainers.image.source') == f'https://github.com/{REPO}',
            'Image source label mismatch')
    require(info.get('Os') == 'linux' and info.get('Architecture') == 'amd64', 'Image platform mismatch')
    print(f'PASS: verified image {revision} via {source}; runtime ID {runtime_id}', flush=True)
    # Retain the publisher's original identity for audit; run only the validated
    # local content-addressed ID, never a mutable tag.
    return {**data, 'runtime_image_id': runtime_id}


def healthy_service():
    run('systemctl', 'is-active', '--quiet', 'gewu.service')
    ready_state()


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
    run('systemctl', 'stop', 'gewu.service', timeout=STOP_TIMEOUT)
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


def deploy(revision, *, cpus=None, memory_mib=None, wait_seconds=300, bootstrap=False):
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'Expected a full Git commit SHA')
    uid, gid, names = preflight(require_idle=False)
    healthy_service()
    limits = resource_limits(cpus=cpus, memory_mib=memory_mib)
    data = acquire(revision)
    image = data['runtime_image_id']
    smoke_image(image, uid, gid, limits=limits)
    # Probe real volume permissions without importing jobs.py or touching report data.
    probe = ('import tempfile,os; '
             'f=tempfile.NamedTemporaryFile(dir="/opt/gewu-detector/web_data/jobs"); f.close(); '
             'assert os.access("/opt/gewu-detector/data/baselines",os.R_OK|os.X_OK)')
    try:
        run(*base_args(SMOKE, image, uid, gid, limits=limits), '--entrypoint', 'python', image, '-c', probe)
    finally:
        remove_owned(SMOKE)
    with deployment_window(wait_seconds=wait_seconds, bootstrap=bootstrap):
        # A job accepted during image preparation may have raised the live peak.
        resource_limits(cpus=float(limits['cpus']), memory_mib=limits['memory_mib'])
        before = protected_snapshot()
        backup = BACKUPS / ('container-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
        backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        rollback = {'dropin': DROPIN.read_text() if DROPIN.exists() else None,
                    'state': STATE.read_text() if STATE.exists() else None}
        write_atomic(backup / 'rollback.json', json.dumps(rollback))
        write_atomic(backup / 'protected-before.json', json.dumps(before))
        changed = False
        try:
            changed = True
            run('systemctl', 'stop', 'gewu.service', timeout=STOP_TIMEOUT)
            write_atomic(DROPIN, unit_override(image, uid, gid, names, limits=limits))
            run('systemctl', 'daemon-reload')
            run('systemctl', 'start', 'gewu.service')
            wait_health(NAME)
            healthy_service()
            verify_resource_limits(NAME, limits)
            require(ready_state().get('deployment', {}).get('protocol') == 1, 'New image lacks drain protocol')
            require(ready_state()['deployment'].get('accepting') is False, 'New image lost closed admission')
            verify_protected(before)
            write_atomic(STATE, json.dumps({**data, 'backup': str(backup), 'resources': limits}, indent=2) + '\n')
            changed = False
        finally:
            if changed:
                restore(backup)
    require(ready_state().get('deployment', {}).get('accepting') is True,
            'Service did not resume admission after deployment')
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
    command.add_argument('--cpus', type=float)
    command.add_argument('--memory-mib', type=int)
    command.add_argument('--drain-timeout', type=int, default=300)
    command.add_argument('--bootstrap-drain', action='store_true')
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
            deploy(args.revision, cpus=args.cpus, memory_mib=args.memory_mib,
                   wait_seconds=args.drain_timeout, bootstrap=args.bootstrap_drain)
        elif args.command == 'rollback':
            with deployment_window():
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

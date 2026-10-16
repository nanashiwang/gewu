#!/usr/bin/env python3
"""Destructive integration fixture: ONLY on a fresh GitHub-hosted CI runner."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('container_release.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.geteuid() == 0
    unit = Path('/etc/systemd/system/gewu.service')
    envfile = Path('/etc/gewu.env')
    for path in [r.ROOT, r.BACKUPS, r.RELEASES, r.DROPIN.parent, unit, envfile]:
        assert not path.exists(), f'Fixture refuses pre-existing path: {path}'
    assert r.inspect(r.NAME) is None and r.inspect(r.SMOKE) is None
    marker = Path('/tmp/gewu-container-ci-owned')
    marker.touch(exist_ok=False)
    image = os.environ['IMAGE']
    revision = os.environ['REVISION']
    info = json.loads(r.run('docker', 'image', 'inspect', image).stdout)[0]
    data = {'image_id': info['Id'], 'revision': revision}
    r.acquire = lambda _: data
    original_wait = r.wait_health
    try:
        r.run('useradd', '--system', '--user-group', '--no-create-home', 'gewu')
        (r.ROOT / 'web_data/jobs').mkdir(parents=True)
        (r.ROOT / 'data/baselines').mkdir(parents=True)
        (r.ROOT / 'data/baselines/keep.txt').write_text('operator baseline fixture')
        (r.ROOT / 'web_data/jobs/retained.json').write_text('{"fixture":"retained evidence"}')
        r.run('chown', '-R', 'gewu:gewu', str(r.ROOT / 'web_data'))
        envfile.write_text('GEWU_SITE_URL="https://gewu.example"\nGEWU_INTERNAL_API_TOKEN="fixture token with spaces"\n')
        envfile.chmod(0o600)
        (r.ROOT / 'original-server.py').write_text('''from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true,"storage_writable":true}')
HTTPServer(("127.0.0.1",8765), Handler).serve_forever()
''')
        template = Path(__file__).parents[1].joinpath('gewu.service').read_text()
        template = re.sub(r'ExecStart=.*?\nRestart=',
                          'ExecStart=/usr/bin/python3 /opt/gewu-detector/original-server.py\nRestart=',
                          template, flags=re.S)
        unit.write_text(template)
        r.run('systemctl', 'daemon-reload')
        r.run('systemctl', 'start', 'gewu.service')
        # Service start is asynchronous; give the fixture the same readiness budget.
        import time
        for _ in range(30):
            try:
                r.healthy_service()
                break
            except Exception:
                time.sleep(0.2)
        r.healthy_service()
        r.deploy(revision)
        state = json.loads(r.STATE.read_text())
        assert state['revision'] == revision
        r.run('docker', 'exec', r.NAME, 'python', '-c',
              'import os; assert os.environ["GEWU_INTERNAL_API_TOKEN"]=="fixture token with spaces"; assert os.environ["GEWU_SITE_URL"]=="https://gewu.example"; assert os.getuid()!=0')
        r.restore(Path(state['backup']))
        assert not r.STATE.exists() and not r.DROPIN.exists()
        assert r.inspect(r.NAME) is None
        r.healthy_service()
        print('PASS: real systemd migration, quoted settings, preserved data and manual rollback')
        def broken_cutover(name):
            if name == r.NAME:
                raise r.DeploymentError('injected cutover failure')
            original_wait(name)
        r.wait_health = broken_cutover
        try:
            r.deploy(revision)
            raise AssertionError('injected failure must not succeed')
        except r.DeploymentError as error:
            assert str(error) == 'injected cutover failure'
        assert not r.STATE.exists() and not r.DROPIN.exists()
        assert r.inspect(r.NAME) is None
        r.healthy_service()
        print('PASS: failed real cutover automatically restores original healthy service')
    finally:
        r.run('systemctl', 'stop', 'gewu.service', check=False)
        for name in [r.NAME, r.SMOKE]:
            r.remove_owned(name)
            assert r.inspect(name) is None
        pid = r.run('systemctl', 'show', 'gewu.service', '-p', 'MainPID', '--value').stdout.strip()
        assert pid in {'0', ''}, 'Fixture service process remains'
        for path in [r.ROOT, r.BACKUPS, r.RELEASES, r.DROPIN.parent]:
            if path.exists():
                shutil.rmtree(path)
        for path in [unit, envfile]:
            path.unlink(missing_ok=True)
        r.run('systemctl', 'daemon-reload')
        marker.unlink()
        print('GEWU_LEFTOVER_TEST_CONTAINERS=0')
        print('GEWU_LEFTOVER_TEST_SERVICE_PROCESSES=0')


if __name__ == '__main__':
    main()

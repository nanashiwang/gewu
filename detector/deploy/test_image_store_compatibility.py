#!/usr/bin/env python3
"""Real cross-store regression using an immutable, previously published image.

Runs only on disposable GitHub-hosted runners. Never changes production Docker.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('container_release.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

# This classic-store release reproduces the production mismatch on containerd.
REVISION = '4b68a08ce4274303ca238a2d03d62b8d2bfb9cfb'
PUBLISHER_ID = 'sha256:c7982b6e9397f3b10275d59838bbce1f053fb9f1f60953942f5eff6456077e6f'
REGISTRY_DIGEST = 'sha256:a3a4b082baff0a0cb6b6cd5aa673194f17467988407147703090fd69b81d659a'


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert r.inspect(r.SMOKE) is None
    original_run, original_download = r.run, r.download
    with tempfile.TemporaryDirectory(prefix='gewu-image-store-ci-') as temp:
        r.RELEASES = Path(temp)
        try:
            # The first pass must use the registry, not silently fall back.
            def registry_download(url, path, limit):
                assert path.name == 'release.json', 'Registry path must not fall back to archive'
                original_download(url, path, limit)
            r.download = registry_download
            data = r.acquire(REVISION)
            assert data['image_id'] == PUBLISHER_ID
            assert data['image'] == r.IMAGE + '@' + REGISTRY_DIGEST
            if os.environ['IMAGE_STORE'] == 'containerd':
                assert data['runtime_image_id'] != PUBLISHER_ID, 'Regression must reproduce cross-store ID difference'
            r.smoke_image(data['runtime_image_id'], 10001, 10001)
            assert r.acquire(REVISION)['runtime_image_id'] == data['runtime_image_id']
            print('PASS: real pinned-digest pull, cache reuse and isolated smoke')

            # Remove only the fixture image from this disposable daemon. A forced
            # registry denial exercises real archive download/load and resolution.
            original_run('docker', 'image', 'rm', data['runtime_image_id'])
            r.download = original_download
            denied = []
            def deny_pull(*args, **kwargs):
                if args[:2] == ('docker', 'pull'):
                    denied.append(args)
                    return subprocess.CompletedProcess(args, 1, '', 'injected registry denial')
                return original_run(*args, **kwargs)
            r.run = deny_pull
            archived = r.acquire(REVISION)
            assert len(denied) == 1, 'Archive path must really run'
            assert archived['image_id'] == PUBLISHER_ID
            r.smoke_image(archived['runtime_image_id'], 10001, 10001)
            print('PASS: real checksum-verified archive load and isolated smoke')
        finally:
            r.run, r.download = original_run, original_download
            r.remove_owned(r.SMOKE)
            assert r.inspect(r.SMOKE) is None
            print('GEWU_LEFTOVER_TEST_CONTAINERS=0')
            print('GEWU_LEFTOVER_TEST_BACKGROUND_PROCESSES=0')


if __name__ == '__main__':
    main()

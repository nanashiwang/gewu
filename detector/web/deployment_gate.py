"""Local admission lock shared with the deployment process, never an HTTP control.

The deployer holds an exclusive flock; admission holds a short shared flock.
Closing the deployer FD (including on crash) resumes admission automatically.
"""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat


class MaintenanceError(RuntimeError):
    pass


def lock_path(jobs_dir: Path) -> Path:
    return jobs_dir.parent / '.gewu-deployment.lock'


@contextmanager
def admission(jobs_dir: Path):
    path = lock_path(jobs_dir)
    fd = None
    try:
        # No truncation: all workers and the deployer must lock the same inode.
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        except FileNotFoundError:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_EXCL |
                             os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o644)
            except FileExistsError:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
            raise OSError('Invalid admission lock')
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        if os.stat(path, follow_symlinks=False).st_ino != os.fstat(fd).st_ino:
            raise OSError('Admission lock replaced')
    except OSError:
        if fd is not None:
            os.close(fd)
        raise MaintenanceError('Deployment admission is unavailable') from None
    try:
        yield
    finally:
        os.close(fd)


def accepting(jobs_dir: Path) -> bool:
    try:
        with admission(jobs_dir):
            return True
    except MaintenanceError:
        return False

"""Bound JPG work off the ASGI loop; shared requests don't duplicate rendering."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
import tempfile
from collections.abc import Callable

from starlette.concurrency import run_in_threadpool


class ImageQueueBusy(RuntimeError):
    pass


def _read_complete(path: Path) -> bytes | None:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    return data if data.startswith(b'\xff\xd8') and data.endswith(b'\xff\xd9') else None


def _render_atomic(path: Path, render: Callable[[], bytes]) -> bytes:
    cached = _read_complete(path)
    if cached is not None:
        return cached
    data = render()
    if not isinstance(data, bytes) or not (data.startswith(b'\xff\xd8') and data.endswith(b'\xff\xd9')):
        raise ValueError('Report renderer did not return a complete JPEG')
    fd, filename = tempfile.mkstemp(prefix='.gewu-image-', suffix='.tmp', dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return data


class ReportImageCache:
    """One render at a time, at most eight distinct in-flight report images.

    A disconnected requester doesn't cancel shared work or leave a partly
    written cache. Shutdown cancels waiting work and joins the active render.
    """
    def __init__(self, max_pending: int = 8):
        self.max_pending = max_pending
        self._tasks: dict[Path, asyncio.Task[bytes]] = {}
        self._active: set[asyncio.Task] = set()
        self._semaphore = asyncio.Semaphore(1)
        self._accepting = True

    def startup(self) -> None:
        if self._tasks:
            raise RuntimeError('Image work from previous lifespan has not finished')
        self._semaphore = asyncio.Semaphore(1)
        self._accepting = True

    def _finished(self, path: Path, task: asyncio.Task) -> None:
        if self._tasks.get(path) is task:
            self._tasks.pop(path, None)
        if not task.cancelled() and task.exception() is not None:
            # A renderer may include report evidence in an exception. Log type only.
            logging.getLogger('gewu').error('Report image generation failed (%s)', type(task.exception()).__name__)

    async def _generate(self, path: Path, render: Callable[[], bytes]) -> bytes:
        async with self._semaphore:
            task = asyncio.current_task()
            self._active.add(task)
            try:
                return await run_in_threadpool(_render_atomic, path, render)
            finally:
                self._active.discard(task)

    async def get(self, path: Path, render: Callable[[], bytes]) -> bytes:
        data = await run_in_threadpool(_read_complete, path)
        if data is not None:
            return data
        if not self._accepting:
            raise ImageQueueBusy('Image generation is shutting down')
        task = self._tasks.get(path)
        if task is None:
            if len(self._tasks) >= self.max_pending:
                raise ImageQueueBusy('Image generation queue is full')
            task = asyncio.create_task(self._generate(path, render))
            self._tasks[path] = task
            task.add_done_callback(lambda completed: self._finished(path, completed))
        return await asyncio.shield(task)

    async def shutdown(self) -> None:
        self._accepting = False
        pending = list(self._tasks.values())
        for task in pending:
            if task not in self._active:
                task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()


report_images = ReportImageCache()

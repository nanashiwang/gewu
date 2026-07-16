"""pytest setup that runs before test module imports.

web/jobs.py creates JOBS_DIR at import time. In production this is
/opt/xiance-ai/web_data/jobs (service-owned), which a developer laptop or CI
container can't write to. We override the path with a per-session temp
dir so the import doesn't fail.
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault(
    "XIANCE_JOBS_DIR",
    tempfile.mkdtemp(prefix="xiance-test-jobs-"),
)
os.environ.setdefault(
    "XIANCE_WISHLIST_PATH",
    tempfile.mkstemp(prefix="xiance-test-wishlist-")[1],
)

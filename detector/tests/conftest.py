"""pytest setup that runs before test module imports.

web/jobs.py creates JOBS_DIR at import time. In production this is
/opt/gewu-detector/web_data/jobs (service-owned), which a developer laptop or CI
container can't write to. We override the path with a per-session temp
dir so the import doesn't fail.
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault(
    "GEWU_JOBS_DIR",
    tempfile.mkdtemp(prefix="gewu-test-jobs-"),
)
os.environ.setdefault(
    "GEWU_WISHLIST_PATH",
    tempfile.mkstemp(prefix="gewu-test-wishlist-")[1],
)
os.environ.setdefault("GEWU_ALLOW_INSECURE_API", "1")

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from relay_detector.core.models import Protocol
from relay_detector.monitor import (
    monitor_output_path,
    normalize_target_id,
    resolve_monitor_api_key,
)
from web.jobs import is_valid_job_id


DETECTOR_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "value",
    ["../escape", "a/b", "a\\b", ".hidden", "trailing-", "", "a" * 65],
)
def test_monitor_target_id_rejects_path_and_ambiguous_values(value: str):
    with pytest.raises(ValueError):
        normalize_target_id(value)


def test_monitor_target_id_normalizes_case():
    assert normalize_target_id("GPT-Sol-Hourly") == "gpt-sol-hourly"


def test_monitor_output_path_stays_in_protocol_directory(tmp_path: Path):
    path = monitor_output_path(
        tmp_path,
        Protocol.OPENAI,
        "gpt-sol-hourly",
        now=datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc),
        nonce="deadbeef",
    )
    assert path.parent == (tmp_path / "openai").resolve()
    assert path.name == "monitor-gpt-sol-hourly-20260716T120000000000Z-deadbeef.json"
    assert 8 <= len(path.stem) <= 64


def test_monitor_output_path_normalizes_dots_and_truncates_for_public_job_id(tmp_path: Path):
    path = monitor_output_path(
        tmp_path,
        Protocol.ANTHROPIC,
        "very.long.monitor.target.identifier.with.extra.parts",
        now=datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc),
        nonce="deadbeef",
    )
    assert "." not in path.stem
    assert is_valid_job_id(path.stem)


def test_monitor_key_uses_environment_reference_without_exposing_value(monkeypatch):
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    monkeypatch.setenv("MY_MONITOR_KEY", "secret-value")
    assert resolve_monitor_api_key("MY_MONITOR_KEY") == "secret-value"


def test_systemd_credential_takes_precedence(tmp_path: Path, monkeypatch):
    (tmp_path / "api_key").write_text("credential-value\n", encoding="utf-8")
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(tmp_path))
    monkeypatch.setenv("MY_MONITOR_KEY", "environment-value")
    assert resolve_monitor_api_key("MY_MONITOR_KEY") == "credential-value"


def test_monitor_key_rejects_invalid_environment_reference(monkeypatch):
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    with pytest.raises(ValueError):
        resolve_monitor_api_key("BAD-NAME")


def test_monitor_systemd_unit_keeps_key_out_of_command_line():
    service = (DETECTOR_ROOT / "gewu-monitor@.service").read_text(encoding="utf-8")
    assert "LoadCredential=api_key:/etc/gewu-monitor/%i.key" in service
    assert "monitor-once --target-id %i" in service
    assert "--api-key" not in service
    assert "UMask=0077" in service
    assert "ProtectSystem=strict" in service


def test_monitor_timer_is_hourly_with_jitter_and_persistence():
    timer = (DETECTOR_ROOT / "gewu-monitor@.timer").read_text(encoding="utf-8")
    assert "OnUnitActiveSec=1h" in timer
    assert "RandomizedDelaySec=10min" in timer
    assert "Persistent=true" in timer

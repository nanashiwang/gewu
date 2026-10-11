from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from relay_detector.ranking import assess_ranking_eligibility
from web import leaderboard, server
from web.observations import monitoring_snapshot
from web.public_rankings import PublicRankingSite


def report(**changes):
    now = datetime.now(timezone.utc)
    return {
        "base_url": "https://relay.example/v1",
        "protocol": "openai", "target_model": "model-a", "mode": "quick",
        "timestamp": now.isoformat(), "total_score": 90, "verdict": "passed",
        "results": [{"name": "basic_request", "status": "pass"}],
        "ranking_evidence": {
            "eligible": True, "source": "operator_monitor", "review_status": "approved",
            "detector_version": "build-a", "baseline_version": "not_available",
            "reviewer": "operator", "reviewed_at": now.isoformat(),
        },
        **changes,
    }


@pytest.fixture
def stage(tmp_path, monkeypatch):
    monkeypatch.setattr(leaderboard, "REPORT_DIRS", [tmp_path])
    monkeypatch.setattr(server, "_public_rankings_cache", None)
    monkeypatch.setattr(server, "_monitor_cache", None)
    monkeypatch.setattr(server, "_public_detail_cache", {})

    def write(name, data):
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return path
    return write


def test_fixed_first_party_record_cannot_bypass_report_approval(stage, monkeypatch):
    monkeypatch.setattr(server, "RED_RANKING", (
        PublicRankingSite("fixed.example", 100, 99, datetime.now(timezone.utc).date().isoformat(),
                          ("openai",), source_kind="gewu_test"),
    ))
    monkeypatch.setattr(server, "BLACK_RANKING", ())
    snapshot = server._compute_public_ranking_snapshot()
    assert snapshot["metrics"]["site_count"] == 0
    stage("approved", report())
    snapshot = server._compute_public_ranking_snapshot()
    assert [s.domain for s in snapshot["red_sites"]] == ["relay.example"]


def test_old_scores_do_not_contaminate_recent_scores_and_all_sources_expire(stage, monkeypatch):
    old_date = datetime.now(timezone.utc) - timedelta(days=90)
    stage("old", report(timestamp=old_date.isoformat(), total_score=0, verdict="failed"))
    stage("new", report(total_score=90))
    stage("old-other", report(base_url="https://old.example", timestamp=old_date.isoformat()))
    monkeypatch.setattr(server, "RED_RANKING", (
        PublicRankingSite("external.example", 95, 10, old_date.date().isoformat(), ("openai",)),
    ))
    monkeypatch.setattr(server, "BLACK_RANKING", ())
    snapshot = server._compute_public_ranking_snapshot()
    assert len(snapshot["red_sites"]) == 1
    assert snapshot["red_sites"][0].score == 90
    assert snapshot["red_sites"][0].report_count == 1
    assert {s.domain for s in snapshot["historical_sites"]} == {"external.example", "old.example"}
    assert not snapshot["black_sites"]


@pytest.mark.parametrize("changes", [
    {"run_error": "timeout"},
    {"timestamp": "2026-08-10T12:00:00"},
    {"timestamp": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()},
    {"base_url": "https://user:password@relay.example"},
    {"base_url": "https://relay.example/?api_key=secret"},
    {"base_url": "https://relay.example:invalid"},
    {"ranking_evidence": {}},
    {"results": [{"name": "basic_request", "status": "error", "error": "401 unauthorized"}]},
])
def test_invalid_reports_never_enter_monitor_or_ranking(stage, changes):
    data = report(**changes)
    stage("invalid", data)
    assert not assess_ranking_eligibility(data)[0]
    assert monitoring_snapshot()["rows"] == []
    assert leaderboard.aggregate()[0] == []


def test_model_mode_endpoint_and_version_are_separate_and_no_uptime_invented(stage):
    stage("one", report())
    stage("two", report(target_model="model-b"))
    stage("three", report(mode="full"))
    stage("four", report(base_url="https://relay.example/secret-route"))
    metadata = {**report()["ranking_evidence"], "detector_version": "build-b"}
    stage("five", report(ranking_evidence=metadata))
    snapshot = monitoring_snapshot()
    assert len(snapshot["rows"]) == 5
    assert snapshot["models"] == ["model-a", "model-b"]
    for row in snapshot["rows"]:
        assert row["count"] == 1
        assert sum(day["state"] == "no_data" for day in row["days"]) == 6
    response = TestClient(server.app).get("/leaderboard/monitor")
    assert response.status_code == 200
    assert "secret-route" not in response.text
    assert "账号分组未知" in response.text
    assert "不是可用率" in response.text
    assert 'href="/r/one"' in response.text
    assert "无有效样本" in response.text


def test_same_day_anomaly_links_to_anomaly_not_later_pass(stage):
    stage("risk", report(
        verdict="marginal", total_score=60,
        results=[{"name": "basic_request", "status": "pass"}, {"name": "protocol", "status": "fail"}],
    ))
    stage("pass", report())
    row = monitoring_snapshot()["rows"][0]
    assert row["days"][-1]["state"] == "risk"
    assert row["days"][-1]["job_id"] == "risk"


def test_bad_json_symlink_and_duplicate_directories_cannot_break_or_double_count(stage, monkeypatch):
    path = stage("good", report())
    stage("array", [1, 2])
    stage("integer", 1)
    (path.parent / "link.json").symlink_to(path)
    monkeypatch.setattr(leaderboard, "REPORT_DIRS", [path.parent, path.parent])
    assert monitoring_snapshot()["rows"][0]["count"] == 1
    assert leaderboard.aggregate()[1]["total_reports"] == 1


def test_incomplete_observation_is_not_shown_as_pass(stage):
    stage("incomplete", report(results=[
        {"name": "basic_request", "status": "pass"}, {"name": "protocol", "status": "error"},
    ]))
    assert monitoring_snapshot()["rows"][0]["days"][-1]["state"] == "incomplete"


def test_failed_probe_is_visible_even_with_other_incomplete_probes(stage):
    stage("mixed", report(results=[
        {"name": "basic_request", "status": "pass"},
        {"name": "protocol", "status": "fail"},
        {"name": "streaming", "status": "skip"},
    ]))
    assert monitoring_snapshot()["rows"][0]["days"][-1]["state"] == "risk"


def test_observation_dates_and_display_times_are_normalized_to_utc(stage):
    utc_time = datetime.now(timezone.utc).replace(hour=0, minute=30, second=0, microsecond=0) - timedelta(days=1)
    local_time = utc_time.astimezone(timezone(timedelta(hours=-8)))
    stage("offset", report(timestamp=local_time.isoformat()))
    row = monitoring_snapshot()["rows"][0]
    assert row["latest"]["timestamp"].isoformat() == utc_time.isoformat()
    cell = next(day for day in row["days"] if day["job_id"] == "offset")
    assert cell["date"] == utc_time.date().isoformat()


def test_empty_monitor_is_honest_and_does_not_start_jobs(stage, monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("read-only monitoring must not trigger a detection")
    monkeypatch.setattr(server.jobs, "submit", forbidden)
    response = TestClient(server.app).get("/leaderboard/monitor")
    assert response.status_code == 200
    assert "暂无匹配的有效观测" in response.text


@pytest.mark.parametrize("status", [None, "skip", "error", "pass"])
def test_unmeasured_structured_output_does_not_accuse_the_relay(status):
    data = report()
    if status:
        data["results"].append({"name": "structured_output", "status": status})
    assert not any("结构化输出" in note["title"] for note in server._report_notes(data))

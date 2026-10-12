"""A bounded public view of approved observations, never an uptime claim."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from . import leaderboard
from relay_detector.core.assessment import assess_report
from relay_detector.core.scoring_policy import scoring_label


def monitoring_snapshot() -> dict:
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    now = datetime.now(timezone.utc)
    for path, report in leaderboard.approved_reports(max_age_days=30, include_incomplete=True):
        endpoint = urlsplit(report["base_url"])
        # Userinfo/query/path can contain secrets; publish only an opaque ID.
        origin = f"{endpoint.scheme.lower()}://{endpoint.netloc.rsplit('@', 1)[-1].lower()}{endpoint.path.rstrip('/')}"
        endpoint_id = hashlib.sha256(origin.encode()).hexdigest()[:12]
        evidence = report["ranking_evidence"]
        key = (
            leaderboard._extract_domain(report["base_url"]),
            endpoint_id,
            report["protocol"],
            str(report["target_model"]),
            str(report.get("mode") or "unknown"),
            str(evidence["detector_version"]),
            str(evidence["baseline_version"]),
            str(report.get("scoring_version") or "weighted-v1"),
            str(report.get("probe_version") or "unknown"),
        )
        statuses = [r.get("status") for r in report["results"] if isinstance(r, dict) and r.get("evidence_role", "scored") == "scored"]
        state = (
            "risk" if "fail" in statuses
            else "incomplete" if any(s != "pass" for s in statuses)
            else "pass" if report.get("verdict") == "passed"
            else "risk"
        )
        grouped[key].append({
            "job_id": path.stem,
            "timestamp": leaderboard._parse_timestamp(report["timestamp"]).astimezone(timezone.utc),
            "state": state,
            "score": round(float(report["total_score"]), 1) if assess_report(report)["score_usable"] else None,
        })
    rows = []
    for key, samples in grouped.items():
        samples.sort(key=lambda s: (s["timestamp"], s["job_id"]), reverse=True)
        domain, endpoint_id, protocol, model, mode, version, baseline, scoring, probes = key
        days = []
        for offset in range(6, -1, -1):
            day = (now - timedelta(days=offset)).date()
            selected = [s for s in samples if s["timestamp"].date() == day]
            state = "no_data"
            if selected:
                states = {s["state"] for s in selected}
                state = "risk" if "risk" in states else "incomplete" if "incomplete" in states else "pass"
            days.append({
                "date": day.isoformat(), "state": state, "count": len(selected),
                "job_id": next((s["job_id"] for s in selected if s["state"] == state), ""),
            })
        rows.append({
            "domain": domain, "endpoint_id": endpoint_id, "protocol": protocol,
            "model": model, "mode": mode, "version": version, "baseline": baseline,
            "scoring_version": scoring, "probe_version": probes,
            "scoring_label": scoring_label(scoring),
            "count": len(samples), "latest": samples[0], "days": days,
            "history": samples[:12],
        })
    rows.sort(key=lambda r: (-r["latest"]["timestamp"].timestamp(), r["domain"], r["model"]))
    return {"rows": rows, "models": sorted({r["model"] for r in rows})}

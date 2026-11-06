#!/usr/bin/env python3
"""Audit public official pages; never call an inference API or require a key.

After reviewing official changes and their capability impact, maintainers run
--record to refresh the identifier snapshot, then commit it with the catalog.
Network errors are reported separately from confirmed source changes.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import date
from html.parser import HTMLParser
import json
from pathlib import Path
import re

import httpx

from relay_detector.model_catalog import VENDORS, VERIFIED_ON, REVIEW_INTERVAL_DAYS, model_vendor

SNAPSHOT = Path(__file__).resolve().parents[1] / "data/model_catalog_sources.json"
IDENTIFIER = re.compile(
    r"(?<![a-z0-9])(?:claude-|gpt-|gemini-|deepseek-|qwen|kimi-|glm-|minimax-|grok-)"
    r"[a-z0-9]+(?:[._-][a-z0-9]+)*", re.I,
)


class VisibleText(HTMLParser):
    """Do not mistake link targets, assets or embedded scripts for model IDs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def extract_ids(page: str, vendor: str) -> list[str]:
    parser = VisibleText()
    parser.feed(page)
    # Candidates still require human review; never update the product catalog automatically.
    noise = re.compile(
        r"\.(?:svg|png|jpg|webp|js|css|site)$|"
        r"(?:^|-)(?:quickstart|linkedin|docs|cli|tool-calling|best-practice)(?:-|$)|"
        r"(?:-api(?:-|$)|-context\.|-in-(?:hermes|openclaw)|-ai-dev$)"
    )
    return sorted({
        m.lower() for m in IDENTIFIER.findall(" ".join(parser.parts))
        if model_vendor(m) == vendor and not noise.search(m.lower())
    })


def compare_snapshot(previous: dict, current: dict) -> dict:
    return {vendor: {
        "added": sorted(set(current[vendor]["ids"]) - set(previous.get(vendor, {}).get("ids", []))),
        "removed": sorted(set(previous.get(vendor, {}).get("ids", [])) - set(current[vendor]["ids"])),
    } for vendor in current if current[vendor] != previous.get(vendor)}


async def audit(record: bool = False, report_only: bool = False, output: Path | None = None) -> int:
    found, errors = {}, {}
    async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers={
        "User-Agent": "GewuCatalogAudit/1.0", "Accept-Language": "en",
    }) as client:
        async def read(vendor):
            try:
                response = await client.get(vendor["source"])
                response.raise_for_status()
                ids = extract_ids(response.text, vendor["id"])
                if not ids:
                    raise ValueError("official page yielded no model IDs; review parser/source")
                found[vendor["id"]] = {"source": vendor["source"], "ids": ids}
            except (httpx.HTTPError, ValueError) as error:
                errors[vendor["id"]] = str(error)
        await asyncio.gather(*(read(v) for v in VENDORS))
    if errors:
        print(json.dumps({"source_unavailable": errors}, ensure_ascii=False, indent=2))
        return 2
    if record:
        SNAPSHOT.write_text(json.dumps(found, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        print(f"已记录 {len(found)} 个官方来源；提交前须人工审核目录与能力限制。")
        return 0
    previous = json.loads(SNAPSHOT.read_text())
    changes = compare_snapshot(previous, found)
    overdue = (date.today() - date.fromisoformat(VERIFIED_ON)).days > REVIEW_INTERVAL_DAYS
    report = {"verified_on": VERIFIED_ON, "review_overdue": overdue,
              "official_identifier_changes": changes}
    text = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
    print(text)
    if output:
        output.write_text(text + "\n", encoding="utf-8")
    return 1 if (changes or overdue) and not report_only else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", action="store_true", help="Record after manual source/capability review")
    parser.add_argument("--report-only", action="store_true", help="Report review items without failing CI; source errors still fail")
    parser.add_argument("--output", type=Path, help="Write the successful audit report as JSON")
    args = parser.parse_args()
    if args.record and args.report_only:
        parser.error("--record and --report-only cannot be combined")
    raise SystemExit(asyncio.run(audit(args.record, args.report_only, args.output)))

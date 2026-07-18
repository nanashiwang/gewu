"""Curated public red/black ranking shown by the detector website.

Keep acquisition metadata out of this presentation model. Internal provenance and
selection rules remain in the platform snapshot and are not rendered publicly.
"""

from __future__ import annotations

from dataclasses import dataclass


PROTOCOL_LABELS = {
    "anthropic": "Claude",
    "openai": "OpenAI",
    "gemini": "Gemini",
}


@dataclass(frozen=True)
class PublicRankingSite:
    domain: str
    score: int
    report_count: int
    last_checked: str
    protocols: tuple[str, ...]

    @property
    def protocols_label(self) -> str:
        return " / ".join(PROTOCOL_LABELS[protocol] for protocol in self.protocols)


RED_RANKING = (
    PublicRankingSite("nan.meta-api.vip", 96, 3, "2026-07-18", ("anthropic", "openai")),
    PublicRankingSite("codereel.pro", 94, 38, "2026-07-17", ("anthropic", "openai")),
    PublicRankingSite("api.yuboar.com", 94, 9, "2026-06-26", ("anthropic", "openai")),
    PublicRankingSite("ssnaiyun.com", 93, 30, "2026-07-13", ("anthropic", "openai")),
    PublicRankingSite("gwlink.cc", 93, 14, "2026-07-14", ("anthropic", "openai")),
    PublicRankingSite("xbhuiz.com", 93, 3, "2026-06-22", ("anthropic", "openai")),
    PublicRankingSite("api.loomcode.cn", 92, 81, "2026-07-13", ("anthropic", "openai")),
    PublicRankingSite("9527code.com", 91, 21, "2026-07-14", ("anthropic", "openai")),
    PublicRankingSite("dasuapi.com", 91, 55, "2026-07-17", ("openai",)),
    PublicRankingSite("zivv.pro", 89, 11, "2026-07-10", ("anthropic", "gemini", "openai")),
    PublicRankingSite("api.hohocode.ai", 89, 26, "2026-07-18", ("openai",)),
    PublicRankingSite("niubiai.ai", 88, 20, "2026-07-07", ("openai",)),
    PublicRankingSite("dragtokens.com", 87, 1183, "2026-07-18", ("anthropic", "openai")),
    PublicRankingSite("api.sublyx.org", 87, 2, "2026-07-14", ("anthropic", "openai")),
    PublicRankingSite("officesai.top", 87, 22, "2026-07-16", ("anthropic", "openai")),
    PublicRankingSite("linkai.shop", 84, 22, "2026-07-18", ("anthropic", "openai")),
    PublicRankingSite("ai.furry.edu.gr", 79, 27, "2026-07-18", ("openai",)),
    PublicRankingSite("api.touken.pro", 77, 6, "2026-06-27", ("anthropic",)),
    PublicRankingSite("juxingai888.com", 75, 19, "2026-07-18", ("anthropic", "gemini", "openai")),
    PublicRankingSite("www.bytecatcode.org", 74, 23, "2026-07-16", ("anthropic", "openai")),
)

BLACK_RANKING = (
    PublicRankingSite("codexpp.com", 60, 9, "2026-07-16", ("openai",)),
    PublicRankingSite("lucisapi.ai", 60, 9, "2026-07-18", ("openai",)),
    PublicRankingSite("quotarouter.ai", 59, 5, "2026-07-04", ("openai",)),
)

UPDATED_AT = "2026-07-18"

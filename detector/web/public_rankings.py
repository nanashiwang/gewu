"""Curated public red/black ranking shown by the detector website.

Every entry carries an explicit public provenance label. Third-party snapshots
must never look like first-party Gewu tests merely because they share one table.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from urllib.parse import urlencode, urlsplit


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
    website_url: str | None = None
    source_kind: str = "external_snapshot"

    @property
    def source_label(self) -> str:
        return "格物实测" if self.source_kind == "gewu_test" else "Veridrop 快照"

    @property
    def source_class(self) -> str:
        return "first-party" if self.source_kind == "gewu_test" else "external"

    @property
    def protocols_label(self) -> str:
        return " / ".join(PROTOCOL_LABELS.get(protocol, protocol) for protocol in self.protocols)

    @property
    def confidence_score(self) -> float:
        """Conservative score used for ordering, not a replacement for raw score."""
        weight = 5
        return (self.score * self.report_count + 50 * weight) / (
            self.report_count + weight
        )

    @property
    def confidence_label(self) -> str:
        if self.report_count >= 20:
            return "高可信"
        if self.report_count >= 5:
            return "中可信"
        return "低样本"

    @property
    def confidence_class(self) -> str:
        if self.report_count >= 20:
            return "high"
        if self.report_count >= 5:
            return "medium"
        return "low"

    @property
    def age_days(self) -> int | None:
        try:
            checked = date.fromisoformat(self.last_checked)
        except (TypeError, ValueError):
            return None
        return max(0, (date.today() - checked).days)

    @property
    def freshness_label(self) -> str:
        age = self.age_days
        if age is None:
            return "待复测"
        if age <= 3:
            return "刚更新"
        if age <= 14:
            return "近期"
        if age <= 30:
            return "较旧"
        return "需复测"

    @property
    def freshness_class(self) -> str:
        age = self.age_days
        if age is not None and age <= 3:
            return "fresh"
        if age is not None and age <= 14:
            return "recent"
        return "stale"

    @property
    def external_url(self) -> str:
        """Return a constrained external URL without allowing cross-domain links."""
        fallback = f"https://{self.domain}"
        if not self.website_url or len(self.website_url) > 2048:
            return fallback
        try:
            parts = urlsplit(self.website_url)
        except ValueError:
            return fallback
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
        ):
            return fallback
        link_host = parts.hostname.rstrip(".").lower()
        domain = self.domain.rstrip(".").lower()
        related = (
            "." in link_host
            and (
                link_host == domain
                or link_host.endswith(f".{domain}")
                or domain.endswith(f".{link_host}")
            )
        )
        return self.website_url.rstrip("/") if related else fallback

    @property
    def primary_protocol(self) -> str:
        for protocol in ("anthropic", "openai", "gemini"):
            if protocol in self.protocols:
                return protocol
        return "anthropic"

    @property
    def detect_url(self) -> str:
        path = {"anthropic": "claude", "openai": "openai", "gemini": "gemini"}[
            self.primary_protocol
        ]
        query = urlencode({"base_url": f"https://{self.domain}"})
        return f"/{path}?{query}#detect-form"


RED_RANKING = (
    PublicRankingSite(
        "nan.meta-api.vip", 96, 3, "2026-07-18", ("anthropic", "openai"),
        source_kind="gewu_test",
    ),
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
    PublicRankingSite('api.thinkai.tv', 5, 4, '2026-07-05', ('anthropic', 'openai')),
    PublicRankingSite('www.xkwuai.cn', 5, 4, '2026-06-24', ('anthropic', 'openai')),
    PublicRankingSite('xapi.labpinky.com', 5, 4, '2026-06-19', ('anthropic', 'openai')),
    PublicRankingSite('co.yes.vg', 5, 3, '2026-07-07', ('anthropic', 'openai')),
    PublicRankingSite('api.gptgod.online', 13, 3, '2026-07-01', ('anthropic', 'openai')),
    PublicRankingSite('aiapi3.moono.vip', 18, 3, '2026-06-09', ('anthropic', 'openai')),
    PublicRankingSite('codex-origin.wukong.support', 19, 3, '2026-07-12', ('anthropic', 'openai')),
    PublicRankingSite('www.hotapi.top', 21, 4, '2026-06-24', ('anthropic', 'openai')),
    PublicRankingSite('heimaoai.one', 24, 6, '2026-06-13', ('anthropic', 'openai')),
    PublicRankingSite('vip.lcodex.cn', 24, 6, '2026-06-25', ('anthropic', 'openai')),
    PublicRankingSite('xlabapi.com', 24, 5, '2026-06-25', ('anthropic', 'openai')),
    PublicRankingSite('api.nbility.dev', 24, 3, '2026-06-20', ('anthropic', 'openai')),
    PublicRankingSite('niffler.org', 24, 3, '2026-06-03', ('anthropic', 'openai')),
    PublicRankingSite('switchbase.vip', 25, 3, '2026-07-03', ('anthropic', 'openai')),
    PublicRankingSite('api.dali2897.com', 30, 4, '2026-07-07', ('anthropic', 'openai')),
    PublicRankingSite('xn--vduyey89e.com', 33, 10, '2026-07-09', ('anthropic', 'gemini', 'openai')),
    PublicRankingSite('new-api.koyeb.app', 35, 3, '2026-06-14', ('gemini', 'openai')),
    PublicRankingSite('token.aihezu.dev', 35, 3, '2026-06-09', ('anthropic',)),
    PublicRankingSite('www.moyu.info', 36, 6, '2026-06-03', ('anthropic',)),
    PublicRankingSite('token.android-doc.com', 37, 7, '2026-07-03', ('anthropic', 'openai')),
    PublicRankingSite('aizhongzhuan.com', 37, 4, '2026-06-05', ('anthropic',)),
    PublicRankingSite('api.applover.online', 37, 3, '2026-06-16', ('anthropic', 'openai')),
    PublicRankingSite('ai.websee.top', 38, 7, '2026-07-10', ('anthropic', 'openai')),
    PublicRankingSite('baipiao.dbgai.xyz', 38, 6, '2026-07-07', ('anthropic', 'openai')),
    PublicRankingSite('api.123nhh.com', 39, 5, '2026-07-05', ('anthropic',)),
    PublicRankingSite('rawchat.cn', 40, 11, '2026-07-14', ('openai',)),
    PublicRankingSite('api.weelinking.com', 40, 3, '2026-06-14', ('openai',)),
    PublicRankingSite('new.sharedchat.cc', 42, 55, '2026-07-10', ('openai',)),
    PublicRankingSite('www.kukuai.fyi', 43, 3, '2026-07-05', ('openai',)),
    PublicRankingSite('newapi.yujin.icu', 44, 3, '2026-07-03', ('anthropic', 'gemini')),
    PublicRankingSite('newapi.relayport17.asia', 45, 15, '2026-07-04', ('openai',)),
    PublicRankingSite('opencode.ai', 46, 6, '2026-06-27', ('openai',)),
    PublicRankingSite('jiuuij.de5.net', 46, 3, '2026-06-20', ('anthropic', 'gemini')),
    PublicRankingSite('api.kunkunout.cn', 47, 5, '2026-07-11', ('anthropic',)),
    PublicRankingSite('claude.tokenscode.com', 47, 3, '2026-06-29', ('anthropic',)),
    PublicRankingSite('sub.agentmd.sbs', 47, 3, '2026-07-05', ('openai',)),
    PublicRankingSite('aiapi.setbug.cn', 48, 4, '2026-06-15', ('openai',)),
    PublicRankingSite('xyuapi.top', 48, 4, '2026-07-05', ('anthropic', 'gemini', 'openai')),
    PublicRankingSite('ai.axzt.top', 49, 4, '2026-06-09', ('anthropic', 'openai')),
    PublicRankingSite('api.routin.ai', 50, 4, '2026-07-12', ('anthropic', 'openai')),
    PublicRankingSite('ai.hybgzs.com', 50, 3, '2026-07-03', ('anthropic',)),
    PublicRankingSite('open.asea.love', 55, 6, '2026-07-06', ('openai',)),
    PublicRankingSite('www.opencowbot.com', 55, 4, '2026-07-01', ('openai',)),
    PublicRankingSite('aheapi.com', 56, 12, '2026-06-20', ('openai',)),
    PublicRankingSite('yukiapi.com', 56, 4, '2026-07-05', ('openai',)),
    PublicRankingSite('api-xai.ainaibahub.com', 58, 8, '2026-06-06', ('openai',)),
    PublicRankingSite('dreamworld-ai.live', 58, 3, '2026-06-24', ('anthropic', 'openai')),
    PublicRankingSite('quotarouter.ai', 59, 5, '2026-07-04', ('openai',)),
    PublicRankingSite('mytokk.com', 59, 4, '2026-06-29', ('openai',)),
    PublicRankingSite('codexpp.com', 60, 9, '2026-07-16', ('openai',)),
    PublicRankingSite('lucisapi.ai', 60, 9, '2026-07-18', ('openai',)),
    PublicRankingSite('api.xixixixi.cloud', 61, 3, '2026-06-16', ('gemini', 'openai')),
    PublicRankingSite('ai.orbitlink.me', 66, 4, '2026-07-12', ('anthropic', 'openai')),
)

UPDATED_AT = "2026-07-19"

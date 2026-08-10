from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from web.market_pricing import MarketModelPrice, MarketPricing, parse_market_pricing
from web.public_rankings import (
    AFFILIATE_REGISTRATION_URLS,
    BLACK_RANKING,
    RED_RANKING,
    PublicRankingSite,
    _safe_registration_url,
)
from web.server import app


def test_public_rankings_are_disjoint_sorted_and_have_unique_domains():
    red_domains = [site.domain for site in RED_RANKING]
    black_domains = [site.domain for site in BLACK_RANKING]

    assert len(red_domains) == len(set(red_domains))
    assert len(black_domains) == len(set(black_domains))
    assert set(red_domains).isdisjoint(black_domains)
    assert len(BLACK_RANKING) == 53
    assert all("." in domain for domain in black_domains)
    assert not any(domain == "localhost" or domain.endswith("example.com") for domain in black_domains)
    assert [site.score for site in RED_RANKING] == sorted(
        (site.score for site in RED_RANKING), reverse=True
    )
    assert [site.score for site in BLACK_RANKING] == sorted(
        site.score for site in BLACK_RANKING
    )


def test_leaderboard_discloses_external_snapshot_and_first_party_sources():
    response = TestClient(app).get("/leaderboard")

    assert response.status_code == 200
    assert "质量榜" in response.text
    assert "风险观察" in response.text
    assert "红黑榜" not in response.text
    assert "nan.meta-api.vip" in response.text
    assert "codexpp.com" in response.text
    assert "api.thinkai.tv" in response.text
    assert "api.loomcode.cn" not in response.text
    assert "api.example.com" not in response.text
    assert 'href="/login"' in response.text
    assert 'href="/register"' in response.text
    assert 'href="https://cn.meta-api.vip/i/Eu48"' in response.text
    assert 'href="/leaderboard/api.thinkai.tv"' in response.text
    assert 'href="https://api.thinkai.tv"' not in response.text
    assert 'target="_blank"' in response.text
    assert 'rel="noopener noreferrer nofollow sponsored external"' in response.text
    assert 'referrerpolicy="no-referrer"' in response.text
    assert 'data-watch-domain="nan.meta-api.vip"' in response.text
    assert 'data-compare-domain="nan.meta-api.vip"' in response.text
    assert "高可信" in response.text
    assert "我的关注" in response.text
    assert "点击域名只进入格物站内详情" in response.text
    assert "质量榜按综合分从高到低排列" in response.text
    assert "格物关联站点 · 推广位" in response.text
    assert "该位置不加分、不改变名次" in response.text
    assert "格物运营方可能获得返利" in response.text
    assert "通过邀请链接注册" in response.text
    assert 'href="/pricing"' in response.text
    assert "Veridrop 快照" in response.text
    assert "格物实测" in response.text
    assert "第三方快照站点" in response.text
    for hidden_term in ("排除", "源榜", "前 10"):
        assert hidden_term not in response.text


def test_ranking_detail_renders_decision_page_and_unknown_domain_is_404():
    client = TestClient(app)
    response = client.get("/leaderboard/nan.meta-api.vip")

    assert response.status_code == 200
    assert "检测详情" in response.text
    assert "样本可信度" in response.text
    assert "检测此站" in response.text
    assert "打开域名" not in response.text
    assert 'data-watch-domain="nan.meta-api.vip"' in response.text
    assert 'data-compare-domain="nan.meta-api.vip"' in response.text
    assert client.get("/leaderboard/not-listed.example").status_code == 404



def test_ranking_detail_renders_local_trend_and_report_history(monkeypatch):
    from collections import Counter
    from datetime import datetime, timezone
    from web import server
    from web.leaderboard import JobEntry, ProtocolStats, RelayStats

    site = PublicRankingSite(
        "relay.example.com", 86, 2, "2026-07-20", ("openai",)
    )
    protocol = ProtocolStats(
        protocol="openai",
        count=2,
        scores=[80.0, 92.0],
        last_job_id="job-new",
        last_score=92.0,
        last_verdict="passed",
        last_checked=datetime(2026, 7, 20, tzinfo=timezone.utc),
        failed_detectors=Counter({"usage": 1}),
    )
    relay = RelayStats(domain=site.domain, by_protocol={"openai": protocol})
    history = [
        JobEntry("job-new", "openai", "gpt-test", 92, "passed", datetime(2026, 7, 20, tzinfo=timezone.utc), 0, "operator_monitor", "approved", "test-build", "baseline-a", datetime(2026, 7, 20, tzinfo=timezone.utc)),
        JobEntry("job-old", "openai", "gpt-test", 80, "marginal", datetime(2026, 7, 19, tzinfo=timezone.utc), 1, "manual_review", "approved", "test-build", "baseline-a", datetime(2026, 7, 19, tzinfo=timezone.utc)),
    ]
    monkeypatch.setattr(server, "_public_ranking_snapshot", lambda: {
        "red_sites": (site,), "black_sites": (),
        "metrics": {"updated_at": "2026-07-20"},
    })
    monkeypatch.setattr(server, "_public_ranking_detail", lambda _domain: (relay, history))

    response = TestClient(server.app).get("/leaderboard/relay.example.com")

    assert response.status_code == 200
    assert "最近 2 次检测趋势" in response.text
    assert "可复核检测历史" in response.text
    assert 'href="/r/job-new"' in response.text
    assert "usage" in response.text
    assert "运营方定时监测" in response.text
    assert "人工审核" in response.text
    assert "test-build" in response.text
    assert "baseline-a" in response.text

def test_compare_page_limits_deduplicates_and_validates_domains():
    response = TestClient(app).get(
        "/leaderboard/compare?domains=nan.meta-api.vip,codereel.pro,nan.meta-api.vip,evil.example"
    )

    assert response.status_code == 200
    assert response.text.count('class="compare-card"') == 2
    assert "nan.meta-api.vip" in response.text
    assert "codereel.pro" in response.text
    assert "evil.example" not in response.text
    assert "打开域名" not in response.text
    assert 'href="/leaderboard/codereel.pro"' in response.text
    assert 'name="robots" content="noindex,follow"' in response.text


def test_public_ranking_site_constrains_links_and_exposes_confidence():
    safe = PublicRankingSite(
        "api.example.com", 95, 2, "2026-07-19", ("openai",),
        website_url="https://example.com",
    )
    hostile = PublicRankingSite(
        "api.example.com", 95, 30, "2026-07-19", ("openai",),
        website_url="javascript:alert(1)",
    )
    cross_domain = PublicRankingSite(
        "api.example.com", 95, 30, "2026-07-19", ("openai",),
        website_url="https://evil.example/phish",
    )

    assert safe.external_url == "https://example.com"
    assert hostile.external_url == "https://api.example.com"
    assert cross_domain.external_url == "https://api.example.com"
    assert safe.confidence_label == "低样本"
    assert hostile.confidence_label == "高可信"
    assert safe.confidence_score < safe.score
    assert safe.detect_url.startswith("/openai?base_url=")


def test_affiliate_registration_link_is_allowlisted_and_separate_from_score():
    affiliate = PublicRankingSite(
        "cn.meta-api.vip", 88, 4, "2026-07-24", ("openai",)
    )
    unrelated = PublicRankingSite(
        "relay.example.com", 88, 4, "2026-07-24", ("openai",)
    )

    assert affiliate.registration_url == "https://cn.meta-api.vip/i/Eu48"
    assert affiliate.score == 88
    assert unrelated.registration_url is None


def test_affiliate_registration_link_rejects_unsafe_or_cross_domain_values():
    domain = "cn.meta-api.vip"

    assert _safe_registration_url(domain, "http://cn.meta-api.vip/i/code") is None
    assert _safe_registration_url(domain, "javascript:alert(1)") is None
    assert _safe_registration_url(domain, "https://user:pass@cn.meta-api.vip/i/code") is None
    assert _safe_registration_url(domain, "https://evil.example/i/code") is None
    assert _safe_registration_url(domain, "https://cn.meta-api.vip/i/code") == "https://cn.meta-api.vip/i/code"


def test_affiliate_registration_mapping_is_immutable():
    with pytest.raises(TypeError):
        AFFILIATE_REGISTRATION_URLS["evil.example"] = "https://evil.example/i/code"


def test_affiliate_registration_link_is_disclosed_on_detail_page(monkeypatch):
    from web import server

    site = PublicRankingSite(
        "cn.meta-api.vip", 88, 4, "2026-07-24", ("openai",)
    )
    monkeypatch.setattr(server, "_public_ranking_snapshot", lambda: {
        "red_sites": (site,), "black_sites": (),
        "metrics": {"updated_at": "2026-07-24"},
    })
    monkeypatch.setattr(server, "_public_ranking_detail", lambda _domain: None)

    response = TestClient(server.app).get("/leaderboard/cn.meta-api.vip")

    assert response.status_code == 200
    assert 'href="https://cn.meta-api.vip/i/Eu48"' in response.text
    assert 'rel="noopener noreferrer nofollow sponsored external"' in response.text
    assert "格物运营方可能获得返利" in response.text
    assert "不影响检测分数、排名或风险结论" in response.text


def _market_payload(method, rows):
    return {"code": 0, "data": {"list": rows, "total": len(rows)}}


def _sample_market_pricing(count: int = 12) -> MarketPricing:
    names = (
        ("gpt-5.6-sol", "OpenAI"),
        ("gpt-5.6-luna", "OpenAI"),
        ("kimi-k3", "Moonshot"),
        ("gpt-5.5", "OpenAI"),
        ("gpt-5.6-terra", "OpenAI"),
        ("gemini-3.6-flash", "Google"),
        ("claude-sonnet-5", "Anthropic"),
        ("claude-fable-5", "Anthropic"),
        ("claude-opus-4.8", "Anthropic"),
        ("gpt-image-2", "OpenAI"),
        ("grok-4.5", "xAI"),
        ("deepseek-v4-pro", "DeepSeek"),
    )
    return MarketPricing(
        prices=tuple(
            MarketModelPrice(
                model=model, company=company, billing_method=1,
                abilities=("对话",), minimum_price=0.2 + index,
                input_price=0.2 + index, output_price=1.4 + index,
                cache_read_price=0.02, best_discount=0.06,
                official_input_price=3.4, official_output_price=20,
                provider_count=63 - index, published_at="2026-07-09",
                is_new=index < 3, is_hot=index in (3, 6, 7),
            )
            for index, (model, company) in enumerate(names[:count])
        ),
        captured_at="2026-07-23T16:00:00+08:00",
    )


def test_market_pricing_parser_preserves_billing_variants_and_bounds_values():
    payloads = {
        method: _market_payload(method, []) for method in range(1, 5)
    }
    payloads[1] = _market_payload(1, [
        {
            "sku_name": " gpt-test ", "company": "OpenAI", "pricing_method": 1,
            "sku_tags": ["对话", "对话", "识图"],
            "min_price_info": {
                "min_price": 0.2, "input_price": 0.2, "output_price": 1.4,
                "cache_read_price": 0,  # Oken uses zero for unavailable.
            },
            "official_price_info": {"input_price": 3.4, "output_price": float("inf")},
            "best_discount": 0.0591, "manufacturer_num": 63,
            "publish_at": "2026-07-09", "is_new": 1,
        },
        {
            "sku_name": "gpt-cheap", "company": "OpenAI", "pricing_method": 1,
            "min_price_info": {"min_price": 0.01, "input_price": 0.01},
        },
    ])
    payloads[2] = _market_payload(2, [
        {
            "sku_name": "gpt-test", "company": "OpenAI", "pricing_method": 2,
            "min_price_info": {"min_price": -1}, "manufacturer_num": True,
        },
        {"sku_name": "bad-type", "company": "OpenAI", "pricing_method": True},
    ])

    parsed = parse_market_pricing(payloads, captured_at="2026-07-21T14:00:00+08:00")

    assert parsed.model_count == 2
    assert parsed.variant_count == 3
    # Preserve each Oken feed's curated directory order. Price sorting is an
    # explicit UI choice and must not replace the upstream default order.
    assert [item.model for item in parsed.prices] == ["gpt-test", "gpt-cheap", "gpt-test"]
    assert {item.billing_key for item in parsed.prices} == {"usage", "count"}
    usage = next(
        item for item in parsed.prices
        if item.billing_method == 1 and item.model == "gpt-test"
    )
    count = next(item for item in parsed.prices if item.billing_method == 2)
    assert usage.abilities == ("对话", "识图")
    assert usage.cache_read_price is None
    assert usage.official_output_price is None
    assert usage.provider_count == 63
    assert count.minimum_price == -1
    assert count.provider_count == 0


def test_homepage_pricing_selects_only_ten_usage_models_and_maps_protocols():
    pricing = _sample_market_pricing()

    assert len(pricing.homepage_prices) == 10
    assert pricing.homepage_prices[0].model == "gpt-5.6-sol"
    assert pricing.homepage_prices[7].model == "claude-fable-5"
    assert pricing.homepage_prices[0].detection_protocol == "openai"
    assert pricing.homepage_prices[5].detection_protocol == "gemini"
    assert pricing.homepage_prices[7].detection_protocol == "claude"
    assert pricing.homepage_companies == (
        "OpenAI", "Moonshot", "Google", "Anthropic"
    )


def test_market_pricing_parser_requires_every_billing_feed():
    payloads = {method: _market_payload(method, []) for method in range(1, 5)}
    payloads.pop(4)

    try:
        parse_market_pricing(payloads, captured_at="2026-07-21T14:00:00+08:00")
    except ValueError as error:
        assert "billing feed 4" in str(error)
    else:
        raise AssertionError("partial market feeds must fail closed")


def test_pricing_page_hides_upstream_name_and_keeps_quality_separate(monkeypatch):
    from web import server

    async def fake_pricing():
        return MarketPricing(
            prices=(MarketModelPrice(
                model="gpt-test", company="OpenAI", billing_method=1,
                abilities=("对话",), minimum_price=0.2, input_price=0.2,
                output_price=1.4, cache_read_price=0.02, best_discount=0.06,
                official_input_price=3.4, official_output_price=20,
                provider_count=63, published_at="2026-07-09",
            ),),
            captured_at="2026-07-21T11:55:04+08:00",
        )

    monkeypatch.setattr(server, "get_market_pricing", fake_pricing)
    response = TestClient(server.app).get("/pricing")

    assert response.status_code == 200
    assert "公开平台价格汇总" in response.text
    assert "最低价不代表线路可用" in response.text
    assert "价格与质量相互独立" in response.text
    assert "gpt-test" in response.text
    assert "¥0.2" in response.text
    assert 'id="pricing-search"' in response.text
    assert 'data-pricing-vendor="openai"' in response.text
    assert 'id="pricing-billing"' in response.text
    assert 'id="pricing-ability"' in response.text
    assert 'id="pricing-sort"' in response.text
    assert '<option value="usage" selected>' in response.text
    assert "MARKET MODEL INDEX" in response.text
    assert "Oken" not in response.text
    assert "oken.ai" not in response.text.lower()
    assert "nan.meta-api.vip" not in response.text


def test_pricing_page_fails_closed_without_reusing_unverified_prices(monkeypatch):
    from web import server

    async def unavailable_pricing():
        return None

    monkeypatch.setattr(server, "get_market_pricing", unavailable_pricing)
    response = TestClient(server.app).get("/pricing")

    assert response.status_code == 200
    assert "公开价格源暂不可用" in response.text
    assert "没有用旧数据冒充当前价格" in response.text
    assert 'id="pricing-search"' not in response.text
    assert "Oken" not in response.text
    assert "oken.ai" not in response.text.lower()


def test_featured_placement_does_not_change_quality_order(monkeypatch):
    from web import server

    monkeypatch.setattr(server.leaderboard, "aggregate", lambda: ([], {}))
    quality_sites = server._compute_public_ranking_snapshot()["red_sites"]
    quality_domains = [site.domain for site in quality_sites]

    assert "api.loomcode.cn" not in quality_domains
    assert [site.score for site in quality_sites] == sorted(
        (site.score for site in quality_sites), reverse=True
    )


def test_homepage_exposes_optional_account_and_relay_management_entry(monkeypatch):
    from web import server

    async def fake_pricing():
        return _sample_market_pricing()

    monkeypatch.setattr(server, "get_market_pricing", fake_pricing)
    response = TestClient(app).get("/")

    assert response.status_code == 200
    assert 'href="/register"' in response.text
    assert 'href="/login"' in response.text
    assert "创建账户" in response.text
    assert "账户与站点管理" in response.text


def test_homepage_visual_and_interaction_contract(monkeypatch):
    from web import server

    async def fake_pricing():
        return _sample_market_pricing()

    monkeypatch.setattr(server, "get_market_pricing", fake_pricing)
    client = TestClient(app)
    response = client.get("/")

    assert response.status_code == 200
    assert "全网比价 +" in response.text
    assert 'id="history-search-form"' in response.text
    assert 'id="home-domain-search"' in response.text
    assert 'id="quick-model"' in response.text
    assert response.text.count("data-pricing-test-model") == 10
    assert response.text.count("data-pricing-row") == 10
    assert "gpt-5.6-sol" in response.text
    assert "claude-fable-5" in response.text
    assert "查看全部 12 个模型" in response.text
    assert response.text.count("data-home-rank-row") == 12
    assert response.text.index('id="home-pricing"') < response.text.index(
        'id="home-ranking"'
    )
    assert response.text.index('id="home-ranking"') < response.text.index(
        'id="security-and-trust"'
    )
    assert response.text.index("怎么用？三步，约 30–75 秒") < response.text.index(
        'class="account-entry"'
    )
    assert "查看完整榜单" in response.text
    assert "Veridrop 快照" in response.text
    assert "格物实测" in response.text
    assert all(icon not in response.text for icon in ("🔒", "📋", "🔐", "🛡️"))

    css = client.get("/static/style.css").text
    assert "--accent: #5b5bd6" in css
    assert "--green:" not in css
    assert ".quick-protocols input:focus-visible + span" in css
    assert "@media (prefers-color-scheme: dark)" in css
    assert ".btn-block { width: 100%; }" in css

    javascript = client.get("/static/app.js").text
    assert "history-search-form" in javascript
    assert "knownDomains.has(query)" in javascript
    assert "new URLSearchParams(location.search).get('query')" in javascript
    assert "data-pricing-test-model" in javascript
    assert "target.searchParams.set('model', model)" in javascript


def test_public_pages_do_not_expose_repository_entry_points(monkeypatch):
    from web import server

    async def fake_pricing():
        return _sample_market_pricing()

    monkeypatch.setattr(server, "get_market_pricing", fake_pricing)
    client = TestClient(app)
    for path in (
        "/", "/faq", "/leaderboard", "/leaderboard/nan.meta-api.vip",
        "/leaderboard/compare", "/pricing", "/claude", "/openai", "/gemini", "/llms.txt",
    ):
        response = client.get(path)
        assert response.status_code == 200
        assert "github.com" not in response.text.lower()
        assert "brand.source_url" not in response.text
        for hidden_term in ("源代码", "查看源码", "完全开源", "自托管", "AGPL-3.0"):
            assert hidden_term not in response.text
    assert app.openapi_url is None


def test_public_ranking_snapshot_merges_newer_live_reports_without_double_counting(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from web import server
    from web.public_rankings import PublicRankingSite

    monkeypatch.setattr(server, "RED_RANKING", (
        PublicRankingSite("a.example", 80, 20, "2026-07-19", ("openai",)),
    ))
    monkeypatch.setattr(server, "BLACK_RANKING", (
        PublicRankingSite("b.example", 40, 5, "2026-07-19", ("anthropic",)),
    ))
    monkeypatch.setattr(server, "UPDATED_AT", "2026-07-19")
    monkeypatch.setattr(server.leaderboard, "aggregate", lambda: ([
        SimpleNamespace(
            domain="a.example", total_count=12, overall_median=91.0,
            by_protocol={"openai": object(), "gemini": object()},
            last_checked=datetime(2026, 7, 20, tzinfo=timezone.utc),
        ),
        SimpleNamespace(
            domain="c.example", total_count=2, overall_median=60.0,
            by_protocol={"anthropic": object()},
            last_checked=datetime(2026, 7, 18, tzinfo=timezone.utc),
        ),
    ], {}))

    snapshot = server._compute_public_ranking_snapshot()
    metrics = snapshot["metrics"]
    red = {site.domain: site for site in snapshot["red_sites"]}
    black = {site.domain: site for site in snapshot["black_sites"]}

    assert [site.score for site in snapshot["red_sites"]] == sorted(
        (site.score for site in snapshot["red_sites"]), reverse=True
    )
    assert metrics["site_count"] == 3
    assert metrics["report_count"] == 19
    assert metrics["updated_at"] == "2026-07-20"
    assert metrics["first_party_site_count"] == 2
    assert metrics["first_party_report_count"] == 14
    assert metrics["external_site_count"] == 1
    assert metrics["external_report_count"] == 5
    assert metrics["anthropic_site_count"] == 2
    assert metrics["openai_site_count"] == 1
    assert metrics["gemini_site_count"] == 1
    assert red["a.example"].score == 91
    assert red["a.example"].source_label == "格物实测"
    assert red["a.example"].report_count == 12
    assert red["a.example"].protocols == ("gemini", "openai")
    assert black["c.example"].score == 60


def test_homepage_renders_coverage_counts_and_truthful_key_policy(monkeypatch):
    from web import server

    monkeypatch.setattr(
        server,
        "_homepage_metrics",
        lambda: {
            "site_count": 73,
            "report_count": 1927,
            "site_count_label": "73",
            "report_count_label": "1,927",
            "updated_at": "2026-07-20",
        },
    )
    response = TestClient(server.app).get("/")

    assert response.status_code == 200
    assert "73" in response.text
    assert "1,927" in response.text
    assert "73 个域名" in response.text
    assert "1,927 次记录" in response.text
    assert "sk-y7xU" not in response.text
    assert "不会保留密钥前缀" in response.text
    assert 'id="quick-check"' in response.text
    assert 'name="protocol"' in response.text
    assert "首页不收集密钥" in response.text


def test_leaderboard_has_search_protocol_filters_and_methodology(monkeypatch):
    from web import server

    monkeypatch.setattr(server, "_public_ranking_snapshot", lambda: {
        "red_sites": RED_RANKING[:2],
        "black_sites": BLACK_RANKING[:2],
        "metrics": {
            "site_count": 4, "report_count": 14,
            "red_count": 2, "black_count": 2,
            "site_count_label": "4", "report_count_label": "14",
            "updated_at": "2026-07-20",
            "first_party_site_count": 1, "first_party_report_count": 3,
            "first_party_updated_at": "2026-07-18",
            "external_site_count": 3, "external_report_count": 11,
            "external_updated_at": "2026-07-19",
        },
    })
    response = TestClient(server.app).get("/leaderboard")

    assert response.status_code == 200
    assert 'id="ranking-search"' in response.text
    assert 'data-rank-protocol="anthropic"' in response.text
    assert 'data-rank-tone="black"' in response.text
    assert "\u6392\u540d\u3001\u5206\u6570\u548c\u6765\u6e90\u600e\u4e48\u770b" in response.text
    assert "\u4e2d\u8f6c\u7ad9\u600e\u4e48\u9009" in response.text
    assert 'id="compare-selection-bar"' in response.text
    assert "质量榜按综合分从高到低排列" in response.text
    assert "只有同分时才参考样本可信度与记录数" in response.text

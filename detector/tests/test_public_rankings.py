from __future__ import annotations

from fastapi.testclient import TestClient

from web.market_pricing import MarketModelPrice, MarketPricing, parse_market_pricing
from web.public_rankings import BLACK_RANKING, RED_RANKING, PublicRankingSite
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
    assert "api.example.com" not in response.text
    assert 'href="/login"' in response.text
    assert 'href="/register"' in response.text
    assert 'href="https://nan.meta-api.vip"' in response.text
    assert 'href="https://api.thinkai.tv"' in response.text
    assert 'target="_blank"' in response.text
    assert 'rel="noopener noreferrer nofollow external"' in response.text
    assert 'referrerpolicy="no-referrer"' in response.text
    assert 'data-watch-domain="nan.meta-api.vip"' in response.text
    assert 'data-compare-domain="nan.meta-api.vip"' in response.text
    assert "高可信" in response.text
    assert "我的关注" in response.text
    assert "点击域名会在新窗口打开外部站点" in response.text
    assert "格物关联站点 · 推广位" in response.text
    assert "该位置不加分、不改变名次" in response.text
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
        JobEntry("job-new", "openai", "gpt-test", 92, "passed", datetime(2026, 7, 20, tzinfo=timezone.utc), 0),
        JobEntry("job-old", "openai", "gpt-test", 80, "marginal", datetime(2026, 7, 19, tzinfo=timezone.utc), 1),
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

def test_compare_page_limits_deduplicates_and_validates_domains():
    response = TestClient(app).get(
        "/leaderboard/compare?domains=nan.meta-api.vip,codereel.pro,nan.meta-api.vip,evil.example"
    )

    assert response.status_code == 200
    assert response.text.count('class="compare-card"') == 2
    assert "nan.meta-api.vip" in response.text
    assert "codereel.pro" in response.text
    assert "evil.example" not in response.text
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


def _market_payload(method, rows):
    return {"code": 0, "data": {"list": rows, "total": len(rows)}}


def test_market_pricing_parser_preserves_billing_variants_and_bounds_values():
    payloads = {
        method: _market_payload(method, []) for method in range(1, 5)
    }
    payloads[1] = _market_payload(1, [{
        "sku_name": " gpt-test ", "company": "OpenAI", "pricing_method": 1,
        "sku_tags": ["对话", "对话", "识图"],
        "min_price_info": {
            "min_price": 0.2, "input_price": 0.2, "output_price": 1.4,
            "cache_read_price": 0,  # Oken uses zero for unavailable.
        },
        "official_price_info": {"input_price": 3.4, "output_price": float("inf")},
        "best_discount": 0.0591, "manufacturer_num": 63,
        "publish_at": "2026-07-09", "is_new": 1,
    }])
    payloads[2] = _market_payload(2, [
        {
            "sku_name": "gpt-test", "company": "OpenAI", "pricing_method": 2,
            "min_price_info": {"min_price": -1}, "manufacturer_num": True,
        },
        {"sku_name": "bad-type", "company": "OpenAI", "pricing_method": True},
    ])

    parsed = parse_market_pricing(payloads, captured_at="2026-07-21T14:00:00+08:00")

    assert parsed.model_count == 1
    assert parsed.variant_count == 2
    assert {item.billing_key for item in parsed.prices} == {"usage", "count"}
    usage = next(item for item in parsed.prices if item.billing_method == 1)
    count = next(item for item in parsed.prices if item.billing_method == 2)
    assert usage.abilities == ("对话", "识图")
    assert usage.cache_read_price is None
    assert usage.official_output_price is None
    assert usage.provider_count == 63
    assert count.minimum_price == -1
    assert count.provider_count == 0


def test_market_pricing_parser_requires_every_billing_feed():
    payloads = {method: _market_payload(method, []) for method in range(1, 5)}
    payloads.pop(4)

    try:
        parse_market_pricing(payloads, captured_at="2026-07-21T14:00:00+08:00")
    except ValueError as error:
        assert "billing feed 4" in str(error)
    else:
        raise AssertionError("partial market feeds must fail closed")


def test_pricing_page_attributes_oken_and_keeps_quality_separate(monkeypatch):
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
    assert "数据整理来源 www.oken.ai" in response.text
    assert "最低价不代表线路可用" in response.text
    assert "价格与质量相互独立" in response.text
    assert "gpt-test" in response.text
    assert "¥0.2" in response.text
    assert 'id="pricing-search"' in response.text
    assert 'data-pricing-vendor="openai"' in response.text
    assert 'id="pricing-billing"' in response.text
    assert 'id="pricing-ability"' in response.text
    assert 'href="https://www.oken.ai/zh"' in response.text
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


def test_featured_placement_does_not_change_quality_order(monkeypatch):
    from web import server

    monkeypatch.setattr(server.leaderboard, "aggregate", lambda: ([], {}))
    quality_domains = [
        site.domain for site in server._compute_public_ranking_snapshot()["red_sites"]
    ]

    assert quality_domains[0] == "api.loomcode.cn"
    assert quality_domains.index("nan.meta-api.vip") > 0


def test_homepage_exposes_optional_account_and_relay_management_entry():
    response = TestClient(app).get("/")

    assert response.status_code == 200
    assert 'href="/register"' in response.text
    assert 'href="/login"' in response.text
    assert "创建账户" in response.text
    assert "账户与站点管理" in response.text


def test_public_pages_do_not_expose_repository_entry_points():
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

    assert metrics["site_count"] == 3
    assert metrics["report_count"] == 19
    assert metrics["updated_at"] == "2026-07-20"
    assert metrics["first_party_site_count"] == 2
    assert metrics["first_party_report_count"] == 14
    assert metrics["external_site_count"] == 1
    assert metrics["external_report_count"] == 5
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
    assert "家中转站已覆盖" in response.text
    assert "次检测记录" in response.text
    assert "sk-y7xU" not in response.text
    assert "不会保留密钥前缀" in response.text
    assert 'id="quick-check"' in response.text
    assert 'name="protocol"' in response.text
    assert "\u5bc6\u94a5\u4e0d\u4f1a\u5199\u5165 URL" in response.text


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
    assert "排序时会按样本数向中性值收缩" in response.text

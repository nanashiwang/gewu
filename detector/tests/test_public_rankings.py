from __future__ import annotations

from fastapi.testclient import TestClient

from web.public_rankings import BLACK_RANKING, RED_RANKING
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


def test_leaderboard_renders_single_public_view_without_internal_provenance():
    response = TestClient(app).get("/leaderboard")

    assert response.status_code == 200
    assert "红榜" in response.text
    assert "黑榜" in response.text
    assert "nan.meta-api.vip" in response.text
    assert "codexpp.com" in response.text
    assert "api.thinkai.tv" in response.text
    assert "api.example.com" not in response.text
    assert 'href="/login"' in response.text
    assert 'href="/register"' in response.text
    for hidden_term in ("自营", "第三方", "Veridrop", "排除", "源榜", "前 10"):
        assert hidden_term not in response.text


def test_legacy_ranking_surfaces_redirect_to_the_single_leaderboard():
    client = TestClient(app, follow_redirects=False)
    response = client.get("/leaderboard/example.com")

    assert response.status_code == 308
    assert response.headers["location"] == "/leaderboard"


def test_homepage_exposes_optional_account_and_relay_management_entry():
    response = TestClient(app).get("/")

    assert response.status_code == 200
    assert 'href="/register"' in response.text
    assert 'href="/login"' in response.text
    assert "创建账户" in response.text
    assert "账户与站点管理" in response.text


def test_public_pages_do_not_expose_repository_entry_points():
    client = TestClient(app)
    for path in ("/", "/faq", "/leaderboard", "/claude", "/openai", "/gemini", "/llms.txt"):
        response = client.get(path)
        assert response.status_code == 200
        assert "github.com" not in response.text.lower()
        assert "brand.source_url" not in response.text
        for hidden_term in ("源代码", "查看源码", "完全开源", "自托管", "AGPL-3.0"):
            assert hidden_term not in response.text
    assert app.openapi_url is None

"""Adversarial suite for the admin edge (CLAUDE.md §8): the ingest trigger spends real money
(Composio executions + extraction tokens) and may be reachable through a public tunnel, so the
token gate must fail closed against everything."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import claymore.api.routes.admin as admin_route
from claymore.api.app import app
from tests.fixtures import make_settings

TOKEN = "admin-tok-1"


def _install_settings(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    settings = make_settings(**overrides)
    monkeypatch.setattr(admin_route, "get_settings", lambda: settings)


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    _install_settings(monkeypatch, admin_api_token=TOKEN)
    admin_route._jobs.clear()
    yield
    admin_route._jobs.clear()


@pytest.fixture()
def track_ingest(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    async def _fake(*a: object, **kw: object) -> object:
        calls.append("ran")
        raise AssertionError("should never run in these tests")

    monkeypatch.setattr(admin_route, "ingest_source", _fake)
    return calls


@pytest.mark.parametrize(
    "headers",
    [
        {},  # missing token
        {"X-Claymore-Admin-Token": "wrong"},
        {"X-Claymore-Admin-Token": ""},
        {"x-claymore-admin-token": "WRONG"},  # case-insensitive header, wrong value
        {"Authorization": f"Bearer {TOKEN}"},  # right secret, wrong header
    ],
)
def test_bad_auth_rejected_on_every_route(track_ingest: list[str], headers: dict[str, str]) -> None:
    with TestClient(app) as client:
        resp = client.post("/admin/ingest", json={"source": "github"}, headers=headers)
        assert resp.status_code == 403
        assert client.get("/admin/ingest", headers=headers).status_code == 403
        assert client.get("/admin/ingest/abc", headers=headers).status_code == 403
    assert track_ingest == []  # nothing spent


def test_unconfigured_token_rejects_even_empty_match(
    monkeypatch: pytest.MonkeyPatch, track_ingest: list[str]
) -> None:
    # Empty configured token + empty header must NOT compare equal (fail-closed).
    _install_settings(monkeypatch, admin_api_token="")
    with TestClient(app) as client:
        resp = client.post(
            "/admin/ingest", json={"source": "github"}, headers={"X-Claymore-Admin-Token": ""}
        )
        assert resp.status_code == 403
    assert track_ingest == []


def test_days_bounds_enforced(track_ingest: list[str]) -> None:
    headers = {"X-Claymore-Admin-Token": TOKEN}
    with TestClient(app) as client:
        for days in (0, -5, 366, 10**9):
            resp = client.post(
                "/admin/ingest", json={"source": "github", "days": days}, headers=headers
            )
            assert resp.status_code == 422, f"days={days} accepted"
    assert track_ingest == []


def test_injection_shaped_source_rejected(track_ingest: list[str]) -> None:
    headers = {"X-Claymore-Admin-Token": TOKEN}
    with TestClient(app) as client:
        for source in ("github; rm -rf /", "../../etc/passwd", "GITHUB", "slack\x00", 42, None):
            resp = client.post("/admin/ingest", json={"source": source}, headers=headers)
            assert resp.status_code == 422, f"source={source!r} accepted"
    assert track_ingest == []


def test_job_ids_not_enumerable() -> None:
    # Job ids are random hex, and probing ids yields 404 (with auth) — never a stack trace.
    headers = {"X-Claymore-Admin-Token": TOKEN}
    with TestClient(app) as client:
        for probe in ("1", "0" * 12, "../jobs", "%00"):
            assert client.get(f"/admin/ingest/{probe}", headers=headers).status_code == 404


def test_error_detail_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    # A failing ingest must not dump an unbounded/secret-bearing blob into the job record.
    async def _boom(*a: object, **kw: object) -> object:
        raise RuntimeError("x" * 10_000)

    monkeypatch.setattr(admin_route, "ingest_source", _boom)
    headers = {"X-Claymore-Admin-Token": TOKEN}
    with TestClient(app) as client:
        job_id = client.post("/admin/ingest", json={"source": "github"}, headers=headers).json()[
            "job_id"
        ]
        import time

        for _ in range(50):
            body = client.get(f"/admin/ingest/{job_id}", headers=headers).json()
            if body["status"] != "running":
                break
            time.sleep(0.02)
        assert body["status"] == "failed"
        assert len(str(body["error"])) <= 600

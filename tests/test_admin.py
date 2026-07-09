"""Admin ingest routes + runtime assembly — happy paths and contract behavior."""

from __future__ import annotations

import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import claymore.api.routes.admin as admin_route
from claymore.agent.llm import AnthropicLLM
from claymore.api.app import app
from claymore.api.runtime import build_runtime, roster_from_json
from claymore.domain import SourcePlatform
from claymore.ingest.pipeline import IngestStats
from claymore.memory.graph import GraphitiMemoryStore
from tests.fixtures import make_settings

TOKEN = "admin-tok-1"
HEADERS = {"X-Claymore-Admin-Token": TOKEN}


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    settings = make_settings(admin_api_token=TOKEN)
    monkeypatch.setattr(admin_route, "get_settings", lambda: settings)
    admin_route._jobs.clear()
    yield
    admin_route._jobs.clear()


@pytest.fixture()
def fake_ingest(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    captured: dict[str, object] = {}

    async def _fake(hub, log, store, *, lab_id, source, resolver=None, since=None, **kw):
        captured.update(lab_id=lab_id, source=source, since=since, store=store)
        return IngestStats(
            lab_id=lab_id,
            source=source,
            seen=3,
            stored=2,
            extracted=2,
            skipped_errors=0,
            unresolved_authors=1,
        )

    monkeypatch.setattr(admin_route, "ingest_source", _fake)
    return captured


def _poll_done(client: TestClient, job_id: str, tries: int = 50) -> dict[str, object]:
    for _ in range(tries):
        body = client.get(f"/admin/ingest/{job_id}", headers=HEADERS).json()
        if body["status"] != "running":
            return dict(body)
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_ingest_job_lifecycle(fake_ingest: dict[str, object]) -> None:
    with TestClient(app) as client:
        resp = client.post("/admin/ingest", json={"source": "github", "days": 7}, headers=HEADERS)
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]
        assert resp.json()["status"] == "running"

        done = _poll_done(client, job_id)
        assert done["status"] == "done"
        stats = done["stats"]
        assert isinstance(stats, dict)
        assert (stats["seen"], stats["stored"], stats["unresolved_authors"]) == (3, 2, 1)
        assert fake_ingest["source"] is SourcePlatform.GITHUB
        assert fake_ingest["lab_id"] == "lab1"
        assert fake_ingest["since"] is not None
        # The job list includes it too.
        listed = client.get("/admin/ingest", headers=HEADERS).json()
        assert any(j["job_id"] == job_id for j in listed)


def test_ingest_failure_is_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(*a: object, **kw: object) -> IngestStats:
        raise RuntimeError("composio exploded")

    monkeypatch.setattr(admin_route, "ingest_source", _boom)
    with TestClient(app) as client:
        job_id = client.post("/admin/ingest", json={"source": "gmail"}, headers=HEADERS).json()[
            "job_id"
        ]
        done = _poll_done(client, job_id)
        assert done["status"] == "failed"
        assert "composio exploded" in str(done["error"])


def test_unknown_job_404() -> None:
    with TestClient(app) as client:
        assert client.get("/admin/ingest/nope", headers=HEADERS).status_code == 404


def test_invalid_source_422() -> None:
    with TestClient(app) as client:
        resp = client.post("/admin/ingest", json={"source": "myspace"}, headers=HEADERS)
        assert resp.status_code == 422


# --- runtime assembly ---


def test_build_runtime_none_without_keys() -> None:
    assert build_runtime(make_settings()) is None  # type: ignore[call-arg]
    assert build_runtime(make_settings(anthropic_api_key="sk-x")) is None  # type: ignore[call-arg]
    assert build_runtime(make_settings(voyage_api_key="pa-x")) is None  # type: ignore[call-arg]


def test_build_runtime_real_with_keys() -> None:
    settings = make_settings(anthropic_api_key="sk-x", voyage_api_key="pa-x")
    runtime = build_runtime(settings)
    assert runtime is not None
    assert isinstance(runtime.store, GraphitiMemoryStore)
    assert isinstance(runtime.llm, AnthropicLLM)


def test_roster_from_json() -> None:
    roster = roster_from_json(
        '[{"id":"u_rikhin","lab_id":"lab1","person_id":"p_rikhin",'
        '"platform_handles":{"github":"r1khilt","gmail":"a@b.com"}}]'
    )
    assert len(roster) == 1
    assert roster[0].platform_handles[SourcePlatform.GITHUB] == "r1khilt"
    assert roster_from_json("") == []
    assert roster_from_json("   ") == []


def test_roster_from_json_malformed_raises() -> None:
    with pytest.raises(ValueError):
        roster_from_json("[{not json")
    with pytest.raises(ValueError):
        roster_from_json('[{"id":"u_x"}]')  # missing required fields

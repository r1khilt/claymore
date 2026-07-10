"""FastAPI contract for the live connector dashboard."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import claymore.api.routes.connectors as connector_routes
from claymore.domain import SourcePlatform
from claymore.ingest.composio.manager import (
    AuthorizationLink,
    AuthorizationResult,
    ConnectorView,
    SyncStarted,
)
from tests.fixtures import make_settings


class FakeManager:
    def __init__(self) -> None:
        self.callback_url = ""
        self.disconnected: list[SourcePlatform] = []

    async def list_connectors(self) -> list[ConnectorView]:
        return [
            ConnectorView(
                id="ca_1",
                platform=SourcePlatform.GMAIL,
                name="Gmail",
                connected=True,
                status="connected",
                account="scientist@lab.org",
                episodes=12,
            )
        ]

    async def start_authorization(
        self, source: SourcePlatform, callback_url: str
    ) -> AuthorizationLink:
        self.callback_url = callback_url
        return AuthorizationLink(authorize_url="https://auth.test/start", platform=source)

    async def finish_authorization(
        self, state_token: str, **_kwargs: object
    ) -> AuthorizationResult:
        assert state_token == "valid-state-token"
        return AuthorizationResult(
            source=SourcePlatform.GMAIL, status="connected", message="Connected."
        )

    async def start_sync(self, source: SourcePlatform) -> SyncStarted:
        return SyncStarted(job_id="job1", platform=source)

    async def disconnect(self, source: SourcePlatform) -> None:
        self.disconnected.append(source)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, FakeManager]]:
    fake = FakeManager()
    monkeypatch.setattr(
        connector_routes, "get_settings", lambda: make_settings(web_api_enabled=True)
    )
    connector_routes.set_connector_manager(fake)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(connector_routes.router)
    with TestClient(app) as test_client:
        yield test_client, fake
    connector_routes.set_connector_manager(None)


def test_list_connect_and_sync_contract(client: tuple[TestClient, FakeManager]) -> None:
    http, fake = client
    listed = http.get("/api/connectors")
    assert listed.status_code == 200
    assert listed.json()["connectors"][0]["lastSync"] is None

    connected = http.post("/api/connectors/gmail/connect", json={"reconnect": False})
    assert connected.status_code == 200
    assert connected.json()["authorizeUrl"] == "https://auth.test/start"
    assert fake.callback_url.endswith("/api/connectors/callback")

    synced = http.post("/api/connectors/gmail/sync")
    assert synced.status_code == 202
    assert synced.json() == {"jobId": "job1", "platform": "gmail", "status": "syncing"}


def test_callback_posts_safe_result_and_disconnects(client: tuple[TestClient, FakeManager]) -> None:
    http, fake = client
    callback = http.get("/api/connectors/callback?state=valid-state-token&connectedAccountId=ca_1")
    assert callback.status_code == 200
    assert "claymore:connector-oauth" in callback.text
    assert '"platform":"gmail"' in callback.text
    assert "Content-Security-Policy" in callback.headers

    disconnected = http.delete("/api/connectors/gmail")
    assert disconnected.status_code == 204
    assert fake.disconnected == [SourcePlatform.GMAIL]


def test_routes_fail_closed_when_dashboard_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        connector_routes, "get_settings", lambda: make_settings(web_api_enabled=False)
    )
    app = FastAPI()
    app.include_router(connector_routes.router)
    with TestClient(app) as http:
        assert http.get("/api/connectors").status_code == 404

"""Durable Composio connection lifecycle and sync orchestration."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

from claymore.domain import SourcePlatform
from claymore.ingest.composio.manager import ConnectorManager
from claymore.ingest.composio.state import ConnectorRecord, ConnectorStateStore, OAuthAttempt
from claymore.ingest.episodes import SQLiteEpisodeLog
from claymore.memory.graph import InMemoryMemoryStore
from claymore.ports import ConnectorHub
from tests.fixtures import make_episode, make_settings

NOW = datetime(2026, 7, 9, 20, 0, tzinfo=UTC)


def account(source: SourcePlatform, *, account_id: str = "ca_1", status: str = "ACTIVE") -> Any:
    return SimpleNamespace(
        id=account_id,
        alias=f"My {source.value}",
        word_id=None,
        status=status,
        is_disabled=False,
        user_id="web-user",
        toolkit=SimpleNamespace(slug=source.value),
        data={},
        state={},
    )


class FakeConnectedAccounts:
    def __init__(self) -> None:
        self.items: list[Any] = []
        self.deleted: list[tuple[str, bool]] = []

    def list(self, **_kwargs: Any) -> Any:
        return SimpleNamespace(items=list(self.items))

    def get(self, account_id: str) -> Any:
        return next(item for item in self.items if item.id == account_id)

    def delete(self, account_id: str, *, revoke_on_delete: bool) -> None:
        self.deleted.append((account_id, revoke_on_delete))
        self.items = [item for item in self.items if item.id != account_id]


class FakeSession:
    session_id = "session_1"

    def __init__(self, owner: FakeClient) -> None:
        self.owner = owner

    def authorize(self, toolkit: str, *, callback_url: str) -> Any:
        self.owner.callback_url = callback_url
        self.owner.connected_accounts.items = [account(SourcePlatform(toolkit))]
        return SimpleNamespace(id="ca_1", redirect_url="https://auth.composio.test/start")


class FakeToolRouter:
    def __init__(self) -> None:
        self.deleted_sessions: list[str] = []

    def delete(self, session_id: str) -> None:
        self.deleted_sessions.append(session_id)


class FakeClient:
    def __init__(self) -> None:
        self.connected_accounts = FakeConnectedAccounts()
        self.tool_router = FakeToolRouter()
        self.callback_url = ""
        self.create_kwargs: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> FakeSession:
        self.create_kwargs = kwargs
        return FakeSession(self)


class OneEpisodeHub(ConnectorHub):
    def __init__(self, source: SourcePlatform) -> None:
        self.source = source

    async def backfill(
        self, lab_id: str, source: SourcePlatform, since: datetime | None = None
    ) -> AsyncIterator[Any]:
        assert source is self.source
        yield make_episode(
            lab_id=lab_id,
            platform=source,
            source_id="remote-1",
            timestamp=NOW,
            source_hash="version-1",
        )

    async def incremental(self, lab_id: str, source: SourcePlatform) -> AsyncIterator[Any]:
        async for episode in self.backfill(lab_id, source):
            yield episode


async def test_state_is_durable_and_oauth_nonce_is_single_use(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    store = ConnectorStateStore(path)
    record = ConnectorRecord(
        lab_id="lab1",
        user_id="u1",
        source=SourcePlatform.GMAIL,
        status="connected",
        connected_account_id="ca_gmail",
        episode_count=4,
        updated_at=NOW,
    )
    await store.put(record)
    reopened = ConnectorStateStore(path)
    assert await reopened.get("lab1", "u1", SourcePlatform.GMAIL) == record

    attempt = OAuthAttempt(
        state="nonce",
        lab_id="lab1",
        user_id="u1",
        source=SourcePlatform.GMAIL,
        session_id="s1",
        connected_account_id="ca_gmail",
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=10),
    )
    await reopened.create_oauth(attempt)
    assert await reopened.consume_oauth("nonce", NOW) == attempt
    assert await reopened.consume_oauth("nonce", NOW) is None


async def test_expired_oauth_nonce_is_rejected(tmp_path: Path) -> None:
    store = ConnectorStateStore(tmp_path / "state.sqlite3")
    await store.create_oauth(
        OAuthAttempt(
            state="expired",
            lab_id="lab1",
            user_id="u1",
            source=SourcePlatform.NOTION,
            session_id="s1",
            connected_account_id="ca_1",
            created_at=NOW - timedelta(hours=1),
            expires_at=NOW - timedelta(minutes=1),
        )
    )
    assert await store.consume_oauth("expired", NOW) is None


async def test_oauth_nonce_is_atomic_under_concurrent_callbacks(tmp_path: Path) -> None:
    store = ConnectorStateStore(tmp_path / "state.sqlite3")
    await store.create_oauth(
        OAuthAttempt(
            state="one-use",
            lab_id="lab1",
            user_id="u1",
            source=SourcePlatform.SLACK,
            session_id="s1",
            connected_account_id="ca_1",
            created_at=NOW,
            expires_at=NOW + timedelta(minutes=1),
        )
    )
    results = await asyncio.gather(
        store.consume_oauth("one-use", NOW), store.consume_oauth("one-use", NOW)
    )
    assert sum(result is not None for result in results) == 1


def manager(tmp_path: Path, client: FakeClient, **kwargs: Any) -> ConnectorManager:
    state = ConnectorStateStore(tmp_path / "state.sqlite3")
    return ConnectorManager(
        make_settings(composio_api_key="cmp_test", web_api_enabled=True),
        state=state,
        episode_log=SQLiteEpisodeLog(state.path),
        client_factory=lambda: client,
        clock=lambda: NOW,
        **kwargs,
    )


async def test_session_authorization_callback_is_scoped_and_persisted(tmp_path: Path) -> None:
    client = FakeClient()
    service = manager(tmp_path, client)
    link = await service.start_authorization(
        SourcePlatform.GITHUB, "http://localhost:8000/api/connectors/callback"
    )
    assert link.authorize_url == "https://auth.composio.test/start"
    assert client.create_kwargs["user_id"] == "web-user"
    assert client.create_kwargs["toolkits"] == ["github"]
    assert client.create_kwargs["sandbox"] == {"enable": False}
    [state_token] = parse_qs(urlsplit(client.callback_url).query)["state"]

    result = await service.finish_authorization(state_token, callback_account_id="ca_1")
    assert result.status == "connected"
    saved = await service.state.get("lab1", "web-user", SourcePlatform.GITHUB)
    assert saved is not None
    assert saved.connected_account_id == "ca_1"
    assert saved.account_label == "My github"
    assert client.tool_router.deleted_sessions == ["session_1"]

    views = await service.list_connectors()
    github = next(view for view in views if view.platform is SourcePlatform.GITHUB)
    assert github.connected is True
    assert github.status == "connected"


async def test_sync_is_background_durable_and_deduplicated(tmp_path: Path) -> None:
    client = FakeClient()
    client.connected_accounts.items = [account(SourcePlatform.SLACK)]
    memory = InMemoryMemoryStore()
    service = manager(
        tmp_path,
        client,
        hub_factory=lambda **kwargs: OneEpisodeHub(kwargs["source"]),
        memory_store=lambda: memory,
    )

    started = await service.start_sync(SourcePlatform.SLACK)
    assert started.status == "syncing"
    for _ in range(100):
        saved = await service.state.get("lab1", "web-user", SourcePlatform.SLACK)
        if saved is not None and saved.status == "connected" and saved.last_sync_at is not None:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("sync did not finish")
    assert saved.episode_count == 1
    assert saved.last_source_at == NOW

    await service.start_sync(SourcePlatform.SLACK)
    for _ in range(100):
        saved = await service.state.get("lab1", "web-user", SourcePlatform.SLACK)
        if SourcePlatform.SLACK not in service._tasks:
            break
        await asyncio.sleep(0.01)
    assert saved is not None
    assert saved.episode_count == 1


async def test_disconnect_revokes_remote_account_and_clears_local_state(tmp_path: Path) -> None:
    client = FakeClient()
    client.connected_accounts.items = [account(SourcePlatform.NOTION)]
    service = manager(tmp_path, client)
    await service.list_connectors()
    await service.disconnect(SourcePlatform.NOTION)
    assert client.connected_accounts.deleted == [("ca_1", True)]
    assert await service.state.get("lab1", "web-user", SourcePlatform.NOTION) is None

"""Durable local state for Composio connector authorization and sync lifecycle.

The provider owns OAuth credentials; Claymore persists only opaque connected-account/session
identifiers plus sync metadata.  OAuth state nonces are one-time, expire quickly, and are scoped to
the configured lab/user/source so the browser callback cannot attach a different account.
"""

from __future__ import annotations

import asyncio
import builtins
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict

from claymore.domain import LabId, SourcePlatform, UserId
from claymore.memory.graph import ensure_aware

ConnectorStatus = Literal[
    "disconnected",
    "connecting",
    "connected",
    "syncing",
    "reauth_required",
    "error",
]


class ConnectorRecord(BaseModel):
    """One user's durable state for one provider toolkit."""

    model_config = ConfigDict(frozen=True)

    lab_id: LabId
    user_id: UserId
    source: SourcePlatform
    status: ConnectorStatus = "disconnected"
    connected_account_id: str | None = None
    account_label: str | None = None
    last_sync_at: datetime | None = None
    last_source_at: datetime | None = None
    episode_count: int = 0
    last_error: str | None = None
    updated_at: datetime


class OAuthAttempt(BaseModel):
    """Short-lived, single-use browser authorization attempt."""

    model_config = ConfigDict(frozen=True)

    state: str
    lab_id: LabId
    user_id: UserId
    source: SourcePlatform
    session_id: str
    connected_account_id: str
    expires_at: datetime
    created_at: datetime


class ConnectorStateStore:
    """SQLite repository shared with the local durable Episode log.

    Every call opens its own short transaction and runs it off the event loop. WAL mode lets a
    sync append episodes while the dashboard reads status. No OAuth token or provider payload is
    stored here.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path).expanduser()
        self._prepare()

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _prepare(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self._path.parent, 0o700)
        except OSError:
            pass
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS connector_states (
                    lab_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    connected_account_id TEXT,
                    account_label TEXT,
                    last_sync_at TEXT,
                    last_source_at TEXT,
                    episode_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (lab_id, user_id, source)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS connector_oauth_states (
                    state TEXT PRIMARY KEY,
                    lab_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    connected_account_id TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_connector_oauth_expiry "
                "ON connector_oauth_states(expires_at)"
            )
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _dt(value: object) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        return ensure_aware(datetime.fromisoformat(value))

    @staticmethod
    def _iso(value: datetime) -> str:
        return ensure_aware(value).astimezone(UTC).isoformat()

    @classmethod
    def _record(cls, row: sqlite3.Row) -> ConnectorRecord:
        return ConnectorRecord(
            lab_id=str(row["lab_id"]),
            user_id=str(row["user_id"]),
            source=SourcePlatform(str(row["source"])),
            status=cast(ConnectorStatus, str(row["status"])),
            connected_account_id=row["connected_account_id"],
            account_label=row["account_label"],
            last_sync_at=cls._dt(row["last_sync_at"]),
            last_source_at=cls._dt(row["last_source_at"]),
            episode_count=int(row["episode_count"]),
            last_error=row["last_error"],
            updated_at=cls._dt(row["updated_at"]) or datetime.now(UTC),
        )

    async def get(
        self, lab_id: LabId, user_id: UserId, source: SourcePlatform
    ) -> ConnectorRecord | None:
        def read() -> ConnectorRecord | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT * FROM connector_states "
                    "WHERE lab_id = ? AND user_id = ? AND source = ?",
                    (lab_id, user_id, source.value),
                ).fetchone()
            return self._record(row) if row is not None else None

        return await asyncio.to_thread(read)

    async def list(self, lab_id: LabId, user_id: UserId) -> list[ConnectorRecord]:
        def read() -> list[ConnectorRecord]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM connector_states WHERE lab_id = ? AND user_id = ?",
                    (lab_id, user_id),
                ).fetchall()
            return [self._record(row) for row in rows]

        return await asyncio.to_thread(read)

    async def put(self, record: ConnectorRecord) -> None:
        def write() -> None:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO connector_states (
                        lab_id, user_id, source, status, connected_account_id, account_label,
                        last_sync_at, last_source_at, episode_count, last_error, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(lab_id, user_id, source) DO UPDATE SET
                        status = excluded.status,
                        connected_account_id = excluded.connected_account_id,
                        account_label = excluded.account_label,
                        last_sync_at = excluded.last_sync_at,
                        last_source_at = excluded.last_source_at,
                        episode_count = excluded.episode_count,
                        last_error = excluded.last_error,
                        updated_at = excluded.updated_at
                    """,
                    (
                        record.lab_id,
                        record.user_id,
                        record.source.value,
                        record.status,
                        record.connected_account_id,
                        record.account_label,
                        self._iso(record.last_sync_at) if record.last_sync_at else None,
                        self._iso(record.last_source_at) if record.last_source_at else None,
                        record.episode_count,
                        record.last_error,
                        self._iso(record.updated_at),
                    ),
                )

        await asyncio.to_thread(write)

    async def delete(self, lab_id: LabId, user_id: UserId, source: SourcePlatform) -> None:
        def write() -> None:
            with self._connect() as conn:
                conn.execute(
                    "DELETE FROM connector_states WHERE lab_id = ? AND user_id = ? AND source = ?",
                    (lab_id, user_id, source.value),
                )

        await asyncio.to_thread(write)

    async def create_oauth(self, attempt: OAuthAttempt) -> None:
        def write() -> None:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO connector_oauth_states (
                        state, lab_id, user_id, source, session_id, connected_account_id,
                        expires_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        attempt.state,
                        attempt.lab_id,
                        attempt.user_id,
                        attempt.source.value,
                        attempt.session_id,
                        attempt.connected_account_id,
                        self._iso(attempt.expires_at),
                        self._iso(attempt.created_at),
                    ),
                )

        await asyncio.to_thread(write)

    async def expire_oauth(self, now: datetime) -> builtins.list[OAuthAttempt]:
        """Atomically remove and return expired attempts so their remote sessions can be closed."""

        def write() -> builtins.list[OAuthAttempt]:
            cutoff = ensure_aware(now)
            with self._connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                rows = conn.execute(
                    "SELECT * FROM connector_oauth_states WHERE expires_at <= ?",
                    (self._iso(cutoff),),
                ).fetchall()
                conn.execute(
                    "DELETE FROM connector_oauth_states WHERE expires_at <= ?",
                    (self._iso(cutoff),),
                )
            attempts: builtins.list[OAuthAttempt] = []
            for row in rows:
                expires = self._dt(row["expires_at"])
                if expires is None:
                    continue
                attempts.append(
                    OAuthAttempt(
                        state=str(row["state"]),
                        lab_id=str(row["lab_id"]),
                        user_id=str(row["user_id"]),
                        source=SourcePlatform(str(row["source"])),
                        session_id=str(row["session_id"]),
                        connected_account_id=str(row["connected_account_id"]),
                        expires_at=expires,
                        created_at=self._dt(row["created_at"]) or cutoff,
                    )
                )
            return attempts

        return await asyncio.to_thread(write)

    async def consume_oauth(self, state: str, now: datetime) -> OAuthAttempt | None:
        """Atomically take a valid nonce; a replay or expired callback returns ``None``."""

        def write() -> OAuthAttempt | None:
            with self._connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute(
                    "SELECT * FROM connector_oauth_states WHERE state = ?", (state,)
                ).fetchone()
                conn.execute("DELETE FROM connector_oauth_states WHERE state = ?", (state,))
            if row is None:
                return None
            expires = self._dt(row["expires_at"])
            if expires is None or expires <= ensure_aware(now):
                return None
            return OAuthAttempt(
                state=str(row["state"]),
                lab_id=str(row["lab_id"]),
                user_id=str(row["user_id"]),
                source=SourcePlatform(str(row["source"])),
                session_id=str(row["session_id"]),
                connected_account_id=str(row["connected_account_id"]),
                expires_at=expires,
                created_at=self._dt(row["created_at"]) or ensure_aware(now),
            )

        return await asyncio.to_thread(write)

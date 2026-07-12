"""Application service for Composio OAuth, connection status, and durable sync jobs.

Claymore uses Composio Sessions for managed OAuth, so a local installation needs only a
``COMPOSIO_API_KEY``. Provider access/refresh tokens remain in Composio; this module stores opaque
account ids and bounded sync checkpoints in the local SQLite state file.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import secrets
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from claymore.api.runtime import roster_from_json
from claymore.config import Settings
from claymore.domain import SourcePlatform
from claymore.ingest.composio.state import (
    ConnectorRecord,
    ConnectorStateStore,
    ConnectorStatus,
    OAuthAttempt,
)
from claymore.ingest.episodes import EpisodeLog, SQLiteEpisodeLog
from claymore.ingest.pipeline import ingest_source
from claymore.local_store import local_dir
from claymore.logging import get_logger
from claymore.memory.identity import IdentityResolver
from claymore.ports import ConnectorHub, MemoryStore

_log = get_logger("ingest.composio.manager")

SUPPORTED_SOURCES = (
    SourcePlatform.SLACK,
    SourcePlatform.GMAIL,
    SourcePlatform.GITHUB,
    SourcePlatform.NOTION,
)

_NAMES = {
    SourcePlatform.SLACK: "Slack",
    SourcePlatform.GMAIL: "Gmail",
    SourcePlatform.GITHUB: "GitHub",
    SourcePlatform.NOTION: "Notion",
}

_ACTIVE = "ACTIVE"
_CONNECTING = frozenset({"INITIALIZING", "INITIATED"})
_REAUTH = frozenset({"EXPIRED", "REVOKED"})
_FAILED = frozenset({"FAILED"})
_OAUTH_TTL = timedelta(minutes=15)


class ConnectorServiceError(RuntimeError):
    """Safe, user-displayable connector error with an HTTP status."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class ConnectorView(BaseModel):
    """Browser-safe connector state (never includes a provider payload or credential)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str | None = None
    platform: SourcePlatform
    name: str
    connected: bool
    status: ConnectorStatus
    account: str | None = None
    last_sync: datetime | None = None
    episodes: int = 0
    error: str | None = None


class AuthorizationLink(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    authorize_url: str
    platform: SourcePlatform


class AuthorizationResult(BaseModel):
    source: SourcePlatform
    status: ConnectorStatus
    message: str


class SyncStarted(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    job_id: str
    platform: SourcePlatform
    status: ConnectorStatus = "syncing"


def default_state_path() -> Path:
    return local_dir() / "state.sqlite3"


def _get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(key, default)
    return getattr(value, key, default)


def _status(account: Any) -> str:
    raw = _get(account, "status", "")
    return str(raw).upper() if raw is not None else ""


def _toolkit(account: Any) -> str:
    toolkit = _get(account, "toolkit")
    raw = _get(toolkit, "slug", "")
    return str(raw).lower() if raw is not None else ""


def _account_id(account: Any) -> str:
    value = _get(account, "id", "")
    return str(value) if value is not None else ""


def _remote_status(account: Any) -> ConnectorStatus:
    if _get(account, "is_disabled", False) is True:
        return "disconnected"
    status = _status(account)
    if status == _ACTIVE:
        return "connected"
    if status in _CONNECTING:
        return "connecting"
    if status in _REAUTH:
        return "reauth_required"
    if status in _FAILED:
        return "error"
    return "disconnected"


_LABEL_KEYS = (
    "display_name",
    "displayName",
    "email",
    "login",
    "username",
    "workspace_name",
    "workspaceName",
    "team_name",
    "teamName",
    "name",
)


def _label_in(value: Any, depth: int = 0) -> str | None:
    """Find a harmless account label while refusing to surface arbitrary provider state."""
    if depth > 3:
        return None
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="python")
    if not isinstance(value, Mapping):
        return None
    for key in _LABEL_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()[:120]
    for key, child in value.items():
        lowered = str(key).casefold()
        if any(secret in lowered for secret in ("token", "secret", "password", "credential")):
            continue
        found = _label_in(child, depth + 1)
        if found:
            return found
    return None


def _account_label(account: Any) -> str | None:
    for field in ("alias", "word_id"):
        value = _get(account, field)
        if isinstance(value, str) and value.strip():
            return value.strip()[:120]
    return _label_in(_get(account, "data", {})) or _label_in(_get(account, "state", {}))


async def _sdk_call(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run the synchronous Composio SDK off-loop while remaining fake-friendly in tests."""
    result = await asyncio.to_thread(fn, *args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


class ConnectorManager:
    """One-process coordinator backed by crash-safe local state."""

    def __init__(
        self,
        settings: Settings,
        *,
        state: ConnectorStateStore | None = None,
        episode_log: EpisodeLog | None = None,
        client_factory: Callable[[], Any] | None = None,
        hub_factory: Callable[..., ConnectorHub] | None = None,
        memory_store: Callable[[], MemoryStore] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.settings = settings
        path = state.path if state is not None else default_state_path()
        self.state = state or ConnectorStateStore(path)
        self.episode_log = episode_log or SQLiteEpisodeLog(path)
        self._client_factory = client_factory
        self._hub_factory = hub_factory
        self._memory_store = memory_store
        self._clock = clock
        self._client_obj: Any = None
        self._tasks: dict[SourcePlatform, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()

    @property
    def lab_id(self) -> str:
        return self.settings.web_lab_id

    @property
    def user_id(self) -> str:
        return self.settings.web_user_id

    @property
    def composio_user_id(self) -> str:
        return self.settings.composio_user_id.strip() or self.settings.web_user_id

    def _client(self) -> Any:
        key = self.settings.composio_api_key.get_secret_value().strip()
        if not key:
            raise ConnectorServiceError(
                "Add COMPOSIO_API_KEY to .env, then restart Claymore.", status_code=503
            )
        if self._client_obj is None:
            if self._client_factory is not None:
                self._client_obj = self._client_factory()
            else:
                cache = (
                    Path(self.settings.composio_cache_dir).expanduser()
                    if self.settings.composio_cache_dir.strip()
                    else local_dir() / "composio-cache"
                )
                cache.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.environ["COMPOSIO_CACHE_DIR"] = str(cache)
                from composio import Composio

                self._client_obj = Composio(api_key=key)
        return self._client_obj

    def _new_record(self, source: SourcePlatform) -> ConnectorRecord:
        return ConnectorRecord(
            lab_id=self.lab_id,
            user_id=self.user_id,
            source=source,
            updated_at=self._clock(),
        )

    async def _save_if_changed(
        self, old: ConnectorRecord | None, updated: ConnectorRecord
    ) -> ConnectorRecord:
        old_data = old.model_dump(exclude={"updated_at"}) if old else None
        new_data = updated.model_dump(exclude={"updated_at"})
        if old_data != new_data:
            updated = updated.model_copy(update={"updated_at": self._clock()})
            await self.state.put(updated)
        return updated

    async def _accounts(self, sources: tuple[SourcePlatform, ...]) -> list[Any]:
        client = self._client()
        try:
            response = await _sdk_call(
                client.connected_accounts.list,
                user_ids=[self.composio_user_id],
                toolkit_slugs=[source.value for source in sources],
                order_by="updated_at",
                order_direction="desc",
                limit=100,
            )
        except ConnectorServiceError:
            raise
        except Exception as exc:
            _log.warning("composio.accounts_failed", error_type=type(exc).__name__)
            raise ConnectorServiceError(
                "Could not reach Composio. Check COMPOSIO_API_KEY and try again."
            ) from exc
        items = _get(response, "items", [])
        return list(items) if isinstance(items, (list, tuple)) else []

    @staticmethod
    def _select_account(record: ConnectorRecord | None, accounts: list[Any]) -> Any | None:
        if record and record.connected_account_id:
            for account in accounts:
                if _account_id(account) == record.connected_account_id:
                    return account
        for account in accounts:
            if _status(account) == _ACTIVE and _get(account, "is_disabled", False) is not True:
                return account
        return accounts[0] if accounts else None

    def _view(self, record: ConnectorRecord, error: str | None = None) -> ConnectorView:
        status = "syncing" if record.source in self._tasks else record.status
        return ConnectorView(
            id=record.connected_account_id,
            platform=record.source,
            name=_NAMES[record.source],
            connected=status in {"connected", "syncing"},
            status=status,
            account=record.account_label,
            last_sync=record.last_sync_at,
            episodes=record.episode_count,
            error=error if error is not None else record.last_error,
        )

    async def list_connectors(self) -> list[ConnectorView]:
        for attempt in await self.state.expire_oauth(self._clock()):
            await self._delete_session(attempt.session_id)
        saved = {
            record.source: record for record in await self.state.list(self.lab_id, self.user_id)
        }
        try:
            accounts = await self._accounts(SUPPORTED_SOURCES)
        except ConnectorServiceError as exc:
            return [
                self._view(saved.get(source) or self._new_record(source), str(exc))
                for source in SUPPORTED_SOURCES
            ]

        grouped: dict[SourcePlatform, list[Any]] = {source: [] for source in SUPPORTED_SOURCES}
        for account in accounts:
            slug = _toolkit(account)
            try:
                source = SourcePlatform(slug)
            except ValueError:
                continue
            if source in grouped:
                grouped[source].append(account)

        views: list[ConnectorView] = []
        for source in SUPPORTED_SOURCES:
            old = saved.get(source)
            record = old or self._new_record(source)
            selected = self._select_account(old, grouped[source])
            if selected is not None:
                new_status = _remote_status(selected)
                if source in self._tasks:
                    new_status = "syncing"
                clear_oauth_error = (
                    new_status == "connected"
                    and record.status in {"connecting", "reauth_required", "error"}
                    and record.last_sync_at is None
                )
                record = record.model_copy(
                    update={
                        "status": new_status,
                        "connected_account_id": _account_id(selected) or None,
                        "account_label": _account_label(selected) or record.account_label,
                        "last_error": None if clear_oauth_error else record.last_error,
                    }
                )
            elif old is not None:
                if old.status in {"connected", "syncing"}:
                    record = old.model_copy(
                        update={
                            "status": "reauth_required",
                            "last_error": "The provider connection is no longer active.",
                        }
                    )
                elif old.status == "connecting" and self._clock() - old.updated_at > _OAUTH_TTL:
                    record = old.model_copy(
                        update={
                            "status": "error",
                            "last_error": "Authorization timed out. Connect again.",
                        }
                    )
            record = await self._save_if_changed(old, record)
            views.append(self._view(record))
        return views

    @staticmethod
    def _callback_with_state(callback_url: str, state: str) -> str:
        parts = urlsplit(callback_url)
        query = parse_qsl(parts.query, keep_blank_values=True)
        query.append(("state", state))
        return urlunsplit(
            (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
        )

    async def start_authorization(
        self, source: SourcePlatform, callback_url: str
    ) -> AuthorizationLink:
        if source not in SUPPORTED_SOURCES:
            raise ConnectorServiceError("Unsupported connector.", status_code=404)
        client = self._client()
        for expired in await self.state.expire_oauth(self._clock()):
            await self._delete_session(expired.session_id)
        state_token = secrets.token_urlsafe(32)
        callback = self._callback_with_state(callback_url, state_token)
        try:
            session = await _sdk_call(
                client.create,
                user_id=self.composio_user_id,
                toolkits=[source.value],
                manage_connections=True,
                sandbox={"enable": False},
            )
            request = await _sdk_call(session.authorize, source.value, callback_url=callback)
            session_id = str(_get(session, "session_id", ""))
            account_id = str(_get(request, "id", ""))
            redirect_url = str(_get(request, "redirect_url", ""))
            if not session_id or not account_id or not redirect_url:
                raise ValueError("incomplete Composio authorization response")
        except Exception as exc:
            _log.warning("composio.authorize_failed", source=source, error_type=type(exc).__name__)
            raise ConnectorServiceError(
                f"Could not start {_NAMES[source]} authorization. Check the Composio key."
            ) from exc

        now = self._clock()
        await self.state.create_oauth(
            OAuthAttempt(
                state=state_token,
                lab_id=self.lab_id,
                user_id=self.user_id,
                source=source,
                session_id=session_id,
                connected_account_id=account_id,
                created_at=now,
                expires_at=now + _OAUTH_TTL,
            )
        )
        old = await self.state.get(self.lab_id, self.user_id, source)
        record = (old or self._new_record(source)).model_copy(
            update={
                "status": "connecting",
                "connected_account_id": account_id,
                "last_error": None,
                "updated_at": now,
            }
        )
        await self.state.put(record)
        return AuthorizationLink(authorize_url=redirect_url, platform=source)

    async def _delete_session(self, session_id: str) -> None:
        try:
            await _sdk_call(self._client().tool_router.delete, session_id)
        except Exception as exc:
            _log.info("composio.session_cleanup_failed", error_type=type(exc).__name__)

    async def finish_authorization(
        self,
        state_token: str,
        *,
        callback_status: str | None = None,
        callback_account_id: str | None = None,
    ) -> AuthorizationResult:
        attempt = await self.state.consume_oauth(state_token, self._clock())
        if attempt is None:
            raise ConnectorServiceError(
                "This authorization link is invalid or expired. "
                "Return to Claymore and connect again.",
                status_code=400,
            )
        if callback_account_id and callback_account_id != attempt.connected_account_id:
            await self._delete_session(attempt.session_id)
            raise ConnectorServiceError("Authorization account mismatch.", status_code=400)

        failed_callback = (callback_status or "").casefold() in {
            "error",
            "failed",
            "failure",
            "cancelled",
            "canceled",
        }
        if failed_callback:
            old = await self.state.get(attempt.lab_id, attempt.user_id, attempt.source)
            record = (old or self._new_record(attempt.source)).model_copy(
                update={
                    "status": "error",
                    "last_error": "Authorization was not completed.",
                    "updated_at": self._clock(),
                }
            )
            await self.state.put(record)
            await self._delete_session(attempt.session_id)
            return AuthorizationResult(
                source=attempt.source,
                status="error",
                message="Authorization was not completed.",
            )

        account: Any = None
        for delay in (0.0, 0.25, 0.5, 1.0):
            if delay:
                await asyncio.sleep(delay)
            try:
                account = await _sdk_call(
                    self._client().connected_accounts.get, attempt.connected_account_id
                )
            except Exception:
                account = None
            if account is not None and _status(account) == _ACTIVE:
                break

        if account is None:
            await self._delete_session(attempt.session_id)
            raise ConnectorServiceError(
                "Composio could not verify the connected account. Connect again.", status_code=502
            )
        returned_user = _get(account, "user_id")
        if (
            isinstance(returned_user, str)
            and returned_user
            and returned_user != self.composio_user_id
        ):
            await self._delete_session(attempt.session_id)
            raise ConnectorServiceError("Authorization user mismatch.", status_code=400)
        if (
            _account_id(account) != attempt.connected_account_id
            or _toolkit(account) != attempt.source.value
        ):
            await self._delete_session(attempt.session_id)
            raise ConnectorServiceError("Authorization provider mismatch.", status_code=400)

        remote = _remote_status(account)
        old = await self.state.get(attempt.lab_id, attempt.user_id, attempt.source)
        record = (old or self._new_record(attempt.source)).model_copy(
            update={
                "status": remote,
                "connected_account_id": attempt.connected_account_id,
                "account_label": _account_label(account),
                "last_error": None if remote == "connected" else "Authorization is not active yet.",
                "updated_at": self._clock(),
            }
        )
        await self.state.put(record)
        await self._delete_session(attempt.session_id)
        return AuthorizationResult(
            source=attempt.source,
            status=remote,
            message="Connected." if remote == "connected" else "Authorization is still pending.",
        )

    async def _active_account(self, source: SourcePlatform) -> tuple[ConnectorRecord, Any]:
        old = await self.state.get(self.lab_id, self.user_id, source)
        accounts = [
            account
            for account in await self._accounts((source,))
            if _toolkit(account) == source.value
        ]
        selected = self._select_account(old, accounts)
        if selected is None or _remote_status(selected) != "connected":
            raise ConnectorServiceError(
                f"Connect {_NAMES[source]} before syncing.", status_code=409
            )
        record = old or self._new_record(source)
        record = record.model_copy(
            update={
                "status": "connected",
                "connected_account_id": _account_id(selected),
                "account_label": _account_label(selected) or record.account_label,
            }
        )
        await self._save_if_changed(old, record)
        return record, selected

    def _build_hub(
        self, source: SourcePlatform, resolver: IdentityResolver | None, account_id: str
    ) -> ConnectorHub:
        if self._hub_factory is not None:
            return self._hub_factory(
                source=source,
                resolver=resolver,
                connected_account_id=account_id,
            )
        from claymore.ingest.composio.hub import ComposioConnectorHub

        return ComposioConnectorHub(
            self.settings,
            resolver=resolver,
            user_id=self.composio_user_id,
            connected_account_id=account_id,
            owner_user_id=self.user_id,
        )

    def _store(self) -> MemoryStore:
        if self._memory_store is not None:
            return self._memory_store()
        from claymore.agent import get_runtime

        return get_runtime().store

    async def start_sync(self, source: SourcePlatform) -> SyncStarted:
        if source not in SUPPORTED_SOURCES:
            raise ConnectorServiceError("Unsupported connector.", status_code=404)
        async with self._lock:
            task = self._tasks.get(source)
            if task is not None and not task.done():
                raise ConnectorServiceError(
                    f"{_NAMES[source]} is already syncing.", status_code=409
                )
            record, account = await self._active_account(source)
            job_id = secrets.token_hex(6)
            syncing = record.model_copy(update={"status": "syncing", "updated_at": self._clock()})
            await self.state.put(syncing)
            self._tasks[source] = asyncio.create_task(
                self._run_sync(source, _account_id(account), job_id),
                name=f"composio-sync-{source.value}-{job_id}",
            )
        return SyncStarted(job_id=job_id, platform=source)

    async def _run_sync(self, source: SourcePlatform, account_id: str, job_id: str) -> None:
        record = await self.state.get(self.lab_id, self.user_id, source) or self._new_record(source)
        try:
            roster = roster_from_json(self.settings.lab_roster_json)
            resolver = IdentityResolver(self.lab_id, roster) if roster else None
            hub = self._build_hub(source, resolver, account_id)
            since = record.last_source_at or (
                self._clock() - timedelta(days=self.settings.composio_sync_days)
            )
            stats = await ingest_source(
                hub,
                self.episode_log,
                self._store(),
                lab_id=self.lab_id,
                source=source,
                resolver=resolver,
                since=since,
            )
            warning = (
                f"Sync completed with {stats.skipped_errors} item error(s)."
                if stats.skipped_errors
                else None
            )
            latest = record.last_source_at
            if not stats.skipped_errors and stats.latest_source_at is not None:
                if latest is None or stats.latest_source_at > latest:
                    latest = stats.latest_source_at
            completed = record.model_copy(
                update={
                    "status": "connected",
                    "connected_account_id": account_id,
                    "last_sync_at": self._clock(),
                    "last_source_at": latest,
                    "episode_count": record.episode_count + stats.stored,
                    "last_error": warning,
                    "updated_at": self._clock(),
                }
            )
            await self.state.put(completed)
            _log.info(
                "composio.sync_done",
                source=source,
                job_id=job_id,
                seen=stats.seen,
                stored=stats.stored,
            )
        except Exception as exc:
            _log.warning(
                "composio.sync_failed",
                source=source,
                job_id=job_id,
                error_type=type(exc).__name__,
            )
            failed = record.model_copy(
                update={
                    "status": "connected",
                    "connected_account_id": account_id,
                    "last_error": "Sync failed. Check the provider connection and try again.",
                    "updated_at": self._clock(),
                }
            )
            await self.state.put(failed)
        finally:
            self._tasks.pop(source, None)

    async def disconnect(self, source: SourcePlatform) -> None:
        if source not in SUPPORTED_SOURCES:
            raise ConnectorServiceError("Unsupported connector.", status_code=404)
        task = self._tasks.get(source)
        if task is not None and not task.done():
            raise ConnectorServiceError("Wait for the current sync to finish.", status_code=409)
        record = await self.state.get(self.lab_id, self.user_id, source)
        account_ids = (
            {record.connected_account_id}
            if record is not None and record.connected_account_id
            else set()
        )
        try:
            accounts = await self._accounts((source,))
            account_ids.update(
                _account_id(account)
                for account in accounts
                if _toolkit(account) == source.value and _account_id(account)
            )
        except ConnectorServiceError:
            # A locally selected id is still enough to revoke the visible integration. If there is
            # no selected id, keep state intact because we cannot prove what remains provider-side.
            if not account_ids:
                raise
        for account_id in account_ids:
            try:
                await _sdk_call(
                    self._client().connected_accounts.delete,
                    account_id,
                    revoke_on_delete=True,
                )
            except Exception as exc:
                _log.warning(
                    "composio.disconnect_failed", source=source, error_type=type(exc).__name__
                )
                raise ConnectorServiceError(
                    f"Could not disconnect {_NAMES[source]}. Try again."
                ) from exc
        await self.state.delete(self.lab_id, self.user_id, source)

    async def send_slack_message(self, *, channel: str, text: str) -> dict[str, Any]:
        """Post a Slack message via Composio — the write-back behind the dashboard's one-tap Send.

        Executes the SLACK send tool for the configured Composio user against the connected
        account. Returns a small dict of non-secret handles (``channel`` + ``ts``). Raises
        :class:`ConnectorServiceError` (with a safe, user-displayable message + HTTP status) on
        any failure, so the route can surface it without leaking a token or payload.
        """
        chan = channel.strip().lstrip("#").strip()
        body = text.strip()
        if not chan or not body:
            raise ConnectorServiceError("A channel and a message are required.", status_code=400)

        client = self._client()
        # Composio's Slack toolkit has used a couple of slugs for "post a message"; try the
        # verbose current one first, then the shorter legacy one, so the send is resilient.
        candidates = ("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", "SLACK_SEND_MESSAGE")
        last_error = "Slack send failed."
        for slug in candidates:
            try:
                result = await _sdk_call(
                    client.tools.execute,
                    slug,
                    user_id=self.composio_user_id,
                    arguments={"channel": chan, "text": body},
                )
            except Exception as exc:  # unknown-tool / transport — try the next candidate slug
                last_error = type(exc).__name__
                _log.warning("composio.slack_send_error", slug=slug, error_type=last_error)
                continue
            ok = bool(_get(result, "successful", _get(result, "success", False)))
            if not ok:
                last_error = str(_get(result, "error", "") or "rejected")
                _log.warning("composio.slack_send_rejected", slug=slug, error=last_error[:120])
                continue
            data = _get(result, "data", {}) or {}
            message = _get(data, "message", {}) or {}
            ts = str(_get(data, "ts", "") or _get(message, "ts", ""))
            _log.info("composio.slack_sent", channel=chan, slug=slug)
            return {"ok": True, "channel": chan, "ts": ts}

        raise ConnectorServiceError(
            f"Slack did not accept the message ({last_error}). "
            "Check that Slack is connected in Connectors and the bot is in that channel.",
            status_code=502,
        )

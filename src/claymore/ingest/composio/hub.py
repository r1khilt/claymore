"""[Pipes] Composio ``ConnectorHub`` adapter — Slack, Gmail, GitHub, and Notion.

Implements :class:`claymore.ports.ConnectorHub` over Composio managed OAuth (per-user connected
accounts). ``backfill``/``incremental`` are **streaming async generators** — they page the
source and yield one :class:`~claymore.ingest.normalize.Episode` at a time, never accumulating a
whole history in memory (R6/§2). Each item is normalized + scoped + author-resolved through the
shared parsers in :mod:`claymore.ingest.composio.sources`, so the live adapter and the
:class:`FakeConnectorHub` used by tests exercise exactly the same code path.

Provenance/scope/identity guarantees come from ``sources.py``: ``visibility`` is derived
fail-closed from each item's ACL (R13); authors are resolved via :class:`IdentityResolver` or
left ``unknown`` — never guessed (hard rule 1); ``is_untrusted`` is always ``True`` (all
ingested content is data, never instructions — SECURITY.md rule 1).

Operational notes:

- **15-min polling caveat (§5):** Composio-managed OAuth apps default to ~15-minute trigger
  polling. ``incremental`` is therefore a *poll* — call it on a schedule; register your own
  OAuth app per provider if you need fresher-than-15-min sync.
- **Backfill cost (R6):** the application supplies a bounded first-sync window and provider-side
  filters wherever the provider supports them. Durable dedup/checkpoints prevent re-extraction.
- **Resumability:** :meth:`checkpoint` exposes the last source-time seen per (lab, source);
  ``incremental`` resumes from it. A caller can persist it (Postgres) and reconstruct a hub that
  continues where it left off.

Tool schemas are pinned per provider because this adapter parses response fields in Python.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Mapping
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import structlog

from claymore.domain import LabId, SourcePlatform
from claymore.ingest.composio.sources import (
    GITHUB_COMMITS_SLUG,
    GITHUB_REPOS_SLUG,
    NOTION_BLOCKS_SLUG,
    SLACK_CHANNEL_TYPES,
    SLACK_CHANNELS_SLUG,
    SLACK_HISTORY_SLUG,
    SLACK_THREAD_SLUG,
    SourceSpec,
    _first_str,
    _github_private_flag,
    extract_cursor,
    extract_items,
    get_spec,
    github_commits,
    github_episode,
    github_repos,
    notion_block_text,
    slack_channels,
    slack_enrich_message,
    slack_next_cursor,
    to_episode,
)
from claymore.ingest.normalize import Episode
from claymore.memory.graph import ensure_aware
from claymore.memory.identity import IdentityResolver
from claymore.ports import ConnectorHub

if TYPE_CHECKING:
    from claymore.config import Settings

logger = structlog.get_logger(__name__)

# Hard cap on pages per backfill — a defensive stop against a source that keeps returning a
# fresh cursor forever (or a buggy one that never advances). Streaming already bounds memory;
# this bounds *cost/time* (R6). Raise deliberately for a large calibrated backfill.
_MAX_PAGES = 10_000


class ComposioExecutionError(RuntimeError):
    """A provider read failed or returned an unsuccessful Composio envelope."""


class _StreamingHub(ConnectorHub):
    """Shared ``incremental``/``checkpoint`` for connector hubs built on a streaming ``backfill``.

    Subclasses implement ``backfill`` (the source-specific paging). ``incremental`` resumes from
    the last source-time seen per (lab, source) and advances the checkpoint as it yields — so a
    re-poll only surfaces genuinely newer episodes (dedup in the Episode log handles the
    inclusive-boundary overlap, R6/R14).
    """

    def __init__(self) -> None:
        self._checkpoints: dict[tuple[LabId, SourcePlatform], datetime] = {}

    async def incremental(self, lab_id: LabId, source: SourcePlatform) -> AsyncIterator[Episode]:
        since = self._checkpoints.get((lab_id, source))
        async for episode in self.backfill(lab_id, source, since=since):
            ts = ensure_aware(episode.timestamp)
            prev = self._checkpoints.get((lab_id, source))
            if prev is None or ts > prev:
                self._checkpoints[(lab_id, source)] = ts
            yield episode

    def checkpoint(self, lab_id: LabId, source: SourcePlatform) -> datetime | None:
        """Last source-time seen for (lab, source) — the resumable sync cursor (persist this)."""
        return self._checkpoints.get((lab_id, source))


def _response_data(response: Any) -> Mapping[str, Any]:
    """Defensively pull the ``data`` mapping off a Composio tool-execution response.

    Calibrated against a live call: the SDK returns a plain ``dict``
    (``{"data": {...}, "error": ..., "successful": ...}``), not an object with a ``.data``
    attribute — so try mapping-key access first, then fall back to attribute access for
    forward-compat with a typed response object.
    """
    if isinstance(response, Mapping):
        successful = response.get("successful")
        error = response.get("error")
        data = response.get("data")
    else:
        successful = getattr(response, "successful", None)
        error = getattr(response, "error", None)
        data = getattr(response, "data", None)
    if successful is False or (isinstance(error, str) and error.strip()):
        raise ComposioExecutionError("Composio reported an unsuccessful tool execution")
    if not isinstance(data, Mapping):
        raise ComposioExecutionError("Composio returned a malformed tool response")
    return data


def _is_transient(exc: Exception) -> bool:
    if isinstance(exc, ComposioExecutionError):
        return False
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status in {408, 409, 425, 429} or status >= 500
    return True


class ComposioConnectorHub(_StreamingHub):
    """Live Composio adapter. ``composio`` is lazy-imported so tests/CI never require the SDK.

    One hub pulls from one connected account (``user_id`` = the Composio entity id, i.e. our lab
    user). Multi-user labs construct one hub per connected account. The API key comes from
    settings; the SDK client is built lazily on first fetch.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        resolver: IdentityResolver | None = None,
        user_id: str | None = None,
        connected_account_id: str | None = None,
        owner_user_id: str | None = None,
        page_size: int | None = None,
    ) -> None:
        super().__init__()
        self._settings = settings
        self._resolver = resolver
        self._user_id = user_id
        self._connected_account_id = connected_account_id
        # Composio's session user and Claymore's visibility owner are different namespaces.
        self._owner_user_id = owner_user_id
        self._page_size = page_size
        self._client_obj: Any = None

    def _client(self) -> Any:
        """Build the Composio client on first use (lazy import keeps the SDK optional)."""
        if self._client_obj is None:
            from claymore.local_store import local_dir

            cache = (
                Path(self._settings.composio_cache_dir).expanduser()
                if self._settings.composio_cache_dir.strip()
                else local_dir() / "composio-cache"
            )
            cache.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.environ["COMPOSIO_CACHE_DIR"] = str(cache)
            from composio import Composio

            self._client_obj = Composio(api_key=self._settings.composio_api_key.get_secret_value())
        return self._client_obj

    def _version_for(self, slug: str) -> str:
        toolkit = slug.partition("_")[0].casefold()
        versions = {
            "slack": self._settings.composio_slack_version,
            "gmail": self._settings.composio_gmail_version,
            "github": self._settings.composio_github_version,
            "notion": self._settings.composio_notion_version,
        }
        try:
            return versions[toolkit]
        except KeyError:
            raise ValueError(f"unsupported Composio toolkit for {slug!r}") from None

    async def backfill(
        self, lab_id: LabId, source: SourcePlatform, since: datetime | None = None
    ) -> AsyncIterator[Episode]:
        # GitHub and Slack are 2-level flows (enumerate repos/channels → page each one's
        # commits/history), so they can't use the single-action cursor loop below; each delegates to
        # a dedicated path that shares parse + visibility + owner-injection with the fake.
        if source is SourcePlatform.GITHUB:
            async for github_ep in self._github_backfill(lab_id, since):
                yield github_ep
            return
        if source is SourcePlatform.SLACK:
            async for slack_ep in self._slack_backfill(lab_id, since):
                yield slack_ep
            return

        spec = get_spec(source)
        page_size = spec.default_page_size if self._page_size is None else self._page_size
        cursor: str | None = None
        seen_cursors: set[str] = set()

        for _ in range(_MAX_PAGES):
            # spec.extra_args carries any REQUIRED non-pagination input (e.g. Notion's fetch_type).
            arguments: dict[str, Any] = {spec.limit_arg: page_size, **spec.extra_args}
            if source is SourcePlatform.GMAIL:
                arguments["include_payload"] = True
                if since is not None:
                    arguments["query"] = f"after:{ensure_aware(since).strftime('%Y/%m/%d')}"
            if cursor:
                arguments[spec.cursor_arg] = cursor
            data = await self._composio_execute(spec.action_slug, arguments)
            items = extract_items(spec, data)
            for raw in items:
                if source is SourcePlatform.NOTION:
                    # Filter by page metadata before paying a second read for its block body.
                    preliminary = to_episode(
                        spec,
                        raw,
                        lab_id,
                        since=since,
                        resolver=self._resolver,
                        owner_user_id=self._owner_user_id,
                    )
                    if preliminary is None:
                        continue
                    block_data = await self._composio_execute(
                        NOTION_BLOCKS_SLUG, {"block_id": preliminary.source_id}
                    )
                    raw = {**raw, "_claymore_content": notion_block_text(block_data)}
                episode = to_episode(
                    spec,
                    raw,
                    lab_id,
                    since=since,
                    resolver=self._resolver,
                    owner_user_id=self._owner_user_id,
                )
                if episode is not None:
                    yield episode

            cursor = extract_cursor(spec, data)
            # Stop on: no next cursor, an empty page, or a cursor that fails to advance.
            if not cursor or not items or cursor in seen_cursors:
                return
            seen_cursors.add(cursor)
        logger.warning("composio.max_pages_reached", platform=source, max_pages=_MAX_PAGES)

    async def _composio_execute(self, slug: str, arguments: dict[str, Any]) -> Mapping[str, Any]:
        """Execute one pinned read call with bounded transient retries.

        Failed provider envelopes are permanent and surface to the sync job. Transport/rate-limit
        failures retry three times without ever logging provider payloads or credentials.
        """
        for attempt in range(3):
            try:
                response = await asyncio.to_thread(
                    self._client().tools.execute,
                    slug,
                    arguments=arguments,
                    user_id=self._user_id,
                    connected_account_id=self._connected_account_id,
                    version=self._version_for(slug),
                )
                return _response_data(response)
            except Exception as exc:
                if attempt == 2 or not _is_transient(exc):
                    logger.warning(
                        "composio.execute_failed",
                        slug=slug,
                        error_type=type(exc).__name__,
                    )
                    raise ComposioExecutionError(f"Composio read failed for {slug}") from exc
                await asyncio.sleep(0.5 * (2**attempt))
        raise AssertionError("unreachable")

    async def _github_backfill(
        self, lab_id: LabId, since: datetime | None
    ) -> AsyncIterator[Episode]:
        """2-level GitHub backfill: enumerate the account's repos, then stream each repo's commits.

        Streams throughout (never accumulates a repo's — let alone the account's — full commit
        history), with ``_MAX_PAGES`` as a defensive pagination bound. Private-repo commits get the
        Claymore owner injected into their allowlist so the owner can retrieve their own work.
        """
        page_size = (
            get_spec(SourcePlatform.GITHUB).default_page_size
            if self._page_size is None
            else self._page_size
        )
        async for full_name, private in self._github_iter_repos(page_size):
            async for raw_commit in self._github_iter_commits(full_name, page_size, since):
                episode = github_episode(
                    raw_commit,
                    full_name,
                    private,
                    lab_id,
                    since=since,
                    owner_user_id=self._owner_user_id,
                    resolver=self._resolver,
                )
                if episode is not None:
                    yield episode

    async def _github_iter_repos(self, page_size: int) -> AsyncIterator[tuple[str, bool]]:
        """Yield ``(full_name, private)`` across the paged repo list (page-number pagination)."""
        for page in range(1, _MAX_PAGES + 1):
            data = await self._composio_execute(
                GITHUB_REPOS_SLUG, {"per_page": page_size, "page": page}
            )
            repos = github_repos(data)
            if not repos:  # empty page ⇒ last page (GitHub has no next_cursor)
                return
            for repo_entry in repos:
                yield repo_entry
        logger.warning("composio.max_pages_reached", platform="github_repos", max_pages=_MAX_PAGES)

    async def _github_iter_commits(
        self, full_name: str, page_size: int, since: datetime | None
    ) -> AsyncIterator[Mapping[str, Any]]:
        """Yield raw commit dicts for one repo (page-number pagination; failure skips the repo)."""
        owner, _, repo = full_name.partition("/")
        if not owner or not repo:
            logger.warning("composio.github_bad_full_name", full_name=full_name)
            return
        for page in range(1, _MAX_PAGES + 1):
            arguments: dict[str, Any] = {
                "owner": owner,
                "repo": repo,
                "per_page": page_size,
                "page": page,
            }
            if since is not None:
                arguments["since"] = ensure_aware(since).isoformat().replace("+00:00", "Z")
            data = await self._composio_execute(
                GITHUB_COMMITS_SLUG,
                arguments,
            )
            commits = github_commits(data)
            if not commits:  # empty page ⇒ last page
                return
            for commit in commits:
                yield commit
        logger.warning(
            "composio.max_pages_reached",
            platform="github_commits",
            repo=full_name,
            max_pages=_MAX_PAGES,
        )

    async def _slack_backfill(
        self, lab_id: LabId, since: datetime | None
    ) -> AsyncIterator[Episode]:
        """2-level Slack backfill: enumerate channels, then stream each channel's history.

        A message payload carries no channel ACL and the history call *requires* a ``channel``, so
        we enumerate channels first (each with its privacy) and inject that context onto every
        message before parsing — the shared ``to_episode`` path then derives visibility (R13).
        Streams throughout (never accumulates a channel's — let alone the workspace's — full
        history). ``_MAX_PAGES`` is the defensive pagination bound per channel. The Claymore owner
        is injected into a restricted (private / DM) channel's allowlist so they can retrieve their
        own conversations, while public channels remain lab-wide.
        """
        spec = get_spec(SourcePlatform.SLACK)
        page_size = spec.default_page_size if self._page_size is None else self._page_size
        async for channel_ctx in self._slack_iter_channels(page_size):
            async for raw_msg in self._slack_iter_history(channel_ctx["channel"], page_size, since):
                # Overlay the enumerated channel's context, stripping any channel/ACL keys the
                # untrusted message carries so it cannot influence its own scope (R13). This is the
                # sole authority on visibility; a message can't assert itself lab-wide.
                enriched: Any = (
                    slack_enrich_message(raw_msg, channel_ctx)
                    if isinstance(raw_msg, Mapping)
                    else raw_msg
                )
                episode = to_episode(
                    spec,
                    enriched,
                    lab_id,
                    since=since,
                    resolver=self._resolver,
                    owner_user_id=self._owner_user_id,
                )
                if episode is not None:
                    yield episode
                reply_count = raw_msg.get("reply_count")
                thread_ts = _first_str(raw_msg, "thread_ts", "ts")
                if (
                    isinstance(reply_count, int)
                    and not isinstance(reply_count, bool)
                    and reply_count > 0
                    and thread_ts
                ):
                    async for reply in self._slack_iter_thread(
                        channel_ctx["channel"], thread_ts, page_size
                    ):
                        enriched_reply = slack_enrich_message(reply, channel_ctx)
                        reply_episode = to_episode(
                            spec,
                            enriched_reply,
                            lab_id,
                            since=since,
                            resolver=self._resolver,
                            owner_user_id=self._owner_user_id,
                        )
                        if reply_episode is not None:
                            yield reply_episode

    async def _slack_iter_channels(self, page_size: int) -> AsyncIterator[dict[str, Any]]:
        """Yield per-channel contexts across the paged channel list (cursor pagination).

        ``exclude_archived`` trims dead channels from the pilot backfill. Stops on an empty cursor
        or a non-advancing one; a failed enumeration call stops (nothing to page from).
        """
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for _ in range(_MAX_PAGES):
            # `types` is REQUIRED for completeness: conversations.list defaults to public channels
            # only, so without it private channels / DMs / group DMs are never enumerated (R13 path
            # would be dead in prod). exclude_archived trims dead channels from the pilot backfill.
            arguments: dict[str, Any] = {
                "limit": page_size,
                "exclude_archived": True,
                "types": SLACK_CHANNEL_TYPES,
            }
            if cursor:
                arguments["cursor"] = cursor
            data = await self._composio_execute(SLACK_CHANNELS_SLUG, arguments)
            for channel in slack_channels(data):
                yield channel
            cursor = slack_next_cursor(data)
            if not cursor or cursor in seen_cursors:  # empty/non-advancing cursor ⇒ last page
                return
            seen_cursors.add(cursor)
        logger.warning(
            "composio.max_pages_reached", platform="slack_channels", max_pages=_MAX_PAGES
        )

    async def _slack_iter_history(
        self, channel_id: str, page_size: int, since: datetime | None
    ) -> AsyncIterator[Mapping[str, Any]]:
        """Yield raw message dicts for one channel (cursor pagination; a failed fetch skips it).

        A channel the connected account can't read (``not_in_channel``) surfaces as a failed call
        (``None``) or an empty page — either way this channel is skipped, never crashing the run.
        """
        spec = get_spec(SourcePlatform.SLACK)
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for _ in range(_MAX_PAGES):
            arguments: dict[str, Any] = {"channel": channel_id, "limit": page_size}
            if since is not None:
                arguments["oldest"] = int(ensure_aware(since).timestamp())
                arguments["inclusive"] = True
            if cursor:
                arguments["cursor"] = cursor
            data = await self._composio_execute(SLACK_HISTORY_SLUG, arguments)
            messages = extract_items(spec, data)
            if not messages:  # empty page ⇒ last page
                return
            for message in messages:
                yield message
            cursor = slack_next_cursor(data)
            if not cursor or cursor in seen_cursors:
                return
            seen_cursors.add(cursor)
        logger.warning(
            "composio.max_pages_reached",
            platform="slack_history",
            channel=channel_id,
            max_pages=_MAX_PAGES,
        )

    async def _slack_iter_thread(
        self, channel_id: str, thread_ts: str, page_size: int
    ) -> AsyncIterator[Mapping[str, Any]]:
        """Yield replies for one parent message, excluding the parent returned on page one."""
        spec = get_spec(SourcePlatform.SLACK)
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for _ in range(_MAX_PAGES):
            arguments: dict[str, Any] = {
                "channel": channel_id,
                "ts": thread_ts,
                "limit": page_size,
            }
            if cursor:
                arguments["cursor"] = cursor
            data = await self._composio_execute(SLACK_THREAD_SLUG, arguments)
            messages = extract_items(spec, data)
            for message in messages:
                if _first_str(message, "ts") != thread_ts:
                    yield message
            cursor = slack_next_cursor(data)
            if not cursor or cursor in seen_cursors:
                return
            seen_cursors.add(cursor)
        logger.warning(
            "composio.max_pages_reached",
            platform="slack_thread",
            channel=channel_id,
            max_pages=_MAX_PAGES,
        )


class FakeConnectorHub(_StreamingHub):
    """In-memory ``ConnectorHub`` over representative raw payloads — the test/dev double.

    Constructed with ``{SourcePlatform: [raw item dict, ...]}``, it runs items through the SAME
    parsers as the live adapter (:func:`to_episode`), so it proves parsing/scoping/identity/
    dedup without a ``COMPOSIO_API_KEY``. It paginates the fixture in ``page_size`` chunks and
    yields incrementally; ``parsed`` counts items actually processed, which lets a test assert
    the generator streams (does not materialize the whole source) when a consumer breaks early.
    """

    def __init__(
        self,
        raw_items: Mapping[SourcePlatform, list[Any]],
        *,
        resolver: IdentityResolver | None = None,
        page_size: int = 2,
        user_id: str | None = None,
    ) -> None:
        super().__init__()
        self._raw: dict[SourcePlatform, list[Any]] = dict(raw_items)
        self._resolver = resolver
        self._page_size = max(1, page_size)
        # The connecting lab user, mirroring the live hub — used for GitHub private-repo owner
        # injection so the fake exercises the SAME visibility path as the live adapter.
        self._user_id = user_id
        self.parsed = 0

    async def backfill(
        self, lab_id: LabId, source: SourcePlatform, since: datetime | None = None
    ) -> AsyncIterator[Episode]:
        if source is SourcePlatform.GITHUB:
            async for github_ep in self._github_backfill(lab_id, since):
                yield github_ep
            return

        spec: SourceSpec = get_spec(source)
        items = self._raw.get(source, [])
        # Page the fixture to simulate the live cursor loop; yield within each page so a huge
        # source is streamed, not accumulated (R6).
        for start in range(0, len(items), self._page_size):
            page = items[start : start + self._page_size]
            for raw in page:
                self.parsed += 1
                # Fixtures are self-contained (Slack messages carry their own channel fields), so
                # they flow through the SAME generic path as the live Gmail/Notion loop — including
                # owner injection when a user_id is set (private-channel/DM owner visibility, R13).
                episode = to_episode(
                    spec,
                    raw,
                    lab_id,
                    since=since,
                    resolver=self._resolver,
                    owner_user_id=self._user_id,
                )
                if episode is not None:
                    yield episode

    async def _github_backfill(
        self, lab_id: LabId, since: datetime | None
    ) -> AsyncIterator[Episode]:
        """GitHub fake path: fixtures are already-associated commit dicts, each carrying its own
        ``full_name``/``private`` (no repo-enumeration round-trip). Each runs through the SAME
        :func:`github_episode` (parse + since + owner-injection + identity) the live path uses, so
        tests cover the real parse/visibility/owner-injection without a live call. Pages the
        fixture so a huge source is streamed, not accumulated (R6)."""
        items = self._raw.get(SourcePlatform.GITHUB, [])
        for start in range(0, len(items), self._page_size):
            page = items[start : start + self._page_size]
            for raw in page:
                self.parsed += 1
                full_name = _first_str(raw, "full_name") if isinstance(raw, Mapping) else ""
                private = _github_private_flag(raw) if isinstance(raw, Mapping) else True
                episode = github_episode(
                    raw,
                    full_name,
                    private,
                    lab_id,
                    since=since,
                    owner_user_id=self._user_id,
                    resolver=self._resolver,
                )
                if episode is not None:
                    yield episode

"""[Pipes] Per-source config + defensive raw→``Episode`` parsers for Composio ingest.

One :class:`SourceSpec` per :class:`~claymore.domain.SourcePlatform` bundles everything the
hub needs to page a source and normalize its items: the Composio action **slug**, the request
pagination arg names, where the item list + next-page cursor live in the response envelope, and
a **parser** that maps one raw item dict → :class:`~claymore.ingest.normalize.Episode`.

Everything here is deliberately defensive because the payloads are *untrusted* (SECURITY.md
rule 1 / CLAUDE.md §2.7) and their exact shapes must be **calibrated against a live Composio
call** — the field names below are best-effort guesses (see module-level ``# CALIBRATE`` notes).
So a parser never trusts a field to exist or to be the right type:

- **author is never guessed** (hard rule 1). The parser sets ``author=UNKNOWN_AUTHOR`` and
  stashes the platform-native handle in ``extra[RAW_AUTHOR_KEY]`` for the identity step to
  resolve later; if no resolver runs, the episode is honestly ``unknown``.
- **timestamp missing/unparseable → skip the item** (return ``None``) rather than invent a time
  that would corrupt bi-temporal ordering.
- **text is always a ``str``**; a malformed/absent body degrades to ``""``.
- **ACL → Visibility fails closed** (R13): a clearly-public channel / lab-shared doc is
  ``lab_wide``; a private channel/DM is restricted to its participants; **anything ambiguous is
  restricted with an empty allowlist** and logged — never opened up on a guess.
- ``is_untrusted`` is always ``True``.

Both hub implementations (:mod:`claymore.ingest.composio.hub`) run items through the SAME
parsers here via :func:`to_episode`, so the fake and the live adapter share one code path.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog

from claymore.domain import UNKNOWN_AUTHOR, LabId, SourcePlatform, Visibility
from claymore.ingest.normalize import Episode
from claymore.memory.graph import ensure_aware
from claymore.memory.identity import RAW_AUTHOR_KEY, IdentityResolver, normalize_handle

logger = structlog.get_logger(__name__)


# --------------------------------------------------------------------------------------------
# Small, type-safe accessors over untrusted dicts. Each degrades to a benign default instead of
# raising, so one bad field never takes down an item (let alone a whole backfill page).
# --------------------------------------------------------------------------------------------


def _as_str(value: Any) -> str:
    """The value if it is a non-empty string, else ``""`` (never raises)."""
    return value if isinstance(value, str) else ""


def _first_str(raw: Mapping[str, Any], *keys: str) -> str:
    """First present non-empty **string** value among ``keys`` (in priority order)."""
    for key in keys:
        got = _as_str(raw.get(key))
        if got:
            return got
    return ""


def _first_ident(raw: Mapping[str, Any], *keys: str) -> str:
    """Like :func:`_first_str` but also accepts an ``int`` id, stringified (e.g. GitHub ids)."""
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
    return ""


def _dig(raw: Any, path: Sequence[str]) -> Any:
    """Walk a nested-dict ``path``; return ``None`` the moment a level is missing/not a dict."""
    cur: Any = raw
    for key in path:
        if not isinstance(cur, Mapping):
            return None
        cur = cur.get(key)
    return cur


def _str_list(value: Any) -> list[str]:
    """Coerce a comma-string OR a list-of-strings into a de-duped, trimmed ``list[str]``."""
    out: list[str] = []
    if isinstance(value, str):
        out = [part.strip() for part in value.split(",")]
    elif isinstance(value, list):
        out = [item.strip() for item in value if isinstance(item, str)]
    seen: set[str] = set()
    result: list[str] = []
    for item in out:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _participants(raw: Mapping[str, Any], keys: Sequence[str]) -> frozenset[str]:
    """Union of participant identifiers across ``keys``, normalized for a consistent allowlist.

    Each token is run through :func:`normalize_handle` (the SAME normalization identity
    resolution uses) so ``"Name <a@b>"`` → ``a@b`` and ``@handle`` → ``handle`` — the allowlist
    lives in one identifier space, and a later participant→person resolution keys identically.
    """
    people: list[str] = []
    for key in keys:
        for token in _str_list(raw.get(key)):
            handle = normalize_handle(token)
            if handle:
                people.append(handle)
    return frozenset(people)


def _refs(raw: Mapping[str, Any], keys: Sequence[str]) -> tuple[str, ...]:
    """Referenced ids/urls (threads, permalinks) as a flat tuple of strings."""
    refs: list[str] = []
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value:
            refs.append(value)
        elif isinstance(value, list):
            refs.extend(item for item in value if isinstance(item, str) and item)
    return tuple(refs)


def _content_hash(*parts: str) -> str:
    """Stable content hash for dedup (R6). NUL-delimited so parts can't collide by juxtaposition."""
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()


def _from_epoch(value: float) -> datetime | None:
    """Epoch → aware UTC. Values ``> 1e12`` are treated as milliseconds (Gmail internalDate)."""
    if value > 1e12:
        value /= 1000.0
    try:
        return datetime.fromtimestamp(value, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def parse_timestamp(value: Any) -> datetime | None:
    """Parse a source timestamp into an aware UTC ``datetime``, or ``None`` if unusable.

    Handles ISO-8601 (``...Z`` or offset), epoch seconds (Slack ``ts`` float-strings), and epoch
    milliseconds. Returns ``None`` — signalling *skip this item* — for anything unparseable
    rather than inventing a time that would corrupt bi-temporal ordering (R12).
    """
    if isinstance(value, bool):  # bool is an int subclass; never a timestamp
        return None
    if isinstance(value, int | float):
        return _from_epoch(float(value))
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:  # Slack ts / bare epoch strings
            return _from_epoch(float(text))
        except ValueError:
            pass
        try:
            return ensure_aware(datetime.fromisoformat(text.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def _fail_closed(label: str, *, platform: str, reason: str) -> Visibility:
    """Restricted, empty-allowlist visibility for unknown/ambiguous ACLs (R13, fail-closed)."""
    logger.warning("composio.acl_fail_closed", platform=platform, reason=reason, label=label)
    return Visibility(lab_wide=False, source_label=label)


# --------------------------------------------------------------------------------------------
# Per-source parsers. Each returns an Episode with author=UNKNOWN + raw handle in extra, or
# ``None`` to skip. author resolution happens later (identity.py), never here (hard rule 1).
# --------------------------------------------------------------------------------------------


def _base_extra(raw_author: str, **more: str) -> dict[str, str]:
    extra: dict[str, str] = {}
    if raw_author:
        extra[RAW_AUTHOR_KEY] = raw_author
    extra.update({k: v for k, v in more.items() if v})
    return extra


def _slack_visibility(raw: Mapping[str, Any]) -> Visibility:
    """Slack ACL → Visibility. Public channel → lab-wide; private/DM → participants; else closed.

    # CALIBRATE: real field names for channel type / privacy / member list vary by the exact
    # SLACK_* action and whether Composio enriches the message with channel metadata.
    """
    name = _first_str(raw, "channel_name", "channel", "channel_id")
    label = f"#{name}" if name and not name.startswith(("C", "D", "G")) else (name or "slack")
    channel_type = _first_str(raw, "channel_type", "conversation_type").lower()
    is_private = raw.get("is_private")

    if channel_type in {"im", "mpim"} or (channel_type == "" and str(raw.get("is_im")) == "True"):
        members = _participants(raw, ("members", "participants", "users"))
        return Visibility(lab_wide=False, allowed_user_ids=members, source_label="DM")
    if is_private is True or channel_type in {"private_channel", "group"}:
        members = _participants(raw, ("members", "participants", "users"))
        priv_label = f"{label} (private)" if name else "private channel"
        return Visibility(lab_wide=False, allowed_user_ids=members, source_label=priv_label)
    if is_private is False or channel_type in {"channel", "public_channel"}:
        return Visibility(lab_wide=True, source_label=label)
    return _fail_closed(label, platform="slack", reason="no channel_type/is_private")


def parse_slack(raw: Mapping[str, Any], lab_id: LabId) -> Episode | None:
    ts_raw = _first_str(raw, "ts", "timestamp", "event_ts")
    timestamp = parse_timestamp(raw.get("ts") or raw.get("timestamp") or raw.get("event_ts"))
    if timestamp is None:
        return None
    channel = _first_str(raw, "channel", "channel_id")
    source_id = f"{channel}:{ts_raw}" if channel and ts_raw else ts_raw
    if not source_id:
        return None
    text = _first_str(raw, "text", "message", "body")
    raw_author = _first_str(raw, "username", "user_name", "user", "user_id")
    return Episode(
        lab_id=lab_id,
        source_platform=SourcePlatform.SLACK,
        source_id=source_id,
        author=UNKNOWN_AUTHOR,
        timestamp=timestamp,
        text=text,
        refs=_refs(raw, ("thread_ts", "permalink", "files")),
        visibility=_slack_visibility(raw),
        is_untrusted=True,
        source_hash=_content_hash("slack", source_id, text),
        extra=_base_extra(raw_author),
    )


def parse_gmail(raw: Mapping[str, Any], lab_id: LabId) -> Episode | None:
    """Gmail → Episode. Email is inherently need-to-know: restricted to its participants (R13).

    # CALIBRATE: GMAIL_FETCH_EMAILS field names — messageId / messageTimestamp / messageText /
    # sender vs id / internalDate / snippet / from — confirm against a live call.
    """
    source_id = _first_str(raw, "messageId", "message_id", "id")
    if not source_id:
        return None
    timestamp = parse_timestamp(
        raw.get("messageTimestamp") or raw.get("internalDate") or raw.get("date")
    )
    if timestamp is None:
        return None
    subject = _first_str(raw, "subject")
    text = _first_str(raw, "messageText", "body", "snippet", "preview", "text")
    raw_author = _first_str(raw, "sender", "from")
    participants = _participants(raw, ("sender", "from", "to", "cc"))
    return Episode(
        lab_id=lab_id,
        source_platform=SourcePlatform.GMAIL,
        source_id=source_id,
        author=UNKNOWN_AUTHOR,
        timestamp=timestamp,
        text=text,
        refs=_refs(raw, ("threadId", "thread_id")),
        # An email is never lab-wide: only its participants (fail-closed to empty if none found).
        visibility=Visibility(lab_wide=False, allowed_user_ids=participants, source_label="email"),
        is_untrusted=True,
        source_hash=_content_hash("gmail", source_id, subject, text),
        extra=_base_extra(raw_author, subject=subject),
    )


def _github_visibility(raw: Mapping[str, Any], label: str) -> Visibility:
    """GitHub repo ACL → Visibility. Public repo → lab-wide; private/unknown → fail closed.

    A private repo's collaborator set isn't on the item, so we fail closed (restricted, empty
    allowlist) rather than assume the whole lab can see it (R13).
    """
    private = raw.get("private")
    if private is None:
        private = _dig(raw, ("repository", "private"))
    vis = (
        _first_str(raw, "visibility") or _as_str(_dig(raw, ("repository", "visibility")))
    ).lower()
    if private is False or vis == "public":
        return Visibility(lab_wide=True, source_label=label)
    if private is True or vis in {"private", "internal"}:
        return _fail_closed(label, platform="github", reason="private repo, no collaborator list")
    return _fail_closed(label, platform="github", reason="repo visibility unknown")


def parse_github(raw: Mapping[str, Any], lab_id: LabId) -> Episode | None:
    """GitHub issue/PR/commit → Episode (defensive across those shapes).

    # CALIBRATE: exact GITHUB_* slug + shape (issue vs commit) — nested ``commit.author`` and
    # ``user.login`` paths below are guesses; confirm the response envelope live.
    """
    source_id = _first_ident(raw, "sha", "id", "node_id", "number") or _first_str(raw, "html_url")
    if not source_id:
        return None
    timestamp = parse_timestamp(
        raw.get("created_at") or _dig(raw, ("commit", "author", "date")) or raw.get("updated_at")
    )
    if timestamp is None:
        return None
    title = _first_str(raw, "title")
    body = _first_str(raw, "body", "message") or _as_str(_dig(raw, ("commit", "message")))
    text = f"{title}\n\n{body}".strip() if title else body
    raw_author = (
        _as_str(_dig(raw, ("user", "login")))
        or _as_str(_dig(raw, ("author", "login")))
        or _as_str(_dig(raw, ("commit", "author", "name")))
        or _first_str(raw, "login")
    )
    repo = _first_str(raw, "repository", "repo") or _as_str(_dig(raw, ("repository", "full_name")))
    return Episode(
        lab_id=lab_id,
        source_platform=SourcePlatform.GITHUB,
        source_id=source_id,
        author=UNKNOWN_AUTHOR,
        timestamp=timestamp,
        text=text,
        refs=_refs(raw, ("html_url", "url", "repository")),
        visibility=_github_visibility(raw, repo or "github"),
        is_untrusted=True,
        source_hash=_content_hash("github", source_id, text),
        extra=_base_extra(raw_author, repo=repo),
    )


def parse_notion(raw: Mapping[str, Any], lab_id: LabId) -> Episode | None:
    """Notion page → Episode.

    # CALIBRATE: Notion's real payload nests title/content under ``properties`` (rich-text
    # arrays); the flat ``title``/``text`` keys used here are a placeholder for a live-calibrated
    # extractor. Notion authors need a Notion-handle seed in the roster to resolve; until then
    # they honestly stay ``unknown`` (hard rule 1).
    """
    source_id = _first_str(raw, "id", "page_id")
    if not source_id:
        return None
    timestamp = parse_timestamp(
        raw.get("last_edited_time") or raw.get("created_time") or raw.get("last_edited")
    )
    if timestamp is None:
        return None
    title = _first_str(raw, "title")
    text = _first_str(raw, "text", "content", "plain_text") or title
    raw_author = (
        _as_str(_dig(raw, ("created_by", "person", "email")))
        or _as_str(_dig(raw, ("last_edited_by", "person", "email")))
        or _as_str(_dig(raw, ("created_by", "id")))
    )
    label = title or "notion"
    shared = raw.get("shared")
    public = raw.get("public")
    workspace = _first_str(raw, "visibility").lower() == "workspace"
    if shared is True or public is True or workspace:
        visibility = Visibility(lab_wide=True, source_label=label)
    elif shared is False or public is False:
        visibility = _fail_closed(label, platform="notion", reason="page not shared")
    else:
        visibility = _fail_closed(label, platform="notion", reason="sharing state unknown")
    return Episode(
        lab_id=lab_id,
        source_platform=SourcePlatform.NOTION,
        source_id=source_id,
        author=UNKNOWN_AUTHOR,
        timestamp=timestamp,
        text=text,
        refs=_refs(raw, ("url", "parent")),
        visibility=visibility,
        is_untrusted=True,
        source_hash=_content_hash("notion", source_id, title, text),
        extra=_base_extra(raw_author, title=title),
    )


# --------------------------------------------------------------------------------------------
# SourceSpec: everything the hub needs to page + parse a source. Slugs / envelope paths are
# CONFIGURABLE here (not buried in logic) precisely because they must be calibrated live.
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceSpec:
    """Per-source ingest config: action slug, pagination args, envelope paths, and a parser."""

    platform: SourcePlatform
    action_slug: str
    """Composio tool slug (per-toolkit). Configurable — exact slug calibrated live."""

    parser: Callable[[Mapping[str, Any], LabId], Episode | None]
    """Raw item dict → Episode (or ``None`` to skip). Defensive; never raises for bad fields."""

    items_path: tuple[str, ...]
    """Nested path in ``response.data`` to the list of raw items."""

    cursor_path: tuple[str, ...]
    """Nested path in ``response.data`` to the next-page cursor (absent/empty ⇒ last page)."""

    cursor_arg: str
    """Request-argument name that carries the incoming cursor back to the API."""

    limit_arg: str
    """Request-argument name for the page size."""

    default_page_size: int = 50
    """Conservative page size — backfill blows past Composio's free 1k executions (R6/§5)."""


# CALIBRATE: every slug + items_path + cursor_path below is a best-effort guess pending a live
# Composio call. They are isolated here so calibration is a one-line edit, not a logic change.
SOURCE_SPECS: dict[SourcePlatform, SourceSpec] = {
    SourcePlatform.SLACK: SourceSpec(
        platform=SourcePlatform.SLACK,
        action_slug="SLACK_FETCH_CONVERSATION_HISTORY",
        parser=parse_slack,
        items_path=("messages",),
        cursor_path=("response_metadata", "next_cursor"),
        cursor_arg="cursor",
        limit_arg="limit",
    ),
    SourcePlatform.GMAIL: SourceSpec(
        platform=SourcePlatform.GMAIL,
        action_slug="GMAIL_FETCH_EMAILS",
        parser=parse_gmail,
        items_path=("messages",),
        cursor_path=("nextPageToken",),
        cursor_arg="page_token",
        limit_arg="max_results",
    ),
    SourcePlatform.GITHUB: SourceSpec(
        platform=SourcePlatform.GITHUB,
        action_slug="GITHUB_LIST_REPOSITORY_ISSUES",
        parser=parse_github,
        items_path=("issues",),
        cursor_path=("next_cursor",),
        cursor_arg="page",
        limit_arg="per_page",
    ),
    SourcePlatform.NOTION: SourceSpec(
        platform=SourcePlatform.NOTION,
        action_slug="NOTION_FETCH_DATA",
        parser=parse_notion,
        items_path=("results",),
        cursor_path=("next_cursor",),
        cursor_arg="start_cursor",
        limit_arg="page_size",
    ),
}


def get_spec(source: SourcePlatform) -> SourceSpec:
    """The :class:`SourceSpec` for a supported source, or ``ValueError`` for one we don't ingest."""
    try:
        return SOURCE_SPECS[source]
    except KeyError:
        raise ValueError(f"no Composio SourceSpec for {source!r}") from None


# --------------------------------------------------------------------------------------------
# Response-envelope extraction (used by the live hub; unit-tested directly).
# --------------------------------------------------------------------------------------------


def extract_items(spec: SourceSpec, data: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Pull the list of raw item dicts out of a response envelope (defensive: [] if malformed)."""
    found = _dig(data, spec.items_path)
    if not isinstance(found, list):
        return []
    return [item for item in found if isinstance(item, Mapping)]


def extract_cursor(spec: SourceSpec, data: Mapping[str, Any]) -> str | None:
    """Pull the next-page cursor, or ``None`` if absent/empty (⇒ stop paging)."""
    cursor = _dig(data, spec.cursor_path)
    return cursor if isinstance(cursor, str) and cursor else None


# --------------------------------------------------------------------------------------------
# The single parse+scope+resolve+filter path shared by BOTH hubs (DRY): defensive, never raises.
# --------------------------------------------------------------------------------------------


def to_episode(
    spec: SourceSpec,
    raw: Any,
    lab_id: LabId,
    *,
    since: datetime | None = None,
    resolver: IdentityResolver | None = None,
) -> Episode | None:
    """Parse one raw item → Episode, apply ``since`` + identity resolution; ``None`` to skip.

    A malformed item (parser returns ``None`` or *raises* on an unexpected shape) is logged and
    skipped — one bad item must never abort a backfill (§2, R6). ``since`` is an inclusive lower
    bound on source time. If ``resolver`` is set, the author is resolved inline (else the raw
    handle stays in ``extra`` for a later identity pass).
    """
    try:
        episode = spec.parser(raw, lab_id)
    except Exception as exc:  # untrusted, arbitrarily-shaped input: degrade, don't crash
        logger.warning("composio.parse_error", platform=spec.platform, error=str(exc))
        return None
    if episode is None:
        logger.info("composio.item_skipped", platform=spec.platform)
        return None
    if since is not None and ensure_aware(episode.timestamp) < ensure_aware(since):
        return None
    if resolver is not None:
        episode = resolver.resolve_episode(episode)
    return episode

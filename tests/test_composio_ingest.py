"""Composio ingest slice — parsing, provenance, scoping, identity, pagination, ``since``.

All exercised through :class:`FakeConnectorHub` over representative Slack/Gmail/GitHub/Notion
payloads, so the parser + ACL→visibility + identity logic is proven with no ``COMPOSIO_API_KEY``
and no live call. The fake shares :func:`to_episode` with the live adapter, so green here means
the same normalization path is green for the real hub (only the raw response envelope differs,
which is unit-tested in ``test_envelope_*``).
"""

from __future__ import annotations

from datetime import UTC, datetime

from claymore.domain import UNKNOWN_AUTHOR, SourcePlatform
from claymore.ingest.composio.hub import FakeConnectorHub
from claymore.ingest.composio.sources import (
    extract_cursor,
    extract_items,
    get_spec,
    to_episode,
)
from claymore.memory.identity import RAW_AUTHOR_KEY, IdentityResolver
from tests.fixtures import LAB, ROSTER

# Two public-channel Slack messages ~100s apart, plus a private DM.
SLACK_PUBLIC = [
    {
        "ts": "1709467200.000100",
        "user": "@lucas",
        "text": "Lucas suggested testing the Y hypothesis on the X protein.",
        "channel": "C1",
        "channel_name": "protein-eng",
        "channel_type": "channel",
        "is_private": False,
        "thread_ts": "1709467200.000000",
    },
    {
        "ts": "1709467300.000200",
        "username": "philip",
        "text": "Agreed, let's run it Tuesday.",
        "channel": "C1",
        "channel_name": "protein-eng",
        "channel_type": "channel",
        "is_private": False,
    },
]
SLACK_DM = [
    {
        "ts": "1709470000.000100",
        "user": "@lucas",
        "text": "quiet idea before the roundup",
        "channel": "D1",
        "channel_type": "im",
        "is_private": True,
        "members": ["@lucas", "@philip"],
    }
]
GMAIL_ITEMS = [
    {
        "messageId": "g1",
        "threadId": "t1",
        "sender": "Lucas <lucas@lab.org>",
        "to": "philip@lab.org",
        "subject": "Assay buffer",
        "messageText": "Use 50mM Tris.",
        "messageTimestamp": "2026-03-03T12:00:00Z",
    }
]
GITHUB_ITEMS = [
    {
        "id": 42,
        "number": 7,
        "title": "Docking pipeline",
        "body": "latest run green",
        "user": {"login": "lucas-dev"},
        "created_at": "2026-03-03T12:00:00Z",
        "repository": "lab/repo",
        "private": False,
    }
]


def _hub(**kw: object) -> FakeConnectorHub:
    return FakeConnectorHub(
        {
            SourcePlatform.SLACK: list(SLACK_PUBLIC),
            SourcePlatform.GMAIL: list(GMAIL_ITEMS),
            SourcePlatform.GITHUB: list(GITHUB_ITEMS),
        },
        **kw,  # type: ignore[arg-type]
    )


async def _collect(hub: FakeConnectorHub, source: SourcePlatform, **kw: object) -> list:  # type: ignore[type-arg]
    return [ep async for ep in hub.backfill(LAB, source, **kw)]  # type: ignore[arg-type]


# --- provenance: platform / source_id / timestamp / raw_author ---


async def test_slack_backfill_provenance() -> None:
    episodes = await _collect(_hub(), SourcePlatform.SLACK)
    assert len(episodes) == 2
    first = episodes[0]
    assert first.lab_id == LAB
    assert first.source_platform is SourcePlatform.SLACK
    assert first.source_id == "C1:1709467200.000100"  # channel + ts, stable
    assert first.timestamp == datetime.fromtimestamp(1709467200.0001, tz=UTC)
    assert first.text.startswith("Lucas suggested")
    # Author is NOT guessed at parse time — raw handle stashed for the identity step.
    assert first.author == UNKNOWN_AUTHOR
    assert first.extra[RAW_AUTHOR_KEY] == "@lucas"
    assert first.is_untrusted is True
    assert "1709467200.000000" in first.refs  # thread_ts carried as a ref
    # Second message uses a different author field key.
    assert episodes[1].extra[RAW_AUTHOR_KEY] == "philip"


async def test_gmail_backfill_provenance_and_participants() -> None:
    [email] = await _collect(_hub(), SourcePlatform.GMAIL)
    assert email.source_platform is SourcePlatform.GMAIL
    assert email.source_id == "g1"
    assert email.extra[RAW_AUTHOR_KEY] == "Lucas <lucas@lab.org>"
    assert email.extra["subject"] == "Assay buffer"
    assert "t1" in email.refs


async def test_github_backfill_provenance() -> None:
    [issue] = await _collect(_hub(), SourcePlatform.GITHUB)
    assert issue.source_platform is SourcePlatform.GITHUB
    assert issue.source_id == "42"  # int id stringified
    assert issue.extra[RAW_AUTHOR_KEY] == "lucas-dev"
    assert "Docking pipeline" in issue.text


# --- ACL → visibility (R13) ---


async def test_public_channel_is_lab_wide() -> None:
    [first, _] = await _collect(_hub(), SourcePlatform.SLACK)
    assert first.visibility.lab_wide is True
    assert first.visibility.source_label == "#protein-eng"


async def test_private_dm_is_restricted_to_participants() -> None:
    hub = FakeConnectorHub({SourcePlatform.SLACK: list(SLACK_DM)})
    [dm] = await _collect(hub, SourcePlatform.SLACK)
    assert dm.visibility.lab_wide is False
    # Participants are stored normalized (leading '@' stripped) — one identifier space.
    assert dm.visibility.allowed_user_ids == frozenset({"lucas", "philip"})
    assert dm.visibility.source_label == "DM"
    # A DM participant may view; an outsider may not.
    assert dm.visibility.can_view("lucas") is True
    assert dm.visibility.can_view("mallory") is False


async def test_email_is_restricted_not_lab_wide() -> None:
    [email] = await _collect(_hub(), SourcePlatform.GMAIL)
    assert email.visibility.lab_wide is False  # email is inherently need-to-know
    assert email.visibility.allowed_user_ids == frozenset({"lucas@lab.org", "philip@lab.org"})


async def test_public_github_repo_is_lab_wide() -> None:
    [issue] = await _collect(_hub(), SourcePlatform.GITHUB)
    assert issue.visibility.lab_wide is True
    assert issue.visibility.source_label == "lab/repo"


# --- identity resolution (R11): raw handle → canonical person when a resolver is provided ---


async def test_resolver_maps_slack_handle_to_person() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    episodes = await _collect(_hub(resolver=resolver), SourcePlatform.SLACK)
    assert episodes[0].author == "p_lucas"
    assert episodes[1].author == "p_philip"


async def test_resolver_maps_gmail_and_github() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    [email] = await _collect(_hub(resolver=resolver), SourcePlatform.GMAIL)
    [issue] = await _collect(_hub(resolver=resolver), SourcePlatform.GITHUB)
    assert email.author == "p_lucas"  # "Lucas <lucas@lab.org>" → gmail handle → p_lucas
    assert issue.author == "p_lucas"  # "lucas-dev" → github login → p_lucas


async def test_without_resolver_author_stays_unknown_but_raw_kept() -> None:
    episodes = await _collect(_hub(), SourcePlatform.SLACK)
    assert all(ep.author == UNKNOWN_AUTHOR for ep in episodes)
    assert all(RAW_AUTHOR_KEY in ep.extra for ep in episodes)


# --- since filtering ---


async def test_since_filters_older_items_inclusive() -> None:
    cutoff = datetime.fromtimestamp(1709467300.0002, tz=UTC)  # the second message's time
    episodes = await _collect(_hub(), SourcePlatform.SLACK, since=cutoff)
    # Older message dropped; the one at exactly `since` is kept (inclusive lower bound).
    assert [ep.source_id for ep in episodes] == ["C1:1709467300.000200"]


# --- pagination: every page is yielded ---


async def test_pagination_yields_all_pages() -> None:
    hub = FakeConnectorHub({SourcePlatform.SLACK: list(SLACK_PUBLIC)}, page_size=1)
    episodes = await _collect(hub, SourcePlatform.SLACK)
    assert len(episodes) == 2  # two single-item pages, both surfaced


# --- incremental: checkpoint advances and resumes ---


async def test_incremental_advances_checkpoint_and_resumes() -> None:
    hub = FakeConnectorHub({SourcePlatform.SLACK: list(SLACK_PUBLIC)})
    first = [ep async for ep in hub.incremental(LAB, SourcePlatform.SLACK)]
    assert len(first) == 2
    cp = hub.checkpoint(LAB, SourcePlatform.SLACK)
    assert cp == datetime.fromtimestamp(1709467300.0002, tz=UTC)  # latest seen
    # A re-poll of the SAME fixture surfaces only items strictly newer than the checkpoint;
    # the boundary item is re-emitted (inclusive) for the Episode log to dedup.
    again = [ep async for ep in hub.incremental(LAB, SourcePlatform.SLACK)]
    assert [ep.source_id for ep in again] == ["C1:1709467300.000200"]


# --- envelope extraction (the part the live hub uses; fake bypasses it) ---


def test_envelope_extract_items_and_cursor_slack() -> None:
    spec = get_spec(SourcePlatform.SLACK)
    data = {
        "messages": [{"ts": "1", "text": "hi"}, "not-a-dict", {"ts": "2"}],
        "response_metadata": {"next_cursor": "CUR2"},
    }
    items = extract_items(spec, data)
    assert len(items) == 2  # the non-dict item is filtered out
    assert extract_cursor(spec, data) == "CUR2"


def test_envelope_extract_cursor_absent_is_none() -> None:
    spec = get_spec(SourcePlatform.SLACK)
    assert extract_cursor(spec, {"messages": []}) is None
    assert extract_items(spec, {"messages": "malformed"}) == []


def test_get_spec_rejects_unsupported_source() -> None:
    import pytest

    with pytest.raises(ValueError, match="no Composio SourceSpec"):
        get_spec(SourcePlatform.GRANOLA)


# --- to_episode is the shared path; a direct sanity check ---


def test_to_episode_skips_when_parser_returns_none() -> None:
    spec = get_spec(SourcePlatform.SLACK)
    assert to_episode(spec, {"text": "no timestamp"}, LAB) is None

"""Notion page-ingest slice — calibrated against the live ``NOTION_FETCH_DATA`` response shape.

Exercises the Page → :class:`Episode` mapping (title from ``properties``, ``created_by`` author,
``last_edited_time`` timestamp), the ``object == "page"`` filter (databases/data_sources are
schema, not memory), ACL → visibility (R13, no per-page ACL ⇒ fail-closed + owner injection),
identity resolution (R11), and ``since`` — all through :class:`FakeConnectorHub`, whose Notion path
runs the SAME :func:`to_episode` the live adapter uses. Green here means green for the real hub's
per-page handling (only the response envelope + ``fetch_type`` injection differ, unit-tested
separately).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from claymore.domain import UNKNOWN_AUTHOR, SourcePlatform
from claymore.ingest.composio.hub import FakeConnectorHub
from claymore.memory.identity import RAW_AUTHOR_KEY, IdentityResolver
from tests.fixtures import LAB, ROSTER, make_user


def _page(
    page_id: str = "pg1",
    *,
    title: str | None = "Assay buffer: 50mM Tris",
    created_by_name: str | None = "Lucas Kim",
    last_edited: str = "2026-03-03T12:00:00Z",
    created_time: str = "2026-01-01T00:00:00Z",
    public_url: str | None = None,
    obj: str = "page",
    url: str = "https://notion.so/pg1",
) -> dict[str, Any]:
    """A Notion Page dict in the live ``NOTION_FETCH_DATA`` ``results[]`` shape.

    Title lives in a ``type == "title"`` property (there is no flat ``title``); ``created_by`` is a
    ``PartialUser`` (id + optional name, NO email).
    """
    properties: dict[str, Any] = {}
    if title is not None:
        properties["Name"] = {
            "id": "title",
            "type": "title",
            "title": [{"type": "text", "plain_text": title}],
        }
    created_by: dict[str, Any] = {"object": "user", "id": "notion-user-1"}
    if created_by_name is not None:
        created_by["name"] = created_by_name
    page: dict[str, Any] = {
        "object": obj,
        "id": page_id,
        "url": url,
        "created_time": created_time,
        "last_edited_time": last_edited,
        "created_by": created_by,
        "last_edited_by": {"object": "user", "id": "notion-user-1"},
        "properties": properties,
    }
    if public_url is not None:
        page["public_url"] = public_url
    return page


async def _collect(hub: FakeConnectorHub, **kw: Any) -> list[Any]:
    return [ep async for ep in hub.backfill(LAB, SourcePlatform.NOTION, **kw)]


# --- provenance: id / timestamp / title-as-text / raw_author ---


async def test_notion_page_maps_all_fields() -> None:
    hub = FakeConnectorHub({SourcePlatform.NOTION: [_page()]})
    [ep] = await _collect(hub)
    assert ep.lab_id == LAB
    assert ep.source_platform is SourcePlatform.NOTION
    assert ep.source_id == "pg1"  # the page UUID
    assert ep.text == "Assay buffer: 50mM Tris"  # title extracted from properties
    assert ep.extra["title"] == "Assay buffer: 50mM Tris"
    # last_edited_time is the episode time (fall back to created_time), parsed to aware UTC.
    assert ep.timestamp == datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
    # Author is NOT guessed at parse time — created_by's name is stashed for the identity step.
    assert ep.author == UNKNOWN_AUTHOR
    assert ep.extra[RAW_AUTHOR_KEY] == "Lucas Kim"
    assert ep.is_untrusted is True
    assert "https://notion.so/pg1" in ep.refs


async def test_title_concatenates_rich_text_runs() -> None:
    page = _page(title=None)
    page["properties"]["Name"] = {
        "id": "title",
        "type": "title",
        "title": [
            {"type": "text", "plain_text": "Docking "},
            {"type": "text", "plain_text": "pipeline "},
            {"type": "mention", "plain_text": "notes"},
        ],
    }
    hub = FakeConnectorHub({SourcePlatform.NOTION: [page]})
    [ep] = await _collect(hub)
    assert ep.text == "Docking pipeline notes"  # every run's plain_text joined in order


async def test_created_by_uuid_used_when_no_name() -> None:
    hub = FakeConnectorHub({SourcePlatform.NOTION: [_page(created_by_name=None)]})
    [ep] = await _collect(hub)
    assert ep.extra[RAW_AUTHOR_KEY] == "notion-user-1"  # UUID fallback (PartialUser has no email)


# --- object filter: only pages become episodes ---


async def test_database_and_data_source_results_are_skipped() -> None:
    hub = FakeConnectorHub(
        {
            SourcePlatform.NOTION: [
                _page("pg1"),
                _page("db1", obj="database"),  # schema, not memory
                _page("ds1", obj="data_source"),  # schema, not memory
            ]
        }
    )
    episodes = await _collect(hub)
    assert [ep.source_id for ep in episodes] == ["pg1"]  # only the page survives


# --- ACL → visibility (R13): no per-page ACL ⇒ fail closed, owner injected ---


async def test_page_fails_closed_without_owner() -> None:
    # No public_url, no owner on the hub → restricted to nobody (fail-closed, not lab-wide).
    hub = FakeConnectorHub({SourcePlatform.NOTION: [_page()]})
    [ep] = await _collect(hub)
    assert ep.visibility.lab_wide is False
    assert ep.visibility.allowed_user_ids == frozenset()


async def test_page_owner_injected_so_owner_can_view() -> None:
    # The connecting lab user (user_id) has workspace access → injected into the page's allowlist.
    hub = FakeConnectorHub({SourcePlatform.NOTION: [_page()]}, user_id="u_lucas")
    [ep] = await _collect(hub)
    assert ep.visibility.lab_wide is False
    assert ep.visibility.allowed_user_ids == frozenset({"u_lucas"})
    assert ep.visibility.can_view("u_lucas") is True
    assert ep.visibility.can_view("u_philip") is False  # a random member still cannot


async def test_published_page_is_lab_wide() -> None:
    # A page with a public_url is published to the web = strictly public = lab-wide memory.
    hub = FakeConnectorHub(
        {SourcePlatform.NOTION: [_page(public_url="https://x.notion.site/pg1")]},
        user_id="u_lucas",
    )
    [ep] = await _collect(hub)
    assert ep.visibility.lab_wide is True
    assert ep.visibility.source_label == "Assay buffer: 50mM Tris"


# --- identity resolution (R11): resolves only with a Notion seed, else honest unknown ---


async def test_notion_author_stays_unknown_without_notion_seed() -> None:
    # The shared roster has no Notion handles → a Notion author is never guessed (hard rule 1).
    resolver = IdentityResolver(LAB, ROSTER)
    hub = FakeConnectorHub({SourcePlatform.NOTION: [_page()]}, resolver=resolver)
    [ep] = await _collect(hub)
    assert ep.author == UNKNOWN_AUTHOR
    assert ep.extra[RAW_AUTHOR_KEY] == "Lucas Kim"  # raw handle kept for a later merge


async def test_notion_author_resolves_with_seed() -> None:
    roster = [
        make_user("u_lucas", person_id="p_lucas", handles={SourcePlatform.NOTION: "Lucas Kim"})
    ]
    resolver = IdentityResolver(LAB, roster)
    hub = FakeConnectorHub({SourcePlatform.NOTION: [_page()]}, resolver=resolver)
    [ep] = await _collect(hub)
    assert ep.author == "p_lucas"  # created_by.name → seeded Notion handle → canonical person


# --- since filtering (inclusive lower bound on last_edited_time) ---


async def test_since_filters_older_pages_inclusive() -> None:
    pages = [
        _page("p1", last_edited="2026-03-01T00:00:00Z"),
        _page("p2", last_edited="2026-03-02T00:00:00Z"),
        _page("p3", last_edited="2026-03-03T00:00:00Z"),
    ]
    hub = FakeConnectorHub({SourcePlatform.NOTION: pages})
    cutoff = datetime(2026, 3, 2, tzinfo=UTC)  # exactly the middle page's edit time
    episodes = await _collect(hub, since=cutoff)
    assert [ep.source_id for ep in episodes] == ["p2", "p3"]  # older dropped; boundary kept

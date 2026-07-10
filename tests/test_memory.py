"""Unit tests for the memory layer — identity resolution, in-memory store, retrieval scoping."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from claymore.domain import UNKNOWN_AUTHOR, SourcePlatform, Visibility
from claymore.memory.graph import (
    InMemoryMemoryStore,
    _SQLiteGraphProvenance,
    ensure_aware,
    episode_key,
)
from claymore.memory.identity import IdentityResolver, normalize_handle
from claymore.memory.ontology import EdgeType, Provenance
from claymore.memory.retrieval import retrieve
from tests.fixtures import (
    DM_LUCAS_PHILIP,
    LAB,
    LAB_WIDE,
    ROSTER,
    make_episode,
    make_user,
)

# --- identity resolution ---


def test_resolve_by_slack_handle() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    assert resolver.resolve(SourcePlatform.SLACK, "@lucas") == "p_lucas"
    assert resolver.resolve(SourcePlatform.SLACK, "lucas") == "p_lucas"  # bare handle
    assert resolver.resolve(SourcePlatform.GITHUB, "lucas-dev") == "p_lucas"


def test_resolve_email_in_angle_brackets() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    assert resolver.resolve(SourcePlatform.GMAIL, "Lucas <lucas@lab.org>") == "p_lucas"


def test_unknown_handle_never_guesses() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    assert resolver.resolve(SourcePlatform.SLACK, "@stranger") == UNKNOWN_AUTHOR


def test_resolve_episode_via_raw_author() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    ep = make_episode(author=UNKNOWN_AUTHOR, extra={"raw_author": "@philip"})
    assert resolver.resolve_episode(ep).author == "p_philip"


def test_granola_speaker_mapped_to_attendee() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    ep = make_episode(
        platform=SourcePlatform.GRANOLA,
        author=UNKNOWN_AUTHOR,
        extra={"raw_author": "lucas", "attendees": "lucas@lab.org,philip@lab.org"},
    )
    assert resolver.resolve_episode(ep).author == "p_lucas"


def test_granola_diarization_label_stays_unknown() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    ep = make_episode(
        platform=SourcePlatform.GRANOLA,
        author=UNKNOWN_AUTHOR,
        extra={"raw_author": "Speaker 1", "attendees": "lucas@lab.org,philip@lab.org"},
    )
    assert resolver.resolve_episode(ep).author == UNKNOWN_AUTHOR


def test_resolve_episode_rejects_wrong_lab() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    with pytest.raises(ValueError, match="lab_id"):
        resolver.resolve_episode(make_episode(lab_id="other-lab"))


# --- in-memory store: extraction + dedup ---


async def test_add_episode_extracts_authored_and_mentions() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(refs=("Y-hypothesis", "X-protein")))
    facts = await store.search(LAB, "hypothesis", group_ids=[LAB])
    edges = {f.edge for f in facts}
    assert EdgeType.AUTHORED_BY in edges
    assert EdgeType.MENTIONS in edges
    assert all(f.provenance.source_id == "m1" for f in facts)


async def test_unknown_author_yields_no_authored_by() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(author=UNKNOWN_AUTHOR))
    facts = await store.search(LAB, "hypothesis", group_ids=[LAB])
    assert all(f.edge != EdgeType.AUTHORED_BY for f in facts)


async def test_duplicate_episode_is_idempotent() -> None:
    store = InMemoryMemoryStore()
    ep = make_episode()
    await store.add_episode(ep)
    await store.add_episode(ep)
    facts = await store.search(LAB, "hypothesis", group_ids=[LAB])
    # AUTHORED_BY + one MENTIONS, not doubled.
    assert len(facts) == 2


# --- retrieval scoping (R10 tenant, R13 visibility) ---


async def test_search_requires_matching_group_id() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode())
    assert await store.search(LAB, "hypothesis", group_ids=[]) == []
    assert await store.search(LAB, "hypothesis", group_ids=["other-lab"]) == []


async def test_cross_lab_isolation() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(lab_id="lab1", source_id="a"))
    await store.add_episode(make_episode(lab_id="lab2", source_id="b"))
    lab1 = await store.search("lab1", "hypothesis", group_ids=["lab1"])
    assert {f.provenance.source_id for f in lab1} == {"a"}


async def test_retrieve_filters_visibility() -> None:
    store = InMemoryMemoryStore()
    # A DM only lucas + philip can see.
    await store.add_episode(make_episode(source_id="dm1", visibility=DM_LUCAS_PHILIP))
    lucas = make_user("u_lucas")
    outsider = make_user("u_rotation", role=make_user().role)
    assert await retrieve(store, lucas, "hypothesis")  # participant sees it
    assert await retrieve(store, outsider, "hypothesis") == []  # non-participant does not


async def test_retrieve_lab_wide_visible_to_all() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(visibility=LAB_WIDE))
    anyone = make_user("u_rotation")
    assert await retrieve(store, anyone, "hypothesis")


# --- helpers ---


def test_ensure_aware_coerces_naive() -> None:
    naive = datetime(2026, 3, 3, 12, 0)  # deliberately naive for the test
    assert ensure_aware(naive).tzinfo is UTC


def test_episode_key_stable_and_content_sensitive() -> None:
    a = make_episode(source_hash="h1")
    b = make_episode(source_hash="h2")
    assert episode_key(a) == episode_key(make_episode(source_hash="h1"))
    assert episode_key(a) != episode_key(b)


def test_normalize_handle_nfkc_and_casefold() -> None:
    assert normalize_handle("  @Lucas ") == "lucas"
    # full-width @ + uppercase should fold to the same key as the ascii handle
    assert normalize_handle("＠LUCAS") == normalize_handle("@lucas")  # noqa: RUF001


async def test_graph_provenance_sidecar_survives_reopen_and_scopes_labs(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.sqlite3"
    state = _SQLiteGraphProvenance(path)
    provenance = Provenance(
        source_platform=SourcePlatform.SLACK,
        source_id="C1:1.0",
        timestamp=datetime(2026, 7, 9, tzinfo=UTC),
        author="p_lucas",
    )
    visibility = Visibility(
        lab_wide=False,
        allowed_user_ids=frozenset({"u_lucas"}),
        source_label="private channel",
    )
    await state.put(LAB, "slack:C1:1.0:hash", "graph-uuid-1", provenance, visibility)

    seen, loaded = await _SQLiteGraphProvenance(path).load(LAB)
    assert seen == {"slack:C1:1.0:hash"}
    assert loaded == {"graph-uuid-1": (provenance, visibility)}
    other_seen, other_loaded = await state.load("other-lab")
    assert other_seen == set()
    assert other_loaded == {}

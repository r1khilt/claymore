"""Unit tests for the agent tool layer — read tool, citations, and non-executing proposers."""

from __future__ import annotations

from claymore.actions.approvals import ActionKind, ActionStatus, PendingAction
from claymore.agent.tools import (
    TOOL_SCHEMAS,
    facts_to_citations,
    propose_create_page,
    propose_draft_reply,
    propose_file_issue,
    search_memory,
)
from claymore.memory.graph import InMemoryMemoryStore
from claymore.memory.ontology import Fact
from tests.fixtures import (
    DM_LUCAS_PHILIP,
    LAB_WIDE,
    make_episode,
    make_user,
)

# --- search_memory: scoped reads (R10/R13) ---


async def test_search_memory_returns_scoped_facts() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(visibility=LAB_WIDE))
    facts = await search_memory(store, make_user("u_lucas"), "hypothesis")
    assert facts
    assert all(isinstance(f, Fact) for f in facts)
    assert all(f.provenance.source_id == "m1" for f in facts)


async def test_search_memory_honors_visibility() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(source_id="dm1", visibility=DM_LUCAS_PHILIP))
    # A participant sees the private-DM fact; a non-participant gets nothing.
    assert await search_memory(store, make_user("u_lucas"), "hypothesis")
    assert await search_memory(store, make_user("u_outsider"), "hypothesis") == []


async def test_search_memory_respects_limit() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(refs=("a", "b", "c", "d")))
    facts = await search_memory(store, make_user("u_lucas"), "hypothesis", limit=1)
    assert len(facts) == 1


# --- facts_to_citations: one per distinct source, deduped, never fabricated ---


async def test_citations_one_per_distinct_source_and_deduped() -> None:
    store = InMemoryMemoryStore()
    # One episode -> multiple edges (AUTHORED_BY + MENTIONS) sharing a single source.
    await store.add_episode(make_episode(refs=("Y-hypothesis", "X-protein")))
    facts = await search_memory(store, make_user("u_lucas"), "hypothesis")
    assert len(facts) > 1  # several edges...
    citations = facts_to_citations(facts)
    assert len(citations) == 1  # ...but one distinct source
    (cite,) = citations
    prov = facts[0].provenance
    assert cite.source_platform == prov.source_platform
    assert cite.source_id == prov.source_id
    assert cite.author == prov.author
    assert cite.timestamp == prov.timestamp


async def test_citations_distinguish_two_sources() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(source_id="m1"))
    await store.add_episode(make_episode(source_id="m2", text="Also about the hypothesis."))
    facts = await search_memory(store, make_user("u_lucas"), "hypothesis")
    citations = facts_to_citations(facts)
    assert {c.source_id for c in citations} == {"m1", "m2"}


def test_citations_empty_input() -> None:
    assert facts_to_citations([]) == ()


# --- write proposers: return a PendingAction, perform no side effect (hard rule 3) ---


def test_propose_draft_reply_is_pending_and_inert() -> None:
    action = propose_draft_reply(
        make_user("u_lucas"), channel="#protein-eng", body="Sounds good.", recipient="@philip"
    )
    assert isinstance(action, PendingAction)
    assert action.kind == ActionKind.DRAFT_REPLY
    assert action.status == ActionStatus.PENDING  # never executed
    assert action.requested_by == "u_lucas"
    assert action.lab_id == "lab1"
    assert action.payload["body"] == "Sounds good."
    assert action.payload["channel"] == "#protein-eng"
    assert action.idempotency_key


def test_propose_file_issue_kind_and_payload() -> None:
    action = propose_file_issue(
        make_user("u_lucas"), repo="lab/claymore", title="Test Y hypothesis", body="Details."
    )
    assert action.kind == ActionKind.FILE_ISSUE
    assert action.status == ActionStatus.PENDING
    assert action.payload == {
        "repo": "lab/claymore",
        "title": "Test Y hypothesis",
        "body": "Details.",
    }


def test_propose_create_page_kind_and_payload() -> None:
    action = propose_create_page(make_user("u_lucas"), title="Assay buffer", body="Recipe.")
    assert action.kind == ActionKind.CREATE_PAGE
    assert action.status == ActionStatus.PENDING
    assert action.payload["title"] == "Assay buffer"


def test_proposers_are_idempotent() -> None:
    user = make_user("u_lucas")
    a = propose_file_issue(user, repo="lab/x", title="t", body="b")
    b = propose_file_issue(user, repo="lab/x", title="t", body="b")
    # Same proposal -> same idempotency key (a lost ack can't double-file).
    assert a.idempotency_key == b.idempotency_key


# --- tool schema registry is well-formed ---


def test_tool_schemas_wellformed() -> None:
    names = [s.name for s in TOOL_SCHEMAS]
    assert names == sorted(set(names), key=names.index)  # order preserved
    assert len(names) == len(set(names))  # unique
    assert "search_memory" in names
    for schema in TOOL_SCHEMAS:
        assert isinstance(schema.input_schema, dict)
        assert schema.input_schema["type"] == "object"
        assert schema.input_schema["additionalProperties"] is False
        assert schema.description

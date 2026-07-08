"""Tests for the MCP-out server tool functions (offline, InMemoryMemoryStore + fixtures).

Exercises the four read-only tools through the same scope-enforcing retrieval path the agent
uses: results must be scoped to the client's lab, must carry provenance (source_id + author) for
every returned fact (hard rule 1), and each call must write one audit record naming the touched
sources (rule 5). No fastmcp, no network, no keys.
"""

from __future__ import annotations

from claymore.audit import AuditRecord, AuditSink, TrustOrigin
from claymore.mcp_server.server import (
    NO_RESULTS_TEXT,
    McpClientContext,
    find_protocol,
    search_lab_memory,
    what_was_decided,
    who_worked_on,
)
from claymore.memory.graph import InMemoryMemoryStore, episode_key
from claymore.memory.ontology import EdgeType, Fact, Provenance
from tests.fixtures import LAB, LAB_WIDE, NOW, make_episode


class RecordingAudit(AuditSink):
    """Collects records in memory so tests can assert on the audit trail."""

    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    async def write(self, record: AuditRecord) -> None:
        self.records.append(record)


def ctx(
    user_id: str = "u_lucas", lab_id: str = LAB, client_id: str = "codex-1"
) -> McpClientContext:
    return McpClientContext(client_id=client_id, lab_id=lab_id, user_id=user_id)


def seed_decided(
    store: InMemoryMemoryStore, *, text: str, object_id: str, lab_id: str = LAB
) -> None:
    """Inject a DECIDED fact directly (the in-memory store's extraction only emits AUTHORED_BY/
    MENTIONS, so a decision has to be planted to exercise the DECIDED-edge filter)."""
    ep = make_episode(source_id=f"dec-{object_id}", text=text, lab_id=lab_id)
    fact = Fact(
        subject_id="p_team",
        edge=EdgeType.DECIDED,
        object_id=object_id,
        valid_from=NOW,
        provenance=Provenance(
            source_platform=ep.source_platform,
            source_id=ep.source_id,
            timestamp=NOW,
            author="p_lucas",
        ),
        visibility=LAB_WIDE,
    )
    store._facts.setdefault(lab_id, {})[episode_key(ep)] = [(fact, text)]


# --- search_lab_memory -----------------------------------------------------------------------


async def test_search_returns_cited_facts_for_the_right_lab() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode())
    result = await search_lab_memory(ctx(), store, "hypothesis")

    assert result.facts
    # Every returned fact carries provenance — source id + author (hard rule 1).
    for f in result.facts:
        assert f.source_id
        assert f.author
        assert f.source_platform
    assert {f.author for f in result.facts} == {"p_lucas"}


async def test_search_writes_audit_with_touched_sources() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(source_id="m1"))
    audit = RecordingAudit()
    result = await search_lab_memory(ctx(client_id="cursor-9"), store, "hypothesis", audit=audit)

    assert len(audit.records) == 1
    rec = audit.records[0]
    assert rec.actor == "cursor-9"
    assert rec.action == "mcp.search_lab_memory"
    assert rec.trust_origin == TrustOrigin.SYSTEM
    assert rec.lab_id == LAB
    assert set(rec.sources_touched) == {f.source_id for f in result.facts}
    assert "m1" in rec.sources_touched


async def test_empty_result_uses_honest_no_answer_text() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode())
    audit = RecordingAudit()
    result = await search_lab_memory(ctx(), store, "xenon boiling point", audit=audit)

    assert result.facts == ()
    assert result.text == NO_RESULTS_TEXT
    # A no-hit call is still audited, with no sources touched.
    assert len(audit.records) == 1
    assert audit.records[0].sources_touched == ()


# --- who_worked_on ---------------------------------------------------------------------------


async def test_who_worked_on_returns_scoped_attributed_facts() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode(author="p_lucas", refs=("X-protein",)))
    result = await who_worked_on(ctx(), store, "X-protein")

    assert result.facts
    assert all(f.source_id and f.author for f in result.facts)


# --- what_was_decided ------------------------------------------------------------------------


async def test_what_was_decided_prefers_decided_facts() -> None:
    store = InMemoryMemoryStore()
    # Non-decision chatter about the same topic must NOT be returned as a decision.
    await store.add_episode(make_episode(text="Discussing buffer choices for the assay.", refs=()))
    seed_decided(store, text="We decided to use buffer A for the assay.", object_id="buffer-A")

    audit = RecordingAudit()
    result = await what_was_decided(ctx(), store, "buffer", audit=audit)

    assert result.facts
    assert all(f.edge == EdgeType.DECIDED for f in result.facts)
    assert {f.object_id for f in result.facts} == {"buffer-A"}
    # Audit reflects only the DECIDED source that was actually returned.
    assert set(audit.records[0].sources_touched) == {"dec-buffer-A"}


# --- find_protocol ---------------------------------------------------------------------------


async def test_find_protocol_returns_cited_hit() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(
        make_episode(text="The lysis protocol uses 2mM EDTA.", refs=("lysis-protocol",))
    )
    result = await find_protocol(ctx(), store, "lysis-protocol")

    assert result.facts
    assert any("lysis-protocol" in f.object_id for f in result.facts)
    assert all(f.source_id for f in result.facts)

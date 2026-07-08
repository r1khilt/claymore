"""Unit tests for the deterministic cross-fact reconciliation pass (R12, reconcile.py).

Covers the core rules: later different DECIDED supersedes earlier; same-object is reinforcement;
concurrent conflicting DECIDED contradicts; multi-valued edges never react; reconciled edges
carry most-restrictive visibility and later-fact provenance.
"""

from __future__ import annotations

from datetime import UTC, datetime

from claymore.domain import SourcePlatform, Visibility
from claymore.memory.ontology import RECONCILED_EDGES, EdgeType, Fact, Provenance
from claymore.memory.reconcile import SINGLE_VALUED_EDGES, fact_identity, reconcile
from tests.fixtures import DM_LUCAS_PHILIP, LAB_WIDE

MAR3 = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
MAR10 = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
MAR17 = datetime(2026, 3, 17, 12, 0, tzinfo=UTC)


def make_fact(
    *,
    subject: str = "p_team",
    edge: EdgeType = EdgeType.DECIDED,
    object_id: str = "optionA",
    valid_from: datetime = MAR3,
    valid_to: datetime | None = None,
    author: str = "p_lucas",
    source_id: str = "e1",
    platform: SourcePlatform = SourcePlatform.SLACK,
    visibility: Visibility = LAB_WIDE,
) -> Fact:
    return Fact(
        subject_id=subject,
        edge=edge,
        object_id=object_id,
        valid_from=valid_from,
        valid_to=valid_to,
        provenance=Provenance(
            source_platform=platform,
            source_id=source_id,
            timestamp=valid_from,
            author=author,
        ),
        visibility=visibility,
    )


# --- SUPERSEDES ---


def test_later_different_decided_supersedes_earlier() -> None:
    earlier = make_fact(object_id="optionA", valid_from=MAR3, source_id="e1")
    later = make_fact(object_id="optionB", valid_from=MAR10, source_id="e2")
    # Pass unordered to prove ordering is by valid_from, not input order.
    edges = reconcile([later, earlier])
    assert len(edges) == 1
    edge = edges[0]
    assert edge.edge is EdgeType.SUPERSEDES
    assert edge.subject_id == fact_identity(later)
    assert edge.object_id == fact_identity(earlier)


def test_same_object_is_reinforcement_no_edge() -> None:
    earlier = make_fact(object_id="optionA", valid_from=MAR3, source_id="e1")
    later = make_fact(object_id="optionA", valid_from=MAR10, source_id="e2")
    assert reconcile([earlier, later]) == []


def test_three_step_chain_supersedes() -> None:
    a = make_fact(object_id="A", valid_from=MAR3, source_id="e1")
    b = make_fact(object_id="B", valid_from=MAR10, source_id="e2")
    c = make_fact(object_id="C", valid_from=MAR17, source_id="e3")
    edges = reconcile([c, a, b])
    assert [e.edge for e in edges] == [EdgeType.SUPERSEDES, EdgeType.SUPERSEDES]
    # A chain: B supersedes A, C supersedes B.
    pairs = {(e.subject_id, e.object_id) for e in edges}
    assert (fact_identity(b), fact_identity(a)) in pairs
    assert (fact_identity(c), fact_identity(b)) in pairs


# --- CONTRADICTS ---


def test_concurrent_conflicting_decided_contradicts() -> None:
    a = make_fact(object_id="optionA", valid_from=MAR3, source_id="e1")
    b = make_fact(object_id="optionB", valid_from=MAR3, source_id="e2")
    edges = reconcile([a, b])
    assert len(edges) == 1
    assert edges[0].edge is EdgeType.CONTRADICTS


def test_concurrent_same_object_does_not_contradict() -> None:
    a = make_fact(object_id="optionA", valid_from=MAR3, source_id="e1")
    b = make_fact(object_id="optionA", valid_from=MAR3, source_id="e2")
    assert reconcile([a, b]) == []


# --- multi-valued edges never react ---


def test_mentions_with_many_objects_no_edges() -> None:
    facts = [
        make_fact(edge=EdgeType.MENTIONS, object_id=obj, valid_from=MAR3, source_id=f"m{i}")
        for i, obj in enumerate(["X-protein", "Y-hypothesis", "Z-assay"])
    ]
    assert reconcile(facts) == []


def test_uses_edge_is_multi_valued_no_edges() -> None:
    facts = [
        make_fact(edge=EdgeType.USES, object_id="bufferA", valid_from=MAR3, source_id="u1"),
        make_fact(edge=EdgeType.USES, object_id="bufferB", valid_from=MAR10, source_id="u2"),
    ]
    assert reconcile(facts) == []


# --- provenance / visibility of reconciled edges ---


def test_reconciled_edge_visibility_is_most_restrictive() -> None:
    earlier = make_fact(object_id="A", valid_from=MAR3, source_id="e1", visibility=LAB_WIDE)
    later = make_fact(object_id="B", valid_from=MAR10, source_id="e2", visibility=DM_LUCAS_PHILIP)
    edges = reconcile([earlier, later])
    assert len(edges) == 1
    # lab-wide combined with a restricted DM must fail closed to the DM scope.
    assert edges[0].visibility == DM_LUCAS_PHILIP


def test_reconciled_edge_provenance_from_later_fact() -> None:
    earlier = make_fact(object_id="A", valid_from=MAR3, source_id="e1", author="p_lucas")
    later = make_fact(object_id="B", valid_from=MAR10, source_id="e2", author="p_philip")
    edges = reconcile([earlier, later])
    prov = edges[0].provenance
    assert prov.author == "p_philip"
    assert prov.timestamp == later.provenance.timestamp
    assert prov.source_platform is SourcePlatform.MANUAL
    assert edges[0].valid_from == later.provenance.timestamp


def test_only_reconciled_edge_types_are_emitted() -> None:
    facts = [
        make_fact(object_id="A", valid_from=MAR3, source_id="e1"),
        make_fact(object_id="B", valid_from=MAR3, source_id="e2"),
        make_fact(object_id="C", valid_from=MAR10, source_id="e3"),
    ]
    edges = reconcile(facts)
    assert edges  # some edges produced
    assert all(e.edge in RECONCILED_EDGES for e in edges)


def test_inputs_are_not_mutated() -> None:
    earlier = make_fact(object_id="A", valid_from=MAR3, source_id="e1")
    later = make_fact(object_id="B", valid_from=MAR10, source_id="e2")
    snapshot_earlier = earlier.model_copy(deep=True)
    snapshot_later = later.model_copy(deep=True)
    reconcile([earlier, later])
    assert earlier == snapshot_earlier
    assert later == snapshot_later


def test_decided_is_single_valued() -> None:
    assert EdgeType.DECIDED in SINGLE_VALUED_EDGES
    assert EdgeType.MENTIONS not in SINGLE_VALUED_EDGES

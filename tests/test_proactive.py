"""Unit tests for proactive surfacing (proactive/triggers.py, CLAUDE.md §1.5).

Covers the core behaviours: a SUGGESTED with no RAN yields one grounded never-tested nudge; a
SUGGESTED that was later run yields none; a CONTRADICTS edge becomes a high-priority alert; the
digest counts recent facts (and returns None on an empty window); and the budget passes
high-priority during quiet hours while batching low-priority.
"""

from __future__ import annotations

from datetime import UTC, datetime

from claymore.domain import SourcePlatform, Visibility
from claymore.memory.ontology import EdgeType, Fact, Provenance
from claymore.memory.reconcile import fact_identity, reconcile
from claymore.proactive.triggers import (
    NotificationBudget,
    UserNotificationState,
    apply_budget,
    contradiction_alerts,
    digest,
    never_tested_ideas,
    notification_signature,
)
from tests.fixtures import LAB_WIDE

MAR3 = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
MAR10 = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
MAR17 = datetime(2026, 3, 17, 12, 0, tzinfo=UTC)


def make_fact(
    *,
    subject: str = "p_lucas",
    edge: EdgeType = EdgeType.SUGGESTED,
    object_id: str = "Y-hypothesis",
    valid_from: datetime = MAR3,
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
        provenance=Provenance(
            source_platform=platform,
            source_id=source_id,
            timestamp=valid_from,
            author=author,
        ),
        visibility=visibility,
    )


# --- never_tested_ideas ---


def test_suggested_with_no_ran_yields_one_nudge_with_provenance() -> None:
    suggestion = make_fact(object_id="Y-hypothesis", author="p_lucas", source_id="e1")
    notes = never_tested_ideas([suggestion])
    assert len(notes) == 1
    note = notes[0]
    assert note.kind == "never_tested"
    assert note.priority == "normal"
    assert note.user_id == "p_lucas"
    assert "Y-hypothesis" in note.title
    # Grounded: the single citation points back at the originating suggestion.
    assert len(note.citations) == 1
    assert note.citations[0].fact_id == fact_identity(suggestion)
    assert note.citations[0].author == "p_lucas"


def test_suggested_then_ran_yields_no_nudge() -> None:
    suggestion = make_fact(edge=EdgeType.SUGGESTED, object_id="Y-hypothesis", source_id="e1")
    ran = make_fact(
        subject="exp1",
        edge=EdgeType.RAN,
        object_id="Y-hypothesis",
        valid_from=MAR10,
        source_id="e2",
    )
    assert never_tested_ideas([suggestion, ran]) == []


def test_suggested_then_produced_yields_no_nudge() -> None:
    suggestion = make_fact(edge=EdgeType.SUGGESTED, object_id="assay-buffer", source_id="e1")
    produced = make_fact(
        subject="exp1",
        edge=EdgeType.PRODUCED,
        object_id="assay-buffer",
        valid_from=MAR10,
        source_id="e2",
    )
    assert never_tested_ideas([suggestion, produced]) == []


def test_duplicate_suggestions_dedupe_to_one_nudge_from_originating_fact() -> None:
    first = make_fact(object_id="Y-hypothesis", valid_from=MAR3, source_id="e1", author="p_lucas")
    later = make_fact(object_id="Y-hypothesis", valid_from=MAR10, source_id="e2", author="p_philip")
    notes = never_tested_ideas([later, first])  # unordered on purpose
    assert len(notes) == 1
    # The originating (earliest) suggestion grounds the nudge.
    assert notes[0].citations[0].fact_id == fact_identity(first)
    assert notes[0].user_id == "p_lucas"


def test_suggester_running_something_unrelated_does_not_silence_idea() -> None:
    suggestion = make_fact(subject="p_lucas", object_id="Y-hypothesis", source_id="e1")
    # Same person ran a *different* thing — the untested idea must still surface.
    unrelated = make_fact(
        subject="p_lucas", edge=EdgeType.RAN, object_id="Z-assay", valid_from=MAR10, source_id="e2"
    )
    notes = never_tested_ideas([suggestion, unrelated])
    assert len(notes) == 1
    assert "Y-hypothesis" in notes[0].title


# --- contradiction_alerts ---


def test_contradicts_edge_becomes_high_priority_alert() -> None:
    a = make_fact(subject="p_team", edge=EdgeType.DECIDED, object_id="optionA", valid_from=MAR3)
    b = make_fact(
        subject="p_team",
        edge=EdgeType.DECIDED,
        object_id="optionB",
        valid_from=MAR3,
        source_id="e2",
        author="p_philip",
    )
    edges = reconcile([a, b])
    assert edges and edges[0].edge is EdgeType.CONTRADICTS
    notes = contradiction_alerts(edges)
    assert len(notes) == 1
    note = notes[0]
    assert note.kind == "contradiction"
    assert note.priority == "high"
    # Grounded in the reconciled edge itself.
    assert note.citations[0].fact_id == fact_identity(edges[0])


def test_supersedes_edge_is_not_alerted() -> None:
    earlier = make_fact(subject="p_team", edge=EdgeType.DECIDED, object_id="A", valid_from=MAR3)
    later = make_fact(
        subject="p_team", edge=EdgeType.DECIDED, object_id="B", valid_from=MAR10, source_id="e2"
    )
    edges = reconcile([earlier, later])
    assert edges and edges[0].edge is EdgeType.SUPERSEDES
    assert contradiction_alerts(edges) == []


# --- digest ---


def test_digest_counts_recent_facts() -> None:
    facts = [
        make_fact(edge=EdgeType.SUGGESTED, object_id="idea1", valid_from=MAR10, source_id="e1"),
        make_fact(edge=EdgeType.DECIDED, object_id="optionA", valid_from=MAR17, source_id="e2"),
        make_fact(edge=EdgeType.RAN, object_id="idea1", valid_from=MAR17, source_id="e3"),
    ]
    note = digest(facts, since=MAR3, now=datetime(2026, 3, 20, tzinfo=UTC), user_id="u_lucas")
    assert note is not None
    assert note.kind == "digest"
    assert note.priority == "low"
    assert note.user_id == "u_lucas"
    assert "3 updates" in note.title
    assert len(note.citations) == 3


def test_digest_empty_window_returns_none() -> None:
    facts = [make_fact(valid_from=MAR3, source_id="e1")]
    # Window strictly after the only fact → nothing to report.
    note = digest(facts, since=MAR10, now=datetime(2026, 3, 20, tzinfo=UTC), user_id="u_lucas")
    assert note is None


def test_digest_window_is_half_open_excludes_since_includes_now() -> None:
    at_since = make_fact(object_id="old", valid_from=MAR3, source_id="e1")
    at_now = make_fact(object_id="new", valid_from=MAR10, source_id="e2")
    note = digest([at_since, at_now], since=MAR3, now=MAR10, user_id="u_lucas")
    assert note is not None
    # Only the fact at `now` is in (since, now]; the one exactly at `since` is excluded.
    assert "1 updates" in note.title
    assert note.citations[0].fact_id == fact_identity(at_now)


# --- apply_budget ---


def test_quiet_hours_passes_high_batches_low() -> None:
    high = contradiction_alerts(
        reconcile(
            [
                make_fact(subject="p_team", edge=EdgeType.DECIDED, object_id="A", valid_from=MAR3),
                make_fact(
                    subject="p_team",
                    edge=EdgeType.DECIDED,
                    object_id="B",
                    valid_from=MAR3,
                    source_id="e2",
                ),
            ]
        )
    )
    low = never_tested_ideas([make_fact(object_id="Y-hypothesis", source_id="s1")])
    assert high and low
    budget = NotificationBudget(max_per_window=10, quiet_start_hour=22, quiet_end_hour=7)
    state = UserNotificationState()
    at_night = datetime(2026, 3, 3, 23, 0, tzinfo=UTC)  # inside quiet hours
    allowed = apply_budget([*high, *low], budget=budget, user_state=state, now=at_night)
    # High-priority contradiction passes; the normal-priority never-tested nudge is held.
    assert allowed == high


def test_outside_quiet_hours_everything_within_rate_limit_passes() -> None:
    low = never_tested_ideas([make_fact(object_id="Y-hypothesis", source_id="s1")])
    budget = NotificationBudget(max_per_window=10, quiet_start_hour=22, quiet_end_hour=7)
    daytime = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
    allowed = apply_budget(low, budget=budget, user_state=UserNotificationState(), now=daytime)
    assert allowed == low


def test_rate_limit_admits_high_priority_first() -> None:
    edges = reconcile(
        [
            make_fact(subject="p_a", edge=EdgeType.DECIDED, object_id="A", valid_from=MAR3),
            make_fact(
                subject="p_a", edge=EdgeType.DECIDED, object_id="B", valid_from=MAR3, source_id="e2"
            ),
        ]
    )
    high = contradiction_alerts(edges)
    low = never_tested_ideas([make_fact(object_id="Y-hypothesis", source_id="s1")])
    budget = NotificationBudget(max_per_window=1, quiet_start_hour=0, quiet_end_hour=0)
    daytime = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
    allowed = apply_budget(
        [*low, *high], budget=budget, user_state=UserNotificationState(), now=daytime
    )
    # Only one slot; the high-priority alert wins even though it was listed last.
    assert allowed == high


def test_dedupe_against_history() -> None:
    note = never_tested_ideas([make_fact(object_id="Y-hypothesis", source_id="s1")])[0]
    budget = NotificationBudget(max_per_window=10, quiet_start_hour=0, quiet_end_hour=0)
    state = UserNotificationState(seen_signatures=frozenset({notification_signature(note)}))
    daytime = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
    assert apply_budget([note], budget=budget, user_state=state, now=daytime) == []

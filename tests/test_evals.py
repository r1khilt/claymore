"""Tests for the attribution eval harness (evals/harness.py + evals/corpus.py).

Two jobs: prove the harness *runs* on the seeded corpus, and prove its metrics — above all the
``confident_wrong_rate`` killer metric — compute to exact, hand-verifiable values. The visibility
and knowledge-update cases get dedicated coverage because they are the two scenarios where a
science-memory agent most easily produces a confident wrong answer.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import pytest
from evals.corpus import CASES, CORPUS, ROSTER, EvalCase
from evals.harness import format_report, run_eval

from claymore.domain import LabId, SourcePlatform, Visibility
from claymore.ingest.normalize import Episode
from claymore.memory.graph import InMemoryMemoryStore
from claymore.memory.ontology import EdgeType, Fact, Provenance
from claymore.memory.retrieval import retrieve
from claymore.ports import MemoryStore
from tests.fixtures import make_episode, make_user

EARLY = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
LATE = datetime(2026, 3, 20, 12, 0, tzinfo=UTC)


# --- (a) the harness runs on a tiny known corpus ---------------------------------------------


async def test_harness_runs_on_tiny_corpus() -> None:
    ep = make_episode(source_id="only", source_hash="h", text="widget", refs=(), author="p_lucas")
    case = EvalCase(
        query="widget",
        expected_source_ids=frozenset({"only"}),
        expected_authors=frozenset({"p_lucas"}),
        case_type="single_hop",
    )
    roster = [make_user("u_maya", person_id="p_maya")]

    report = await run_eval(InMemoryMemoryStore(), [case], roster, corpus=[ep])

    assert report.n_cases == 1
    assert report.coverage == 1.0
    assert report.confident_wrong_rate == 0.0
    assert report.attribution_precision == 1.0
    assert report.attribution_recall == 1.0
    assert "single_hop" in report.by_case_type
    # the renderer must not blow up on a real report
    assert "confident_wrong_rate" in format_report(report)


# --- (b) metrics compute correctly on a crafted corpus with known ground truth ----------------


async def test_metrics_exact_on_crafted_corpus() -> None:
    # Two episodes both say "alpha"; only "a" is the correct source. One episode says "beta".
    ep_a = make_episode(
        source_id="a",
        source_hash="ha",
        text="alpha topic",
        refs=(),
        author="p_lucas",
        timestamp=EARLY,
    )
    ep_b = make_episode(
        source_id="b",
        source_hash="hb",
        text="alpha topic too",
        refs=(),
        author="p_philip",
        timestamp=LATE,
    )
    ep_c = make_episode(
        source_id="c",
        source_hash="hc",
        text="beta only",
        refs=(),
        author="p_lucas",
    )
    corpus = [ep_a, ep_b, ep_c]

    # T1 pulls both alpha episodes but only "a" is expected -> one confident-wrong attribution.
    t1 = EvalCase(
        query="alpha",
        expected_source_ids=frozenset({"a"}),
        expected_authors=frozenset({"p_lucas"}),
        case_type="single_hop",
    )
    # T2 is clean: only "c" matches "beta".
    t2 = EvalCase(
        query="beta",
        expected_source_ids=frozenset({"c"}),
        expected_authors=frozenset({"p_lucas"}),
        case_type="single_hop",
    )
    roster = [make_user("u_maya", person_id="p_maya")]

    report = await run_eval(InMemoryMemoryStore(), [t1, t2], roster, corpus=corpus)

    # Precision: 2 correct facts (a, c) of 3 returned (a, b, c). Recall: both expected sources hit.
    assert report.attribution_precision == pytest.approx(2 / 3)
    assert report.attribution_recall == 1.0
    assert report.coverage == 1.0
    # One of two cases returned a wrongly-attributed fact.
    assert report.confident_wrong_rate == 0.5

    r1, r2 = report.results
    assert r1.retrieved == 2 and r1.correct == 1 and r1.confident_wrong is True
    assert r2.retrieved == 1 and r2.correct == 1 and r2.confident_wrong is False

    single = report.by_case_type["single_hop"]
    assert single.n == 2
    assert single.confident_wrong_rate == 0.5


# --- (b2) the killer bug: a real source pinned to the WRONG author must be caught ---------------


class _MispairingStore(MemoryStore):
    """A store that always returns a fixed set of facts, regardless of query — used to inject a
    provenance the InMemoryMemoryStore can never produce (its author is a pure function of the
    source, so it can't mis-pair). The real GraphitiMemoryStore CAN diverge source from author,
    which is exactly the failure this stand-in simulates."""

    def __init__(self, facts: Sequence[Fact]) -> None:
        self._facts = list(facts)

    async def add_episode(self, episode: Episode) -> None:
        return None

    async def search(
        self, lab_id: LabId, query: str, *, group_ids: Sequence[str], limit: int = 10
    ) -> list[Fact]:
        return list(self._facts)

    async def build_indices(self, lab_id: LabId) -> None:
        return None


async def test_confident_wrong_catches_source_paired_with_wrong_author() -> None:
    """Source "a" is really Lucas's and source "b" is really Philip's. A retrieved fact pins the
    real source "a" to Philip — an author who legitimately authored a *different* source in the
    same (multi-author) case. Independent membership checks (source in expected, author in expected)
    both pass and would miss this; the paired check against corpus truth must flag it.

    This asserts confident_wrong_rate > 0 and precision < 1.0 — it FAILS against the old
    independent-membership logic (which scored this clean) and PASSES against the paired logic.
    """
    # Corpus defines the ground truth: a -> p_lucas, b -> p_philip.
    ep_a = make_episode(source_id="a", source_hash="ha", author="p_lucas", text="alpha", refs=())
    ep_b = make_episode(source_id="b", source_hash="hb", author="p_philip", text="beta", refs=())

    # The fabricated retrieval: real source "a" attributed to Philip (who really authored "b").
    mispaired = Fact(
        subject_id="p_philip",
        edge=EdgeType.SUGGESTED,
        object_id="alpha-topic",
        valid_from=EARLY,
        provenance=Provenance(
            source_platform=SourcePlatform.SLACK,
            source_id="a",
            timestamp=EARLY,
            author="p_philip",  # WRONG: source "a" was really authored by p_lucas
        ),
        visibility=Visibility(lab_wide=True, source_label="#lab"),
    )

    case = EvalCase(
        query="alpha",
        expected_source_ids=frozenset({"a", "b"}),
        expected_authors=frozenset({"p_lucas", "p_philip"}),  # multi-author: both are valid authors
        case_type="multi_hop",
    )
    roster = [make_user("u_maya", person_id="p_maya")]

    report = await run_eval(_MispairingStore([mispaired]), [case], roster, corpus=[ep_a, ep_b])

    # The one returned fact is a fabricated attribution -> caught.
    assert report.confident_wrong_rate > 0
    assert report.attribution_precision < 1.0
    r = report.results[0]
    assert r.retrieved == 1
    assert r.correct == 0
    assert r.confident_wrong is True
    assert r.found_sources == 0  # nothing was surfaced with the correct author


# --- (c) visibility: a non-participant retrieves nothing and is never wrongly attributed --------


def _find_case(*, as_user: str, query: str) -> EvalCase:
    for case in CASES:
        if case.as_user == as_user and case.query == query:
            return case
    raise AssertionError(f"no seeded case as_user={as_user!r} query={query!r}")


async def test_visibility_non_participant_gets_nothing() -> None:
    store = InMemoryMemoryStore()
    negative = _find_case(as_user="u_rotation", query="Nirvana")
    assert not negative.expected_source_ids  # it is a true negative case

    report = await run_eval(store, [negative], ROSTER, corpus=CORPUS)

    # Nothing retrieved -> nothing to attribute wrongly.
    assert report.confident_wrong_rate == 0.0
    assert report.results[0].retrieved == 0
    assert report.coverage == 1.0  # correctly returned nothing

    # And prove directly that the private DM fact does not leak to the outsider...
    rotation = next(u for u in ROSTER if u.id == "u_rotation")
    assert await retrieve(store, rotation, "Nirvana") == []
    # ...while a participant does see it, attributed to the real author.
    lucas = next(u for u in ROSTER if u.id == "u_lucas")
    facts = await retrieve(store, lucas, "Nirvana")
    assert facts
    assert {f.provenance.source_id for f in facts} == {"dm_secret"}
    assert all(f.provenance.author == "p_lucas" for f in facts)


async def test_visibility_participant_case_scores_clean() -> None:
    positive = _find_case(as_user="u_lucas", query="Nirvana")
    report = await run_eval(InMemoryMemoryStore(), [positive], ROSTER, corpus=CORPUS)
    assert report.confident_wrong_rate == 0.0
    assert report.results[0].found_sources == 1


# --- (d) the knowledge-update case is represented and current-fact-first --------------------


def test_knowledge_update_case_present() -> None:
    ku = [c for c in CASES if c.case_type == "knowledge_update"]
    assert ku, "corpus must include at least one knowledge_update case"
    # the update chain must exist in the corpus (v1 superseded by a later v2)
    ids = {ep.source_id for ep in CORPUS}
    assert {"gmail_buffer_v1", "gmail_buffer_v2"} <= ids
    v1 = next(ep for ep in CORPUS if ep.source_id == "gmail_buffer_v1")
    v2 = next(ep for ep in CORPUS if ep.source_id == "gmail_buffer_v2")
    assert v2.timestamp > v1.timestamp


async def test_knowledge_update_surfaces_latest_first() -> None:
    store = InMemoryMemoryStore()
    for ep in CORPUS:
        await store.add_episode(ep)
    asker = next(u for u in ROSTER if u.id == "u_maya")
    facts = await retrieve(store, asker, "phosphate buffer")
    # both versions are retrievable, and the superseding (newer) email ranks first
    assert {f.provenance.source_id for f in facts} == {"gmail_buffer_v1", "gmail_buffer_v2"}
    assert facts[0].provenance.source_id == "gmail_buffer_v2"


# --- the full seeded corpus is clean end-to-end (the demo baseline) ---------------------------


async def test_full_corpus_has_zero_confident_wrong() -> None:
    report = await run_eval(InMemoryMemoryStore(), CASES, ROSTER)
    assert report.n_cases == len(CASES)
    assert report.confident_wrong_rate == 0.0
    assert report.coverage == 1.0
    assert report.attribution_precision == 1.0
    assert report.attribution_recall == 1.0

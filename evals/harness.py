"""Retrieval-attribution eval harness (build EARLY — Phase 1, BUILD_PLAN.md §6, R2).

The Reviewer-2-proof metric: seed a synthetic lab corpus with known ground truth (who said what,
when, what was superseded, mixed visibility) and measure whether :func:`claymore.memory.retrieval.
retrieve` returns *correctly-attributed* facts. The killer failure for a science-memory agent is a
**confident wrong attribution** — a fact returned and pinned to a source/author that did not say it
(hard rule 1) — so that is the headline metric here, alongside precision / recall / coverage and
per-case-type breakdowns.

This runs entirely on :class:`~claymore.memory.graph.InMemoryMemoryStore`: deterministic,
LLM-free, no services, no spend. ``python -m evals.harness`` seeds the canonical corpus and prints
a readable report.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict

from claymore.auth.models import User
from claymore.ingest.normalize import Episode
from claymore.memory.graph import InMemoryMemoryStore
from claymore.memory.retrieval import retrieve
from claymore.ports import MemoryStore
from evals.corpus import CASES, CORPUS, ROSTER, CaseType, EvalCase

# The four case types we always report on, in a stable display order.
CASE_TYPES: tuple[CaseType, ...] = ("single_hop", "multi_hop", "temporal", "knowledge_update")


class CaseResult(BaseModel):
    """Per-case scoring, kept as raw counts so aggregates can be micro-averaged, not averaged-of-
    averages (which would over-weight tiny result sets)."""

    model_config = ConfigDict(frozen=True)

    query: str
    case_type: CaseType
    as_user: str
    note: str

    retrieved: int
    """Facts returned by ``retrieve`` for this case."""
    correct: int
    """Returned facts whose ``source_id`` is in the expected set."""
    expected_sources: int
    """Size of the expected source set (0 for a negative/visibility case)."""
    found_sources: int
    """Distinct expected sources actually retrieved (recall numerator)."""

    confident_wrong: bool
    """True if ANY returned fact was attributed to a source or author outside the expected set —
    a wrong attribution presented as an answer. Zero of these is the whole game."""
    covered: bool
    """True if the case was adequately grounded: ≥1 correct source, or (for a negative case with no
    expected sources) nothing was retrieved."""


class CaseTypeMetrics(BaseModel):
    """The four headline metrics for one slice of cases."""

    model_config = ConfigDict(frozen=True)

    n: int
    attribution_precision: float
    attribution_recall: float
    coverage: float
    confident_wrong_rate: float


class EvalReport(BaseModel):
    """Aggregate run result — the object CI thresholds on (faithfulness/attribution gate)."""

    model_config = ConfigDict(frozen=True)

    n_cases: int
    attribution_precision: float
    """Micro-avg: of every fact we returned, the fraction correctly attributed."""
    attribution_recall: float
    """Micro-avg: of every expected source across cases, the fraction we surfaced."""
    coverage: float
    """Fraction of cases adequately grounded (see :attr:`CaseResult.covered`)."""
    confident_wrong_rate: float
    """THE metric: fraction of cases where a fact was returned under a wrong source/author."""

    by_case_type: dict[str, CaseTypeMetrics]
    results: tuple[CaseResult, ...]


def _metrics(results: Sequence[CaseResult]) -> CaseTypeMetrics:
    """Micro-average a set of per-case results into the four headline metrics.

    Empty denominators fail *safe*: no facts returned → precision 1.0 (we asserted nothing wrong);
    no sources expected anywhere → recall 1.0 (nothing to find). This is what makes a run of purely
    negative (visibility) cases score cleanly instead of dividing by zero.
    """
    n = len(results)
    if n == 0:
        return CaseTypeMetrics(
            n=0,
            attribution_precision=1.0,
            attribution_recall=1.0,
            coverage=1.0,
            confident_wrong_rate=0.0,
        )
    total_retrieved = sum(r.retrieved for r in results)
    total_correct = sum(r.correct for r in results)
    total_expected = sum(r.expected_sources for r in results)
    total_found = sum(r.found_sources for r in results)
    return CaseTypeMetrics(
        n=n,
        attribution_precision=(total_correct / total_retrieved) if total_retrieved else 1.0,
        attribution_recall=(total_found / total_expected) if total_expected else 1.0,
        coverage=sum(1 for r in results if r.covered) / n,
        confident_wrong_rate=sum(1 for r in results if r.confident_wrong) / n,
    )


def _score_case(case: EvalCase, facts: Sequence[_ScoredFact]) -> CaseResult:
    """Compare one case's retrieved facts against its expected provenance."""
    retrieved_sources = {f.source_id for f in facts}
    correct = sum(1 for f in facts if f.source_id in case.expected_source_ids)
    found_sources = len(retrieved_sources & case.expected_source_ids)
    confident_wrong = any(
        f.source_id not in case.expected_source_ids or f.author not in case.expected_authors
        for f in facts
    )
    expected_sources = len(case.expected_source_ids)
    covered = found_sources > 0 if expected_sources > 0 else len(facts) == 0
    return CaseResult(
        query=case.query,
        case_type=case.case_type,
        as_user=case.as_user or "(default)",
        note=case.note,
        retrieved=len(facts),
        correct=correct,
        expected_sources=expected_sources,
        found_sources=found_sources,
        confident_wrong=confident_wrong,
        covered=covered,
    )


class _ScoredFact(BaseModel):
    """The two provenance fields the scorer needs, pulled off a retrieved ``Fact``."""

    model_config = ConfigDict(frozen=True)

    source_id: str
    author: str


def _resolve_asker(case: EvalCase, by_id: dict[str, User], default: User) -> User:
    if case.as_user is None:
        return default
    user = by_id.get(case.as_user)
    if user is None:
        raise KeyError(f"case asks as unknown user {case.as_user!r} (not in roster)")
    return user


async def run_eval(
    store: MemoryStore,
    cases: Sequence[EvalCase],
    roster: Sequence[User],
    *,
    corpus: Sequence[Episode] = CORPUS,
    limit: int = 10,
) -> EvalReport:
    """Seed ``store`` with ``corpus``, run ``retrieve`` per case as the asking user, and score
    attribution. ``roster`` supplies the asking users (``roster[0]`` is the default asker for cases
    with no explicit ``as_user``)."""
    if not roster:
        raise ValueError("roster must contain at least one user (the default asker)")

    for episode in corpus:
        await store.add_episode(episode)  # idempotent — safe to re-run / share a store

    by_id = {u.id: u for u in roster}
    default = roster[0]

    results: list[CaseResult] = []
    for case in cases:
        user = _resolve_asker(case, by_id, default)
        facts = await retrieve(store, user, case.query, limit=limit)
        scored = [
            _ScoredFact(source_id=f.provenance.source_id, author=f.provenance.author) for f in facts
        ]
        results.append(_score_case(case, scored))

    overall = _metrics(results)
    by_type = {
        ct: _metrics([r for r in results if r.case_type == ct])
        for ct in CASE_TYPES
        if any(r.case_type == ct for r in results)
    }
    return EvalReport(
        n_cases=len(results),
        attribution_precision=overall.attribution_precision,
        attribution_recall=overall.attribution_recall,
        coverage=overall.coverage,
        confident_wrong_rate=overall.confident_wrong_rate,
        by_case_type=by_type,
        results=tuple(results),
    )


def format_report(report: EvalReport) -> str:
    """Render an ``EvalReport`` as a readable, terminal-friendly block."""
    lines: list[str] = []
    lines.append("=" * 78)
    lines.append("Claymore attribution eval — LongMemEval-style (in-memory store, no spend)")
    lines.append("=" * 78)
    lines.append(f"cases:                 {report.n_cases}")
    lines.append(f"attribution_precision: {report.attribution_precision:.3f}")
    lines.append(f"attribution_recall:    {report.attribution_recall:.3f}")
    lines.append(f"coverage:              {report.coverage:.3f}")
    lines.append(
        f"confident_wrong_rate:  {report.confident_wrong_rate:.3f}   "
        "<-- KILLER metric (0.0 = never a wrong attribution)"
    )
    lines.append("")
    lines.append("by case type:")
    header = f"  {'type':<16}{'n':>3}  {'prec':>6}  {'recall':>7}  {'cover':>6}  {'wrong':>6}"
    lines.append(header)
    lines.append("  " + "-" * (len(header) - 2))
    for ct in CASE_TYPES:
        m = report.by_case_type.get(ct)
        if m is None:
            continue
        lines.append(
            f"  {ct:<16}{m.n:>3}  {m.attribution_precision:>6.3f}  "
            f"{m.attribution_recall:>7.3f}  {m.coverage:>6.3f}  {m.confident_wrong_rate:>6.3f}"
        )
    lines.append("")
    lines.append("per case:")
    for r in report.results:
        flag = "WRONG" if r.confident_wrong else ("ok" if r.covered else "MISS")
        lines.append(
            f"  [{flag:>5}] {r.case_type:<15} as {r.as_user:<11} "
            f"ret={r.retrieved} correct={r.correct}/{r.expected_sources}  q={r.query!r}"
        )
        if r.note:
            lines.append(f"          {r.note}")
    lines.append("=" * 78)
    return "\n".join(lines)


async def main() -> None:
    """Seed a fresh in-memory store with the canonical corpus and print the eval report."""
    store = InMemoryMemoryStore()
    report = await run_eval(store, CASES, ROSTER)
    print(format_report(report))


if __name__ == "__main__":
    asyncio.run(main())

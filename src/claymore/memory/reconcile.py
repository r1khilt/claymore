"""[Brain] Cross-fact reconciliation pass (R12).

Compares extracted facts against each other and emits ``SUPERSEDES`` / ``CONTRADICTS`` edges.
These two edge types are *never* written at single-episode extraction time (CLAUDE.md §6,
ontology.py ``RECONCILED_EDGES``); they only exist once a new fact can be weighed against the
ones already in the graph, which is exactly what this pass does.

Scope of the deterministic (Phase-0) pass — be precise about what it does and does not do:

* It reconciles **single-valued** edges only (currently ``DECIDED`` — see
  ``SINGLE_VALUED_EDGES``) by *exact temporal ordering* on ``(subject_id, edge)`` groups: a
  later, differently-valued decision supersedes the earlier one; two concurrent differing
  decisions contradict. That is what produces the "decided X on Mar 3, superseded by Y on
  Mar 10" timeline — for single-valued edges, deterministically and reproducibly, with no model
  call and no dependence on input order.
* It deliberately does **not** reconcile narrative edges like ``SUGGESTED``. Superseding a
  suggestion with a reworded one on the same topic means matching two suggestions that share
  *meaning* but not a literal ``object_id`` — genuine semantic matching, which a deterministic
  pass legitimately cannot do (an identical ``object_id`` is reinforcement, not supersession).
  That case is deferred to the LLM-assisted semantic pass via the ``llm`` seam (accepted but not
  yet enabled). Until it lands, ``reconcile`` behaves identically whether or not an ``llm`` is
  supplied and never calls it — and no deterministic code fakes semantic supersession.

Tenant isolation (R10): reconcile only ever compares facts within a single lab. Callers MUST
pass one lab's facts — cross-lab (``group_id``) scoping happens first, before this pass (see
``domain.Visibility``: the tenant boundary is enforced separately and first). ``Fact`` carries
no ``lab_id`` (frozen contract), so as a structural backstop this pass emits a reconciled edge
only when the two contributing facts share at least one viewer (their combined, fail-closed
visibility is non-empty). Facts with disjoint need-to-know scopes therefore never cross-react,
so a ``subject_id`` collision across scopes cannot produce a cross-scope/cross-lab edge.

Security: every ``object_id`` and ``source_id`` here originates from untrusted ingested content
(SECURITY.md, lethal-trifecta). This pass treats all of it as inert data — it is grouped,
sorted, and string-formatted into edge identities, never parsed, executed, or interpreted as
instructions.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import groupby, pairwise
from typing import TYPE_CHECKING

from claymore.domain import SourcePlatform, Visibility, most_restrictive
from claymore.memory.ontology import RECONCILED_EDGES, EdgeType, Fact, Provenance

if TYPE_CHECKING:
    from claymore.ports import LLM

# Edges that hold a single *current* value per subject: a subject can only have DECIDED one
# thing at a time, so a later, different decision supersedes the earlier one and two concurrent
# different decisions contradict. Multi-valued edges (MENTIONS, USES, ...) let many distinct
# objects coexist, so they never supersede or contradict. Kept a module constant so the policy
# lives in one place (CLAUDE.md §6).
#
# SUGGESTED is intentionally NOT in this set and must not be naively added. Superseding a
# suggestion requires matching two suggestions on the SAME topic with DIFFERENT wording
# (different object_id, same meaning) — that is genuine SEMANTIC matching, which the
# deterministic pass cannot do: here an identical object_id is reinforcement, not supersession,
# and a differing object_id could be an unrelated new idea rather than a replacement. SUGGESTED
# reconciliation is the job of the LLM-assisted semantic pass via the ``llm`` seam (not yet
# enabled); do not "fix" this by dropping SUGGESTED in here (it would emit false supersessions).
SINGLE_VALUED_EDGES: frozenset[EdgeType] = frozenset({EdgeType.DECIDED})

# Reconciled edges are synthesized by Claymore, not pulled from a live source — attribute their
# provenance to the MANUAL/system platform (no dedicated "reconcile" SourcePlatform exists).
_RECONCILE_PLATFORM: SourcePlatform = SourcePlatform.MANUAL


def fact_identity(fact: Fact) -> str:
    """A stable, collision-resistant string identity for a fact-edge.

    Used as the ``subject_id`` / ``object_id`` of a reconciled edge so the graph can point
    "this later fact supersedes that earlier one" precisely. Combines the edge triple, its
    validity start, and its originating source so two facts that differ only by source do not
    collapse to the same identity. Pure data formatting — the payload fields are never
    interpreted.
    """
    prov = fact.provenance
    return "|".join(
        (
            fact.subject_id,
            fact.edge.value,
            fact.object_id,
            fact.valid_from.isoformat(),
            prov.source_platform.value,
            prov.source_id,
        )
    )


def _reconciled_edge(edge: EdgeType, *, later: Fact, earlier: Fact) -> Fact:
    """Build one reconciled edge (``later`` → ``earlier``) with merged provenance/visibility.

    Provenance records that the edge came from reconciliation, timestamped and attributed to the
    *later* contributing fact (that is the fact whose arrival triggered the finding — R12).
    Visibility is the ``most_restrictive`` of the two contributing facts (fail-closed, R13): a
    reconciled edge may be no more visible than its least-visible input.
    """
    assert edge in RECONCILED_EDGES, f"reconcile may only emit {RECONCILED_EDGES}, not {edge}"
    provenance = Provenance(
        source_platform=_RECONCILE_PLATFORM,
        source_id=f"reconcile:{edge.value}:{fact_identity(later)}=>{fact_identity(earlier)}",
        timestamp=later.provenance.timestamp,
        author=later.provenance.author,
    )
    return Fact(
        subject_id=fact_identity(later),
        edge=edge,
        object_id=fact_identity(earlier),
        valid_from=later.provenance.timestamp,
        valid_to=None,
        provenance=provenance,
        visibility=most_restrictive(later.visibility, earlier.visibility),
    )


def _shares_viewer(a: Visibility, b: Visibility) -> bool:
    """Whether at least one lab member may see BOTH facts (R10/R13 scope backstop).

    Reconciliation may relate two facts only when their combined, fail-closed visibility is
    non-empty — i.e. someone can actually see the relationship. Two facts with disjoint
    need-to-know scopes (non-overlapping ``allowed_user_ids``, neither lab-wide) share no viewer;
    relating them would emit an edge no one can see, which is both meaningless and the signature
    of a cross-lab ``subject_id`` collision (``Fact`` has no ``lab_id``). So we never emit it.
    Lab-wide-vs-restricted and overlapping-restricted scopes still share a viewer and reconcile
    normally (the edge inherits the tighter scope via ``most_restrictive``).
    """
    combined = most_restrictive(a, b)
    return combined.lab_wide or bool(combined.allowed_user_ids)


def _sort_key(fact: Fact) -> tuple[str, str, str]:
    """Deterministic within-group order: ``valid_from`` first, then object, then identity.

    ``valid_from`` is ISO-formatted so ties (equal timestamps) fall back to ``object_id`` and
    finally the full identity — giving one canonical, reproducible ordering regardless of the
    order facts were passed in.
    """
    return (fact.valid_from.isoformat(), fact.object_id, fact_identity(fact))


def reconcile(facts: Sequence[Fact], *, llm: LLM | None = None) -> list[Fact]:
    """Compare facts pairwise and return the NEW ``SUPERSEDES`` / ``CONTRADICTS`` edges (R12).

    Deterministic Phase-0 rules, applied per ``(subject_id, edge)`` group of single-valued
    edges (``SINGLE_VALUED_EDGES``):

    * **SUPERSEDES** — facts are ordered by ``valid_from`` into temporal "levels". A fact at a
      later level whose ``object_id`` differs from a fact at the immediately-preceding level
      supersedes it (``subject`` = later fact's identity, ``object`` = earlier fact's identity).
      A later fact with the *same* ``object_id`` is a reinforcement, not a supersession — no
      edge. A 3+ chain of distinct decisions yields a chain of ``SUPERSEDES`` edges.
    * **CONTRADICTS** — two facts sharing the same ``valid_from`` (concurrently valid, neither
      superseding the other in time) with different ``object_id``s contradict. Emitted once per
      pair in a canonical direction; the relationship is semantically symmetric.

    Multi-valued edges (MENTIONS, USES, ...) never supersede or contradict and are skipped.
    An edge is emitted only when the two contributing facts share at least one viewer
    (``_shares_viewer``); facts with disjoint visibility scopes never cross-react (R10 backstop —
    callers MUST still pass a single lab's facts; ``group_id`` scoping happens first).
    Inputs are never mutated (``Fact`` is frozen); only new edges are returned. Output is sorted
    into a stable order so the result is reproducible for identical inputs and independent of
    input ordering.

    ``llm`` is a forward-looking seam for a future cheap-model semantic pass and is currently
    unused — the pass is fully deterministic in Phase 0 and never calls the model.
    """
    _ = llm  # reserved for the Phase-1 semantic pass; deterministic pass ignores it (docstring)

    # Group by (subject_id, edge); only single-valued edges can supersede/contradict. Different
    # subjects never cross-react — grouping on subject_id enforces that structurally. Facts in
    # different visibility scopes are additionally filtered at emission time (_shares_viewer, R10).
    groups: dict[tuple[str, EdgeType], list[Fact]] = {}
    for fact in facts:
        if fact.edge not in SINGLE_VALUED_EDGES:
            continue
        groups.setdefault((fact.subject_id, fact.edge), []).append(fact)

    edges: list[Fact] = []
    for members in groups.values():
        ordered = sorted(members, key=_sort_key)
        # Partition into temporal levels (facts sharing a valid_from); ``ordered`` is already
        # sorted by valid_from so groupby yields contiguous, ascending levels.
        levels: list[list[Fact]] = [
            list(level) for _, level in groupby(ordered, key=lambda f: f.valid_from)
        ]

        # CONTRADICTS: within a concurrent level, every differing-object pair conflicts.
        for level in levels:
            for i in range(len(level)):
                for j in range(i + 1, len(level)):
                    earlier, later = level[i], level[j]
                    if earlier.object_id != later.object_id and _shares_viewer(
                        earlier.visibility, later.visibility
                    ):
                        edges.append(
                            _reconciled_edge(EdgeType.CONTRADICTS, later=later, earlier=earlier)
                        )

        # SUPERSEDES: across adjacent levels, a later, differently-valued fact supersedes the
        # earlier one. Same object across levels is reinforcement → no edge.
        for prev_level, curr_level in pairwise(levels):
            for curr in curr_level:
                for prev in prev_level:
                    if curr.object_id != prev.object_id and _shares_viewer(
                        curr.visibility, prev.visibility
                    ):
                        edges.append(
                            _reconciled_edge(EdgeType.SUPERSEDES, later=curr, earlier=prev)
                        )

    # Stable, input-order-independent output so reconciliation is reproducible.
    edges.sort(key=lambda f: (f.edge.value, f.subject_id, f.object_id))
    return edges

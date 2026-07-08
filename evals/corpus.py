"""Seeded, deterministic LongMemEval-style corpus for the attribution eval (R2, CLAUDE.md §8).

A synthetic lab's scattered memory (Slack / Gmail / Granola / GitHub) with **known ground
truth**: who said what, when, what was superseded, and what is private. The companion
:mod:`evals.harness` seeds a store with :data:`CORPUS`, runs :func:`claymore.memory.retrieval.
retrieve` for each :class:`EvalCase`, and scores whether retrieval returns *correctly-attributed*
facts — the #1 failure mode being confident **wrong** attribution (hard rule 1).

Design constraint (so the metrics are trustworthy, not accidental): every case's query terms are
chosen to be *distinctive* to its target episode(s). The in-memory store matches by substring on
``text + subject_id + object_id``, so a shared word would silently pull an unrelated episode into
a result set and read as a (real, but unintended) wrong attribution. Keeping anchor terms unique
per topic makes each case measure exactly what it claims to.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from claymore.auth.models import Role, User
from claymore.domain import PersonId, SourcePlatform, Visibility
from claymore.ingest.normalize import Episode

CaseType = Literal["single_hop", "multi_hop", "temporal", "knowledge_update"]

LAB = "lab1"


class EvalCase(BaseModel):
    """One attribution eval question with its known-correct grounding.

    ``expected_source_ids`` / ``expected_authors`` are the provenance a faithful answer MUST rest
    on. A retrieved fact whose ``source_id``/``author`` falls outside these sets is a *confident
    wrong attribution* — the metric that matters most. An **empty** ``expected_source_ids`` is a
    deliberate negative case (e.g. a private DM a non-participant must not see): the correct
    behaviour is to retrieve nothing at all.
    """

    model_config = ConfigDict(frozen=True)

    query: str
    expected_source_ids: frozenset[str]
    expected_authors: frozenset[PersonId]
    case_type: CaseType
    as_user: str | None = None
    """User id asking the question (indexed into the roster). ``None`` → the default asker
    (``roster[0]``, a general lab-wide member). Set it for visibility cases."""

    note: str = ""
    """Human-readable intent, surfaced in the printed report."""


# --- roster: a general member first (the default asker), then DM participants, then an outsider.
# u_maya is deliberately NOT in any DM, so lab-wide cases can never accidentally surface a private
# fact through the default asker.
def _member(user_id: str, person_id: str, role: Role = Role.MEMBER) -> User:
    return User(id=user_id, lab_id=LAB, person_id=person_id, role=role)


ROSTER: list[User] = [
    _member("u_maya", "p_maya"),
    _member("u_lucas", "p_lucas"),
    _member("u_philip", "p_philip"),
    _member("u_rotation", "p_rotation", role=Role.ROTATION_STUDENT),
]

# --- visibility scopes ---
LAB_WIDE = Visibility(lab_wide=True, source_label="#lab")
DM_LUCAS_PHILIP = Visibility(
    lab_wide=False,
    allowed_user_ids=frozenset({"u_lucas", "u_philip"}),
    source_label="DM",
)


def _episode(
    *,
    source_id: str,
    platform: SourcePlatform,
    author: PersonId,
    text: str,
    when: datetime,
    refs: tuple[str, ...] = (),
    visibility: Visibility = LAB_WIDE,
) -> Episode:
    return Episode(
        lab_id=LAB,
        source_platform=platform,
        source_id=source_id,
        author=author,
        timestamp=when,
        text=text,
        refs=refs,
        visibility=visibility,
        source_hash=source_id,  # unique content id is enough for dedup in a fixed corpus
    )


def _t(day: int) -> datetime:
    """A deterministic March-2026 timestamp (bi-temporal ordering is by this value)."""
    return datetime(2026, 3, day, 12, 0, tzinfo=UTC)


# --- the corpus: 14 episodes across 4 sources, 3 authors, spanning Mar 2-15 -------------------
CORPUS: list[Episode] = [
    # single-hop person recall
    _episode(
        source_id="slack_kelch",
        platform=SourcePlatform.SLACK,
        author="p_lucas",
        text="I suggest we test the thermostability of our lead protein this sprint.",
        when=_t(3),
        refs=("thermostability-assay",),
    ),
    # meeting recall + first leg of a multi-hop
    _episode(
        source_id="granola_roundup",
        platform=SourcePlatform.GRANOLA,
        author="p_philip",
        text="Weekly roundup: we decided to prioritize the docking pipeline milestone.",
        when=_t(5),
        refs=("docking-pipeline",),
    ),
    # second leg of the docking-pipeline multi-hop (code side)
    _episode(
        source_id="gh_docking_commit",
        platform=SourcePlatform.GITHUB,
        author="p_lucas",
        text="Refactored the docking pipeline scoring function for speed.",
        when=_t(6),
        refs=("docking-pipeline",),
    ),
    # knowledge-update chain: the earlier claim...
    _episode(
        source_id="gmail_buffer_v1",
        platform=SourcePlatform.GMAIL,
        author="p_maya",
        text="For the binding assay, use the phosphate buffer at pH 7.4.",
        when=_t(4),
        refs=("phosphate-buffer",),
    ),
    # ...and the later one that supersedes it.
    _episode(
        source_id="gmail_buffer_v2",
        platform=SourcePlatform.GMAIL,
        author="p_maya",
        text="Correction to my earlier email: switch the phosphate buffer to pH 8.0.",
        when=_t(12),
        refs=("phosphate-buffer",),
    ),
    # single-hop status
    _episode(
        source_id="slack_crispr_status",
        platform=SourcePlatform.SLACK,
        author="p_maya",
        text="Status update: the CRISPR knockout screen finished, 12 hits validated.",
        when=_t(8),
        refs=("CRISPR-screen",),
    ),
    # single-hop "did we ever test..."
    _episode(
        source_id="granola_hypothesis",
        platform=SourcePlatform.GRANOLA,
        author="p_lucas",
        text="We discussed whether the allosteric hypothesis was ever tested; it was not.",
        when=_t(9),
        refs=("allosteric-hypothesis",),
    ),
    # temporal chain #1: an older measurement...
    _episode(
        source_id="slack_titration_old",
        platform=SourcePlatform.SLACK,
        author="p_philip",
        text="Early titration run of compound XR-9 gave IC50 around 500 nM.",
        when=_t(2),
        refs=("XR-9",),
    ),
    # ...and the latest one.
    _episode(
        source_id="slack_titration_new",
        platform=SourcePlatform.SLACK,
        author="p_philip",
        text="Latest titration of compound XR-9: IC50 improved to 40 nM after reformulation.",
        when=_t(11),
        refs=("XR-9",),
    ),
    # private DM — only Lucas & Philip may see it.
    _episode(
        source_id="dm_secret",
        platform=SourcePlatform.SLACK,
        author="p_lucas",
        text="Confidential: the unpublished Nirvana scaffold binds the target at 2 nM.",
        when=_t(10),
        refs=("Nirvana-scaffold",),
        visibility=DM_LUCAS_PHILIP,
    ),
    # temporal chain #2: instrument status over time.
    _episode(
        source_id="gmail_instrument_old",
        platform=SourcePlatform.GMAIL,
        author="p_maya",
        text="The Octet instrument is down for maintenance.",
        when=_t(4),
        refs=("Octet",),
    ),
    _episode(
        source_id="gmail_instrument_new",
        platform=SourcePlatform.GMAIL,
        author="p_maya",
        text="Update: the Octet instrument is back online and calibrated.",
        when=_t(13),
        refs=("Octet",),
    ),
    # multi-hop #2: a code change...
    _episode(
        source_id="gh_boltz_pr",
        platform=SourcePlatform.GITHUB,
        author="p_philip",
        text="Added Boltz-2 structure prediction to the modeling workflow.",
        when=_t(14),
        refs=("Boltz-2",),
    ),
    # ...and the decision that adopted it.
    _episode(
        source_id="granola_boltz_decision",
        platform=SourcePlatform.GRANOLA,
        author="p_maya",
        text="In sync we decided to adopt Boltz-2 for all our modeling targets.",
        when=_t(15),
        refs=("Boltz-2",),
    ),
]


# --- the eval cases -------------------------------------------------------------------------
CASES: list[EvalCase] = [
    EvalCase(
        query="thermostability",
        expected_source_ids=frozenset({"slack_kelch"}),
        expected_authors=frozenset({"p_lucas"}),
        case_type="single_hop",
        note="Person recall: what did Lucas suggest about the protein?",
    ),
    EvalCase(
        query="roundup",
        expected_source_ids=frozenset({"granola_roundup"}),
        expected_authors=frozenset({"p_philip"}),
        case_type="single_hop",
        note="Meeting recall: what came up in the weekly roundup?",
    ),
    EvalCase(
        query="docking pipeline",
        expected_source_ids=frozenset({"granola_roundup", "gh_docking_commit"}),
        expected_authors=frozenset({"p_philip", "p_lucas"}),
        case_type="multi_hop",
        note="Multi-hop: the decision (Granola) + the commit (GitHub) both ground it.",
    ),
    EvalCase(
        query="phosphate buffer",
        expected_source_ids=frozenset({"gmail_buffer_v1", "gmail_buffer_v2"}),
        expected_authors=frozenset({"p_maya"}),
        case_type="knowledge_update",
        note="Knowledge update: v2 (pH 8.0) supersedes v1 (pH 7.4); latest sorts first.",
    ),
    EvalCase(
        query="CRISPR knockout screen",
        expected_source_ids=frozenset({"slack_crispr_status"}),
        expected_authors=frozenset({"p_maya"}),
        case_type="single_hop",
        note="Status recall.",
    ),
    EvalCase(
        query="allosteric",
        expected_source_ids=frozenset({"granola_hypothesis"}),
        expected_authors=frozenset({"p_lucas"}),
        case_type="single_hop",
        note="History: did we ever test the allosteric hypothesis?",
    ),
    EvalCase(
        query="XR-9 titration",
        expected_source_ids=frozenset({"slack_titration_old", "slack_titration_new"}),
        expected_authors=frozenset({"p_philip"}),
        case_type="temporal",
        note="Temporal: latest XR-9 IC50 should surface first over the older run.",
    ),
    EvalCase(
        query="Octet instrument",
        expected_source_ids=frozenset({"gmail_instrument_old", "gmail_instrument_new"}),
        expected_authors=frozenset({"p_maya"}),
        case_type="temporal",
        note="Temporal: current instrument status over prior status.",
    ),
    EvalCase(
        query="Boltz-2",
        expected_source_ids=frozenset({"gh_boltz_pr", "granola_boltz_decision"}),
        expected_authors=frozenset({"p_philip", "p_maya"}),
        case_type="multi_hop",
        note="Multi-hop: the PR + the adoption decision.",
    ),
    # visibility (negative): a non-participant must NOT retrieve the private DM.
    EvalCase(
        query="Nirvana",
        expected_source_ids=frozenset(),
        expected_authors=frozenset(),
        case_type="single_hop",
        as_user="u_rotation",
        note="Visibility: rotation student is not on the DM — must retrieve nothing.",
    ),
    # visibility (positive): a participant SHOULD retrieve it, correctly attributed.
    EvalCase(
        query="Nirvana",
        expected_source_ids=frozenset({"dm_secret"}),
        expected_authors=frozenset({"p_lucas"}),
        case_type="single_hop",
        as_user="u_lucas",
        note="Visibility: Lucas is on the DM — sees it, attributed to himself.",
    ),
]


def _uniqueness_selfcheck() -> None:
    """Fail loudly at import if two episodes share a distinctive query anchor (see module doc).

    This keeps the corpus honest: if someone edits an episode and accidentally reuses a term, the
    metrics would quietly degrade. Cheap to run once at import; it is the corpus's own regression
    test for the assumption every case rests on.
    """
    for case in CASES:
        if not case.expected_source_ids:
            continue  # negative case: no positive target to bound
        terms = [t for t in case.query.casefold().split() if t]
        for ep in CORPUS:
            hay = f"{ep.text} {ep.source_platform}:{ep.source_id} {' '.join(ep.refs)}".casefold()
            if any(term in hay for term in terms) and ep.source_id not in case.expected_source_ids:
                raise AssertionError(
                    f"corpus leak: query {case.query!r} matches unexpected episode "
                    f"{ep.source_id!r} (not in {sorted(case.expected_source_ids)})"
                )


_uniqueness_selfcheck()


# Re-export so callers can `from evals.corpus import ...` the whole seeded world in one import.
__all__ = [
    "CASES",
    "CORPUS",
    "DM_LUCAS_PHILIP",
    "LAB",
    "LAB_WIDE",
    "ROSTER",
    "CaseType",
    "EvalCase",
]

"""Contract tests — lock the frozen shapes so a breaking change fails CI loudly."""

from __future__ import annotations

from datetime import UTC, datetime

from claymore.actions.approvals import (
    ActionKind,
    ActionStatus,
    InMemoryApprovalGate,
    PendingAction,
)
from claymore.agent import Reply, RequestContext, handle
from claymore.auth.models import Role, User
from claymore.domain import (
    UNKNOWN_AUTHOR,
    SourcePlatform,
    Visibility,
    most_restrictive,
)
from claymore.ingest.normalize import Episode
from claymore.memory.ontology import RECONCILED_EDGES, EdgeType, Fact, Provenance

_NOW = datetime(2026, 3, 3, tzinfo=UTC)


def _episode(**kw: object) -> Episode:
    base: dict[str, object] = {
        "lab_id": "lab1",
        "source_platform": SourcePlatform.SLACK,
        "source_id": "m1",
        "timestamp": _NOW,
        "text": "Lucas suggested testing the Y hypothesis.",
        "visibility": Visibility(lab_wide=True, source_label="#protein-eng"),
    }
    base.update(kw)
    return Episode(**base)  # type: ignore[arg-type]


def test_episode_defaults_untrusted_and_unknown_author() -> None:
    ep = _episode()
    assert ep.author == UNKNOWN_AUTHOR  # never guessed (R11)
    assert ep.is_untrusted is True  # all ingested content untrusted (SECURITY rule 1)


def test_episode_is_frozen() -> None:
    ep = _episode()
    try:
        ep.text = "mutated"  # type: ignore[misc]
    except Exception:  # pydantic raises on frozen mutation
        return
    raise AssertionError("Episode must be immutable")


def test_visibility_most_restrictive_fails_closed() -> None:
    lab_wide = Visibility(lab_wide=True)
    dm = Visibility(lab_wide=False, allowed_user_ids=frozenset({"u1", "u2"}))
    # lab-wide combined with a restricted source collapses to the restricted one
    assert most_restrictive(lab_wide, dm) == dm
    # two restricted sources intersect their allowlists
    dm2 = Visibility(lab_wide=False, allowed_user_ids=frozenset({"u2", "u3"}))
    combined = most_restrictive(dm, dm2)
    assert combined.allowed_user_ids == frozenset({"u2"})


def test_visibility_can_view() -> None:
    dm = Visibility(lab_wide=False, allowed_user_ids=frozenset({"u1"}))
    assert dm.can_view("u1") is True
    assert dm.can_view("u2") is False
    assert Visibility(lab_wide=True).can_view("anyone") is True


def test_fact_carries_provenance_and_visibility() -> None:
    fact = Fact(
        subject_id="person:lucas",
        edge=EdgeType.SUGGESTED,
        object_id="hypothesis:y",
        valid_from=_NOW,
        provenance=Provenance(
            source_platform=SourcePlatform.GRANOLA, source_id="n1", timestamp=_NOW
        ),
        visibility=Visibility(lab_wide=True),
    )
    assert fact.valid_to is None
    assert EdgeType.SUPERSEDES in RECONCILED_EDGES  # written only by reconcile (R12)


def test_user_group_id_avoids_underscore_separator() -> None:
    u = User(id="u1", lab_id="lab1", person_id="person:1", role=Role.ROTATION_STUDENT)
    assert u.group_id() == "lab1:u1"  # ':' not '_' per R10 escaping note


async def test_approval_gate_flow() -> None:
    gate = InMemoryApprovalGate()
    action = PendingAction(
        token=gate.next_token(),
        lab_id="lab1",
        requested_by="u1",
        kind=ActionKind.FILE_ISSUE,
        description="File a GitHub issue titled 'Assay buffer fix'",
        payload={"title": "Assay buffer fix", "repo": "lab/protocols"},
        idempotency_key="k1",
    )
    token = await gate.request(action)
    assert [a.token for a in await gate.pending_for("u1")] == [token]
    resolved = await gate.resolve(token, approved=True, by="u1")
    assert resolved.status is ActionStatus.APPROVED
    assert await gate.pending_for("u1") == []  # no longer pending


async def test_agent_handle_stub_returns_reply() -> None:
    ctx = RequestContext(user_id="u1", lab_id="lab1", group_ids=("lab1:u1",))
    reply = await handle(ctx, "what did Lucas suggest last week?")
    assert isinstance(reply, Reply)
    assert reply.citations == ()  # stub asserts nothing (no source, no claim)

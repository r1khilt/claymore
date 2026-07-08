"""Adversarial suite for the write-back executor (CLAUDE.md §8 — break it as it's built).

The killer failures here are: executing something a human never approved (hard rule 3) and
double-filing on a retry / lost ack (idempotency). Each test drives one of those. A red test is a
real defect — fix the root cause, never weaken the test.
"""

from __future__ import annotations

import pytest

from claymore.actions.approvals import (
    ActionKind,
    ActionStatus,
    InMemoryApprovalGate,
    PendingAction,
)
from claymore.actions.writeback import (
    ActionNotApproved,
    MockActionExecutor,
    execute_approved,
)
from claymore.audit import AuditRecord, AuditSink, TrustOrigin


class RecordingAuditSink(AuditSink):
    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    async def write(self, record: AuditRecord) -> None:
        self.records.append(record)


def _action(
    *,
    token: str,
    status: ActionStatus,
    idempotency_key: str = "idem-1",
    kind: ActionKind = ActionKind.FILE_ISSUE,
) -> PendingAction:
    return PendingAction(
        token=token,
        lab_id="lab1",
        requested_by="u_lucas",
        kind=kind,
        description="File an issue",
        payload={"repo": "lab/x", "title": "t", "body": "b"},
        idempotency_key=idempotency_key,
        status=status,
    )


# --- (a)/(b) the hard gate: nothing runs without an explicit approval (hard rule 3) ---


async def test_pending_action_is_refused_executor_not_called() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    await gate.request(_action(token="A1", status=ActionStatus.PENDING))

    with pytest.raises(ActionNotApproved):
        await execute_approved(gate, executor, "A1", by="u_pi", audit=audit)

    assert executor.calls == 0
    assert executor.executed == []
    # The refusal itself is audited.
    assert audit.records and audit.records[0].detail["outcome"] == "refused"


async def test_rejected_action_is_refused() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    await gate.request(_action(token="A2", status=ActionStatus.REJECTED))

    with pytest.raises(ActionNotApproved):
        await execute_approved(gate, executor, "A2", by="u_pi", audit=audit)
    assert executor.calls == 0


# --- (c)/(d) idempotency: a key runs exactly once, even across double calls / distinct actions ---


async def test_double_call_same_token_executes_once() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    await gate.request(_action(token="A3", status=ActionStatus.APPROVED, idempotency_key="k-dup"))

    first = await execute_approved(gate, executor, "A3", by="u_pi", audit=audit)
    second = await execute_approved(gate, executor, "A3", by="u_pi", audit=audit)

    assert first.status is ActionStatus.EXECUTED
    assert second.status is ActionStatus.EXECUTED
    assert executor.calls == 1  # a lost ack / retry never double-files
    assert len(executor.executed) == 1


async def test_two_distinct_actions_same_idempotency_key_execute_once() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    # Different tokens, DIFFERENT payload-descriptions, but the SAME idempotency key: the second is
    # a duplicate of the first and must NOT re-execute (the intended replay guard is on the key).
    await gate.request(_action(token="B1", status=ActionStatus.APPROVED, idempotency_key="same"))
    await gate.request(_action(token="B2", status=ActionStatus.APPROVED, idempotency_key="same"))

    await execute_approved(gate, executor, "B1", by="u_pi", audit=audit)
    dup = await execute_approved(gate, executor, "B2", by="u_pi", audit=audit)

    assert executor.calls == 1
    assert dup.status is ActionStatus.EXECUTED
    # The duplicate returns the FIRST action that actually ran, not B2.
    assert dup.token == "B1"
    assert audit.records[-1].detail["outcome"] == "duplicate"


async def test_seen_set_persists_dedup_across_gates() -> None:
    """A caller-supplied ``seen`` ledger blocks re-execution even on a fresh gate (restart)."""
    seen: set[str] = set()
    audit = RecordingAuditSink()

    gate1 = InMemoryApprovalGate()
    executor1 = MockActionExecutor()
    await gate1.request(_action(token="C1", status=ActionStatus.APPROVED, idempotency_key="p"))
    await execute_approved(gate1, executor1, "C1", by="u_pi", audit=audit, seen=seen)
    assert executor1.calls == 1
    assert "p" in seen

    gate2 = InMemoryApprovalGate()  # fresh gate, no in-memory ledger
    executor2 = MockActionExecutor()
    await gate2.request(_action(token="C2", status=ActionStatus.APPROVED, idempotency_key="p"))
    result = await execute_approved(gate2, executor2, "C2", by="u_pi", audit=audit, seen=seen)
    assert executor2.calls == 0  # blocked by the persistent seen ledger
    assert result.status is ActionStatus.EXECUTED


# --- (e) executor failure: FAILED, audited, no partial double-execute ---


async def test_executor_failure_marks_failed_and_audits() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor(failing_kinds={ActionKind.FILE_ISSUE})
    audit = RecordingAuditSink()
    await gate.request(_action(token="D1", status=ActionStatus.APPROVED, idempotency_key="f"))

    result = await execute_approved(gate, executor, "D1", by="u_pi", audit=audit)

    assert result.status is ActionStatus.FAILED
    assert executor.calls == 1
    assert executor.executed == []  # never recorded as a success
    assert audit.records[-1].detail["outcome"] == "failed"
    assert audit.records[-1].trust_origin is TrustOrigin.USER

    # A failure is retryable (not added to the done-ledger): a retry re-invokes the executor.
    retry_executor = MockActionExecutor()
    retry = await execute_approved(gate, retry_executor, "D1", by="u_pi", audit=audit)
    assert retry.status is ActionStatus.EXECUTED
    assert retry_executor.calls == 1


# --- (f) unknown token surfaces as KeyError ---


async def test_unknown_token_raises_keyerror() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    with pytest.raises(KeyError):
        await execute_approved(gate, executor, "nope", by="u_pi", audit=audit)
    assert executor.calls == 0

"""Unit tests for the write-back executor — the approved-action execution half (hard rules 3/5).

Happy path: propose -> request -> approve -> execute exactly once, with a result, an audit
record, an EXECUTED end state, and a single recorded executor call.
"""

from __future__ import annotations

from claymore.actions.approvals import ActionStatus, InMemoryApprovalGate
from claymore.actions.writeback import MockActionExecutor, execute_approved
from claymore.agent.tools import propose_file_issue
from claymore.audit import AuditRecord, AuditSink, TrustOrigin
from tests.fixtures import make_user


class RecordingAuditSink(AuditSink):
    """Captures audit records so tests can assert the trail (the dev sink only logs)."""

    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    async def write(self, record: AuditRecord) -> None:
        self.records.append(record)


async def _approved_issue(gate: InMemoryApprovalGate) -> str:
    """Propose a file-issue action, register it under a real SMS token, and approve it."""
    user = make_user("u_lucas")
    proposed = propose_file_issue(user, repo="lab/claymore", title="Test Y", body="Details.")
    token = gate.next_token()
    await gate.request(proposed.model_copy(update={"token": token}))
    await gate.resolve(token, approved=True, by="u_pi")
    return token


async def test_execute_approved_runs_once_and_audits() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    token = await _approved_issue(gate)

    result = await execute_approved(gate, executor, token, by="u_pi", audit=audit)

    # Ends EXECUTED; the executor ran exactly once.
    assert result.status is ActionStatus.EXECUTED
    assert executor.calls == 1
    assert len(executor.executed) == 1
    assert executor.executed[0].token == token

    # An audit record was written for the (single) attempt, attributed to the human approver.
    assert len(audit.records) == 1
    rec = audit.records[0]
    assert rec.actor == "u_pi"
    assert rec.action == "action.file_issue"
    assert rec.trust_origin is TrustOrigin.USER
    assert rec.detail["outcome"] == "executed"
    assert rec.detail["token"] == token
    assert rec.detail["result_url"].startswith("mock://file_issue/")


async def test_execute_approved_returns_deterministic_result_handle() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    token = await _approved_issue(gate)

    action = await gate.get(token)
    assert action is not None
    result_url = f"mock://file_issue/{action.idempotency_key[:12]}"

    await execute_approved(gate, executor, token, by="u_pi", audit=audit)
    assert audit.records[0].detail["result_url"] == result_url


async def test_already_executed_action_is_a_logged_noop() -> None:
    gate = InMemoryApprovalGate()
    executor = MockActionExecutor()
    audit = RecordingAuditSink()
    token = await _approved_issue(gate)

    first = await execute_approved(gate, executor, token, by="u_pi", audit=audit)
    assert first.status is ActionStatus.EXECUTED

    # Same token again -> idempotent no-op, executor not called a second time.
    second = await execute_approved(gate, executor, token, by="u_pi", audit=audit)
    assert second.status is ActionStatus.EXECUTED
    assert executor.calls == 1

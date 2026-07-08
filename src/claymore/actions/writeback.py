"""The write-back executor — the "you just approve" *execution* half (CLAUDE.md §1 feat 3).

:mod:`claymore.actions.approvals` owns the *decision* (a human ✅/❌ over an exact payload). This
module owns what happens *after* an approval: a proposed action is executed **exactly once** and
every attempt is audited. The hard rules that shape it:

* **Nothing unapproved runs (hard rule 3).** :func:`execute_approved` is a closed gate — it only
  calls the executor when ``action.status == APPROVED``. PENDING/REJECTED/EXPIRED/FAILED are
  refused; an already-EXECUTED action is a logged no-op.
* **Exactly once (R-idempotency, approvals.py docstring).** A lost ack / double call must never
  double-file. We dedup on ``action.idempotency_key``: the first success is recorded in a
  per-gate ledger and every later call with the same key returns that recorded action without
  re-executing — even if it's a *different* ``PendingAction`` that happens to carry the same key.
* **Everything auditable (hard rule 5).** Every attempt — executed, duplicate, refused, failed —
  writes an :class:`~claymore.audit.AuditRecord` with ``trust_origin=USER`` (a human approved it).
  Only non-secret handles (ids/urls) ever enter the audit detail.
* **The executor is the Composio seam (hard rule 7).** It works only on the structured,
  provenance-tagged ``PendingAction.payload``; it never parses that payload as instructions.

**Executed-state / idempotency approach (and why approvals.py is untouched).**
``PendingAction`` is a frozen contract and ``InMemoryApprovalGate`` has no "mark executed"
transition — both are shared by Pipes and Brain, so changing them would be a two-party contract
change. Instead the terminal (EXECUTED) state lives *in this layer*, keyed by the gate instance in
a :class:`weakref.WeakKeyDictionary` (``idempotency_key -> executed PendingAction``). This is
per-gate, not a global module guard, and is GC'd with the gate. Idempotency therefore works out of
the box with ``seen=None``. A caller that needs dedup to survive a process restart (or to be
shared across gates) may pass its own persistent ``seen`` set of idempotency keys; we consult it
and keep it in sync. We return an *updated copy* of the action with ``status=EXECUTED`` rather than
mutating the gate — approvals.py stays exactly as-is.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from weakref import WeakKeyDictionary

from claymore.actions.approvals import (
    ActionKind,
    ActionStatus,
    ApprovalGate,
    PendingAction,
)
from claymore.audit import AuditRecord, AuditSink, TrustOrigin
from claymore.domain import UserId
from claymore.logging import get_logger

_log = get_logger("writeback")

# Outcomes recorded in the audit detail (one per execute_approved attempt).
_EXECUTED = "executed"
_DUPLICATE = "duplicate"
_REFUSED = "refused"
_FAILED = "failed"


class ActionNotApproved(RuntimeError):
    """Raised when :func:`execute_approved` is asked to run a not-approved action (hard rule 3)."""

    def __init__(self, token: str, status: ActionStatus) -> None:
        super().__init__(
            f"action {token!r} is {status.value!r}, not 'approved' — refusing to execute"
        )
        self.token = token
        self.status = status


class ActionExecutor(ABC):
    """The Composio seam: perform the concrete side effect for an approved action.

    Implementations file the issue / send the draft / create the page and return a small result
    dict of non-secret handles (e.g. ``{"url": ...}``). They operate only on the structured
    ``PendingAction.payload`` and must never treat it as instructions (hard rule 7).
    """

    @abstractmethod
    async def execute(self, action: PendingAction) -> dict[str, str]:
        """Run the side effect; return a result dict. Raise on failure (caller marks FAILED)."""


class MockActionExecutor(ActionExecutor):
    """No-side-effect executor for dev/tests. Records what it ran; returns a deterministic result.

    ``executed`` holds every *successfully* executed action; ``calls`` counts every invocation
    (including ones that raise), so tests can prove "called exactly once". Configure
    ``failing_kinds`` to exercise the failure path without any real I/O.
    """

    def __init__(self, *, failing_kinds: set[ActionKind] | None = None) -> None:
        self.executed: list[PendingAction] = []
        self.calls = 0
        self._failing_kinds = failing_kinds or set()

    async def execute(self, action: PendingAction) -> dict[str, str]:
        self.calls += 1
        if action.kind in self._failing_kinds:
            raise RuntimeError(f"mock executor configured to fail for {action.kind.value!r}")
        self.executed.append(action)
        return {
            "status": "ok",
            "kind": action.kind.value,
            "url": f"mock://{action.kind.value}/{action.idempotency_key[:12]}",
        }


# Per-gate terminal-state ledger: idempotency_key -> executed PendingAction. Keyed weakly by the
# gate so it is scoped to that gate and cleaned up with it (never a global dedup guard).
_ledgers: WeakKeyDictionary[ApprovalGate, dict[str, PendingAction]] = WeakKeyDictionary()


def _ledger(gate: ApprovalGate) -> dict[str, PendingAction]:
    ledger = _ledgers.get(gate)
    if ledger is None:
        ledger = {}
        _ledgers[gate] = ledger
    return ledger


async def _audit(
    audit: AuditSink,
    action: PendingAction,
    by: UserId,
    outcome: str,
    *,
    error: str | None = None,
    result: dict[str, str] | None = None,
) -> None:
    """Write one audit record for an execution attempt. Only non-secret handles enter ``detail``."""
    detail = {
        "token": action.token,
        "idempotency_key": action.idempotency_key,
        "outcome": outcome,
    }
    if error is not None:
        detail["error"] = error  # exception *type*, never a payload/secret
    if result is not None:
        detail["result_url"] = result.get("url", "")
    await audit.write(
        AuditRecord(
            lab_id=action.lab_id,
            actor=by,
            action=f"action.{action.kind.value}",
            trust_origin=TrustOrigin.USER,  # a human explicitly approved this write
            detail=detail,
        )
    )


async def execute_approved(
    gate: ApprovalGate,
    executor: ActionExecutor,
    token: str,
    *,
    by: UserId,
    audit: AuditSink,
    seen: set[str] | None = None,
) -> PendingAction:
    """Execute an approved action exactly once, auditing every attempt.

    Returns the action in its resulting terminal state:

    * EXECUTED on the first successful run (and on any later duplicate call — same object);
    * FAILED if the executor raised (not recorded as done, so a transient failure stays
      retryable — the caller inspects ``.status`` and can surface/retry);

    Raises :class:`KeyError` if ``token`` is unknown, and :class:`ActionNotApproved` if the action
    is PENDING/REJECTED/EXPIRED/FAILED (never executes an unapproved action — hard rule 3).
    """
    action = await gate.get(token)
    if action is None:
        raise KeyError(token)  # caller surfaces "no such action"

    key = action.idempotency_key
    ledger = _ledger(gate)

    # IDEMPOTENCY (before the status gate): a key that already succeeded never runs again — even
    # for a different PendingAction that carries the same key (the intended replay/double guard).
    done = ledger.get(key)
    if done is None and seen is not None and key in seen:
        # Caller's persistent ledger says this ran, but we hold no cached copy (e.g. after a
        # restart): still refuse to re-execute; best-effort report it as EXECUTED.
        done = action.model_copy(update={"status": ActionStatus.EXECUTED})
    if done is not None:
        await _audit(audit, action, by, _DUPLICATE)
        _log.info("writeback.duplicate", token=token, idempotency_key=key)
        return done

    # HARD GATE: only an explicitly human-approved action may run.
    if action.status is ActionStatus.EXECUTED:
        _log.info("writeback.already_executed", token=token)
        return action  # logged no-op, never a re-run
    if action.status is not ActionStatus.APPROVED:
        await _audit(audit, action, by, _REFUSED)
        _log.warning("writeback.refused", token=token, status=action.status.value)
        raise ActionNotApproved(token, action.status)

    # Execute exactly once via the Composio seam.
    try:
        result = await executor.execute(action)
    except Exception as exc:  # vendor-seam boundary: any executor failure -> FAILED, audited
        await _audit(audit, action, by, _FAILED, error=type(exc).__name__)
        _log.warning("writeback.failed", token=token, error=type(exc).__name__)
        return action.model_copy(update={"status": ActionStatus.FAILED})

    executed = action.model_copy(update={"status": ActionStatus.EXECUTED})
    ledger[key] = executed
    if seen is not None:
        seen.add(key)
    await _audit(audit, action, by, _EXECUTED, result=result)
    _log.info("writeback.executed", token=token, idempotency_key=key)
    return executed

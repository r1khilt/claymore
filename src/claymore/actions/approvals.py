"""The human-approval gate — "you just approve" (BUILD_PLAN.md §4.5a, SECURITY.md rule 3).

No consequential action (a write-back, a spend-incurring run, a physical protocol) executes
without an explicit human ✅ showing the exact payload. This module owns the *contract* — the
``PendingAction`` shape and the ``ApprovalGate`` interface — plus an in-memory reference gate
for dev/tests. The Postgres-backed gate and the Composio execution land in Phase 2.5.

Approval must work on the prod channel: **Twilio SMS has no buttons**, so each pending action
gets a short numbered token (``A3``) the user references in a free-text reply (WORKPLAN §; §4.5a).
Every write carries an idempotency key so a lost ack can't double-file.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from claymore.domain import LabId, UserId


class ActionKind(StrEnum):
    """What the agent proposes to do. Base write-backs + bio execution (gated)."""

    DRAFT_REPLY = "draft_reply"
    FILE_ISSUE = "file_issue"
    CREATE_PAGE = "create_page"
    MAKE_LINK = "make_link"
    POST_RESULT = "post_result"
    RUN_COMPUTE = "run_compute"
    PROPOSE_PROTOCOL = "propose_protocol"
    PHYSICAL_RUN = "physical_run"  # wet-lab; hardest gate (hard rule 2)


class ActionStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTED = "executed"
    FAILED = "failed"
    EXPIRED = "expired"


class PendingAction(BaseModel):
    """A proposed action awaiting a human ✅/❌. The ``payload`` is the exact thing that runs."""

    model_config = ConfigDict(frozen=True)

    token: str
    """Short, human-typeable id for SMS (e.g. ``"A3"``)."""

    lab_id: LabId
    requested_by: UserId
    kind: ActionKind
    description: str
    """Plain-language "here's exactly what will happen", shown to the human."""

    payload: dict[str, str]
    """The concrete parameters the executor will use (issue title/body, email to/subject, …)."""

    idempotency_key: str
    """Guards against double-execution on retry / lost ack. Executors must honor it."""

    status: ActionStatus = ActionStatus.PENDING
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    resolved_by: UserId | None = None


class ApprovalGate(ABC):
    """Stores pending actions and records human decisions. Read-only queries are never gated."""

    @abstractmethod
    async def request(self, action: PendingAction) -> str:
        """Record a proposed action; return its token to surface to the human."""

    @abstractmethod
    async def resolve(self, token: str, *, approved: bool, by: UserId) -> PendingAction:
        """Apply a human decision. Raises ``KeyError`` if the token is unknown/expired."""

    @abstractmethod
    async def get(self, token: str) -> PendingAction | None:
        """Look up a pending action by token."""

    @abstractmethod
    async def pending_for(self, user_id: UserId) -> list[PendingAction]:
        """All still-pending actions for a user (so a bare "yes" can resolve a lone one)."""


class InMemoryApprovalGate(ApprovalGate):
    """Dev/test reference gate. NOT for prod — the real gate is Postgres-backed (Phase 2.5).

    Lets Pipes wire the messaging↔approval loop and Brain wire the agent↔approval loop against a
    working stub before the DB layer exists.
    """

    def __init__(self) -> None:
        self._by_token: dict[str, PendingAction] = {}
        self._counter = 0

    def next_token(self) -> str:
        self._counter += 1
        return f"A{self._counter}"

    async def request(self, action: PendingAction) -> str:
        self._by_token[action.token] = action
        return action.token

    async def resolve(self, token: str, *, approved: bool, by: UserId) -> PendingAction:
        action = self._by_token[token]  # KeyError if unknown — caller surfaces it
        status = ActionStatus.APPROVED if approved else ActionStatus.REJECTED
        updated = action.model_copy(update={"status": status, "resolved_by": by})
        self._by_token[token] = updated
        return updated

    async def get(self, token: str) -> PendingAction | None:
        return self._by_token.get(token)

    async def pending_for(self, user_id: UserId) -> list[PendingAction]:
        return [
            a
            for a in self._by_token.values()
            if a.requested_by == user_id and a.status == ActionStatus.PENDING
        ]

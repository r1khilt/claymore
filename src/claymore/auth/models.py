"""User / lab / scope model — the enrollment + permission shapes (SECURITY.md §6/§8, R13).

Pipes authenticates the human at the messaging edge (map an enrolled phone/handle → a
``User``); Brain enforces scope at retrieval (``group_id`` tenant boundary + ``Visibility``
need-to-know). Both sides share these shapes. This is a domain contract, not the DB layer — the
Postgres/ORM persistence for these lands in the state layer (Phase 0/1).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from claymore.domain import LabId, PersonId, SourcePlatform, UserId


class Role(StrEnum):
    """Coarse RBAC. Write-actions and execution gate on role; a rotation student ≠ the PI."""

    PI = "pi"
    MEMBER = "member"
    ROTATION_STUDENT = "rotation_student"
    ADMIN = "admin"


class Lab(BaseModel):
    """A tenant. Its graph is isolated per lab (``graph_name``/``group_id``, R10)."""

    model_config = ConfigDict(frozen=True)

    id: LabId
    name: str


class User(BaseModel):
    """An enrolled lab member. Unknown senders/numbers are untrusted and non-privileged
    (SECURITY.md §8) — they are simply absent from this table until enrolled."""

    model_config = ConfigDict(frozen=True)

    id: UserId
    lab_id: LabId
    person_id: PersonId
    """Links the account to the canonical graph ``Person`` (identity resolution, R11)."""

    role: Role = Role.MEMBER
    phone: str | None = None
    """Verified, enrolled number for the SMS/chat interface. Caller-ID alone is never trust."""

    platform_handles: dict[SourcePlatform, str] = Field(default_factory=dict)
    """Seed for identity resolution: this member's Slack/GitHub/email handles (R11)."""

    def group_id(self) -> str:
        """Per-user scope tag used inside the lab's graph (R13). Avoids ``_`` per R10 escaping
        note by using ``:`` as the separator."""
        return f"{self.lab_id}:{self.id}"

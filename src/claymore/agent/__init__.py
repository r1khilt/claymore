"""The agent entrypoint — the handoff from messaging (Pipes) to the agent (Brain).

``handle(ctx, text) -> Reply`` is the frozen contract: ``messaging/`` calls it with an inbound
message and renders the ``Reply``. Pipes builds against the stub below; Brain replaces the stub
body with the real Claude tool-loop (``router.py``) without changing this signature.

Every asserted fact in a ``Reply`` must carry a ``Citation`` — the grounding rule (hard rule 1).
No source → don't assert it.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from claymore.actions.approvals import PendingAction
from claymore.domain import LabId, PersonId, SourcePlatform, UserId


class RequestContext(BaseModel):
    """Who is asking, scoped. Retrieval filters on ``group_ids`` + visibility (R13)."""

    model_config = ConfigDict(frozen=True)

    user_id: UserId
    lab_id: LabId
    group_ids: tuple[str, ...]
    """Explicit scope tags this user may read within the lab — never empty, never global."""


class Citation(BaseModel):
    """The attributed source behind a claim (platform + id + author + when)."""

    model_config = ConfigDict(frozen=True)

    source_platform: SourcePlatform
    source_id: str
    author: PersonId
    timestamp: datetime
    quote: str = ""


class Reply(BaseModel):
    """The agent's answer. ``pending_action`` is set when the agent proposes a write to approve."""

    model_config = ConfigDict(frozen=True)

    text: str
    citations: tuple[Citation, ...] = ()
    pending_action: PendingAction | None = None


async def handle(ctx: RequestContext, text: str) -> Reply:
    """Route an inbound message to an answer/action.

    STUB: returns an honest placeholder so Pipes can wire the messaging round-trip before the
    Brain agent exists. Replace the body (not the signature) with the Claude tool-loop in Phase 2.
    """
    return Reply(text="Claymore is scaffolded but the agent isn't wired yet — coming in Phase 2.")

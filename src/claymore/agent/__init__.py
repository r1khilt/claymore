"""The agent entrypoint — the handoff from messaging (Pipes) to the agent (Brain).

``handle(ctx, text) -> Reply`` is the frozen contract: ``messaging/`` calls it with an inbound
message and renders the ``Reply``. Pipes builds against the stub below; Brain replaces the stub
body with the real Claude tool-loop (``router.py``) without changing this signature.

Every asserted fact in a ``Reply`` must carry a ``Citation`` — the grounding rule (hard rule 1).
No source → don't assert it.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

from claymore.actions.approvals import PendingAction
from claymore.domain import LabId, PersonId, SourcePlatform, UserId

if TYPE_CHECKING:  # avoid an import cycle: router imports the contracts defined in this module.
    from claymore.agent.router import AgentRuntime


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


# Module-level runtime holder. ``handle()``'s signature is frozen, so its dependencies (store,
# llm, conversations) are injected via a runtime set here — either explicitly by the host at
# startup (``set_runtime``) or lazily as an all-in-memory default (``default_runtime``).
_runtime: AgentRuntime | None = None


def set_runtime(runtime: AgentRuntime) -> None:
    """Install the runtime ``handle()`` should use (call once at startup with real adapters)."""
    global _runtime
    _runtime = runtime


def get_runtime() -> AgentRuntime:
    """Return the installed runtime, lazily building an in-memory default on first use."""
    global _runtime
    if _runtime is None:
        from claymore.agent.router import default_runtime

        _runtime = default_runtime()
    return _runtime


async def handle(ctx: RequestContext, text: str) -> Reply:
    """Route an inbound message to an attributed answer (the "Ask" loop).

    Delegates to ``router.answer`` using the installed :class:`~claymore.agent.router.AgentRuntime`.
    Grounding is enforced there (hard rule 1): an ungrounded question yields an honest no-answer
    with zero citations, and citations always come from retrieval provenance, never the model.
    """
    from claymore.agent.router import answer

    return await answer(get_runtime(), ctx, text)

"""Web UI agent endpoint — the streaming Claude tool loop behind the Composer chat.

``POST /api/agent`` runs the real multi-tool agent (``agent_loop.run_agent``) and streams each
:class:`~claymore.agent.agent_loop.AgentEvent` back as Server-Sent Events (``data: {json}\\n\\n``,
camelCase to match the TypeScript client). Unlike ``/api/ask`` (one attributed answer), this is
the interactive surface: thoughts, tool start/end, an answer with citations, an Opentrons protocol
spec, a bio-analysis card.

It is **doubly gated** and fail-closed: it only runs when ``WEB_API_ENABLED`` is on *and* an
Anthropic key is configured (the loop calls the real model — there is no keyless path here). When
either is missing it streams a single ``error`` event and closes, so the web UI degrades to its
mock data with a clear reason rather than hanging. As with ``/api/ask``, it answers as one
configured demo identity (``WEB_USER_ID`` / ``WEB_LAB_ID``) with no per-message channel auth, and
all retrieval scoping + grounding + the human-gate rules still hold inside the loop (R10/R13,
hard rules 1/3/7).

The store is the shared runtime store (``agent.get_runtime().store``) — the same instance the
admin ingest routes and ``/api/ask`` use, so a search here sees what was ingested (see
``api/runtime.py``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from claymore.agent import RequestContext, get_runtime
from claymore.agent.agent_loop import ErrorEvent, event_json, run_agent
from claymore.config import get_settings
from claymore.logging import get_logger

_log = get_logger("api.agent")

router = APIRouter()

_UNAVAILABLE = (
    "agent unavailable — set WEB_API_ENABLED + ANTHROPIC_API_KEY, "
    "the web UI runs on mock data without it"
)


class AgentRequest(BaseModel):
    query: str


def _sse(data: str) -> str:
    """Frame one JSON payload as an SSE ``data:`` event (blank line terminates the event)."""
    return f"data: {data}\n\n"


async def _error_stream(message: str) -> AsyncIterator[str]:
    """A one-event stream: emit an ``error`` and close (the fail-closed / gated path)."""
    yield _sse(event_json(ErrorEvent(message=message)))


async def _event_stream(query: str) -> AsyncIterator[str]:
    """Drive the agent loop and frame each event as SSE. Loop errors surface as an ``error`` event
    rather than a dropped connection, so the client always sees a clean terminal state."""
    settings = get_settings()
    store = get_runtime().store
    ctx = RequestContext(
        user_id=settings.web_user_id,
        lab_id=settings.web_lab_id,
        group_ids=(settings.web_lab_id,),
    )
    _log.info("web.agent.start", chars=len(query))
    try:
        async for event in run_agent(ctx, query, store, settings):
            yield _sse(event_json(event))
    except Exception as exc:  # never leak internals; give the client a terminal error event
        _log.exception("web.agent.failed")
        yield _sse(event_json(ErrorEvent(message=f"agent error: {str(exc)[:200]}")))


@router.post("/api/agent")
async def agent(body: AgentRequest) -> StreamingResponse:
    settings = get_settings()
    query = body.query.strip()
    if not settings.web_api_enabled or not settings.anthropic_api_key.get_secret_value():
        return StreamingResponse(_error_stream(_UNAVAILABLE), media_type="text/event-stream")
    if not query:
        return StreamingResponse(
            _error_stream("empty query"), media_type="text/event-stream"
        )
    return StreamingResponse(_event_stream(query), media_type="text/event-stream")

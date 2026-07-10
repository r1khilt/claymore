"""Web UI agent endpoint — the streaming Claude tool loop behind the Composer chat.

``POST /api/agent`` runs the restricted Claude Agent SDK runtime
(``sdk_loop.run_sdk_agent``) and streams each :class:`~claymore.agent.agent_loop.AgentEvent` back
as Server-Sent Events (``data: {json}\\n\\n``, camelCase to match the TypeScript client). Unlike
``/api/ask`` (one attributed answer), this is the interactive surface: thoughts, tool start/end,
an answer with citations, an Opentrons protocol spec, and analysis cards. If the optional Agent
SDK cannot import or start, the endpoint falls back to the existing direct Messages loop with the
same restricted tool allowlist; it never falls back after the SDK has emitted an event.

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
from pydantic import BaseModel, SecretStr

from claymore import local_store
from claymore.agent import RequestContext, get_runtime
from claymore.agent.agent_loop import (
    AgentEvent,
    DoneEvent,
    ErrorEvent,
    ThoughtEvent,
    event_json,
    run_agent,
)
from claymore.agent.sdk_loop import SAFE_TOOL_NAMES, AgentSdkUnavailable, run_sdk_agent
from claymore.config import Settings, get_settings
from claymore.logging import get_logger

_log = get_logger("api.agent")

router = APIRouter()

_UNAVAILABLE = (
    "agent unavailable — set WEB_API_ENABLED and provide an Anthropic key "
    "(env ANTHROPIC_API_KEY or Settings → API keys); the web UI runs on mock data without it"
)


def _effective_key(settings: Settings) -> str:
    """The Anthropic key to run with: the env key, else the one saved in local Settings."""
    env_key = settings.anthropic_api_key.get_secret_value()
    return env_key or local_store.stored_anthropic_key()


def _settings_with_key(settings: Settings, key: str) -> Settings:
    """A copy of settings whose Anthropic key is ``key`` (frozen model → ``model_copy``)."""
    if key == settings.anthropic_api_key.get_secret_value():
        return settings
    return settings.model_copy(update={"anthropic_api_key": SecretStr(key)})


class AgentRequest(BaseModel):
    query: str


def _sse(data: str) -> str:
    """Frame one JSON payload as an SSE ``data:`` event (blank line terminates the event)."""
    return f"data: {data}\n\n"


async def _error_stream(message: str) -> AsyncIterator[str]:
    """A one-event stream: emit an ``error`` and close (the fail-closed / gated path)."""
    yield _sse(event_json(ErrorEvent(message=message)))


async def _event_stream(query: str, settings: Settings) -> AsyncIterator[str]:
    """Drive the agent loop and frame each event as SSE. Loop errors surface as an ``error`` event
    rather than a dropped connection, so the client always sees a clean terminal state. The
    terminal ``done``/``error`` events are also recorded into the local metrics/error store."""
    store = get_runtime().store
    ctx = RequestContext(
        user_id=settings.web_user_id,
        lab_id=settings.web_lab_id,
        group_ids=(settings.web_lab_id,),
    )
    max_iters, max_tokens = local_store.reasoning_budget()
    _log.info("web.agent.start", chars=len(query))

    def record(event: AgentEvent) -> None:
        if isinstance(event, DoneEvent):
            local_store.record_run(
                input_tokens=event.input_tokens,
                output_tokens=event.output_tokens,
                tool_calls=event.tool_calls,
                tool_counts=event.tool_counts,
                model=settings.query_model,
            )
        elif isinstance(event, ErrorEvent):
            local_store.record_error(event.message, context="agent.loop")

    sdk_emitted = False
    try:
        try:
            async for event in run_sdk_agent(
                ctx, query, store, settings, max_iterations=max_iters, max_tokens=max_tokens
            ):
                sdk_emitted = True
                record(event)
                yield _sse(event_json(event))
            return
        except AgentSdkUnavailable as exc:
            _log.warning(
                "web.agent.sdk_unavailable",
                error_type=type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__,
                partial=sdk_emitted,
            )
            if sdk_emitted:
                event = ErrorEvent(
                    message="Claude Agent SDK became unavailable before the request completed."
                )
                record(event)
                yield _sse(event_json(event))
                return

        # Compatibility only: this path is entered solely when the SDK cannot import/start, and
        # receives the same restricted tool surface (no ingest, no live Claude Science).
        notice = ThoughtEvent(
            text="Claude Agent SDK is unavailable; using the restricted compatibility loop."
        )
        yield _sse(event_json(notice))
        async for event in run_agent(
            ctx,
            query,
            store,
            settings,
            max_iterations=max_iters,
            max_tokens=max_tokens,
            allowed_tool_names=SAFE_TOOL_NAMES,
        ):
            record(event)
            yield _sse(event_json(event))
    except Exception as exc:  # never leak internals; give the client a terminal error event
        _log.exception("web.agent.failed")
        local_store.record_error(f"agent error: {str(exc)[:200]}", context="agent.stream")
        yield _sse(event_json(ErrorEvent(message=f"agent error: {str(exc)[:200]}")))


@router.post("/api/agent")
async def agent(body: AgentRequest) -> StreamingResponse:
    settings = get_settings()
    query = body.query.strip()
    key = _effective_key(settings)
    if not settings.web_api_enabled or not key:
        return StreamingResponse(_error_stream(_UNAVAILABLE), media_type="text/event-stream")
    if not query:
        return StreamingResponse(_error_stream("empty query"), media_type="text/event-stream")
    return StreamingResponse(
        _event_stream(query, _settings_with_key(settings, key)), media_type="text/event-stream"
    )

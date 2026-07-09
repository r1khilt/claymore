"""Web UI ask endpoint — the browser front-end's link to the real Ask loop.

``POST /api/ask`` runs the same attributed retrieval + grounded-answer loop the Telegram bot
uses (``agent.handle``) and returns the ``Reply`` as camelCase JSON the ``web/`` client
consumes. It is **off by default** (``WEB_API_ENABLED=false``); enable it only for local dev or
a trusted deployment, because — unlike Telegram — it carries no per-message channel auth and
answers as a single configured demo identity (``WEB_USER_ID`` / ``WEB_LAB_ID``). Scoping,
grounding and anti-fabrication are still enforced inside the loop (R10/R13, hard rule 1): an
ungrounded question returns an honest no-answer with zero citations.
"""

from __future__ import annotations

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from claymore.actions.approvals import PendingAction
from claymore.agent import Citation, Reply, RequestContext, handle
from claymore.config import get_settings
from claymore.logging import get_logger

_log = get_logger("api.ask")

router = APIRouter()


class AskRequest(BaseModel):
    query: str


class _CamelModel(BaseModel):
    """Serialize to camelCase so the TypeScript client's shapes match 1:1."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CitationOut(_CamelModel):
    source_platform: str
    source_id: str
    author: str
    timestamp: str
    quote: str = ""
    source_label: str = ""


class PendingActionOut(_CamelModel):
    token: str
    kind: str
    description: str
    target: str = ""
    preview: str = ""


class AskResponse(_CamelModel):
    text: str
    citations: list[CitationOut]
    pending_action: PendingActionOut | None = None
    scope_label: str | None = None


def _citation_out(c: Citation) -> CitationOut:
    return CitationOut(
        source_platform=c.source_platform.value,
        source_id=c.source_id,
        author=c.author,
        timestamp=c.timestamp.isoformat(),
        quote=c.quote,
    )


def _action_out(a: PendingAction) -> PendingActionOut:
    target = a.payload.get("target") or a.payload.get("channel") or a.payload.get("repo") or ""
    preview = a.payload.get("body") or a.payload.get("preview") or a.description
    return PendingActionOut(
        token=a.token,
        kind=a.kind.value,
        description=a.description,
        target=target,
        preview=preview,
    )


def _to_response(reply: Reply) -> AskResponse:
    return AskResponse(
        text=reply.text,
        citations=[_citation_out(c) for c in reply.citations],
        pending_action=_action_out(reply.pending_action) if reply.pending_action else None,
    )


@router.post("/api/ask", response_model=None)
async def ask(body: AskRequest) -> Response | AskResponse:
    settings = get_settings()
    if not settings.web_api_enabled:
        return Response(status_code=404)  # off by default (fail-closed)
    query = body.query.strip()
    if not query:
        return AskResponse(text="", citations=[])
    ctx = RequestContext(
        user_id=settings.web_user_id,
        lab_id=settings.web_lab_id,
        group_ids=(settings.web_lab_id,),
    )
    reply = await handle(ctx, query)
    _log.info("web.ask", chars=len(query), citations=len(reply.citations))
    return _to_response(reply)

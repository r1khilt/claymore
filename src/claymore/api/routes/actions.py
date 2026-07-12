"""Dashboard write-back actions — the "you just approve" *execution* surface for the web UI.

``POST /api/actions/slack`` posts a grounded, human-approved draft to Slack via Composio. It backs
the Projects run's one-tap **Send** (``SlackDraftBubble``): the message the user just approved is
handed to the Composio Slack send tool for the configured demo user.

Off by default (``WEB_API_ENABLED=false``) and behind the same web auth as the other dashboard
routes. The endpoint only ever forwards the structured ``{channel, text}`` — never treats it as
instructions (hard rule 7) — and returns non-secret handles (channel + message ts).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from claymore.api.routes.connectors import get_connector_manager
from claymore.config import get_settings
from claymore.ingest.composio.manager import ConnectorServiceError
from claymore.logging import get_logger

_log = get_logger("api.actions")

router = APIRouter(prefix="/api/actions", tags=["actions"])


class SlackSendRequest(BaseModel):
    channel: str
    text: str


class SlackSendResult(BaseModel):
    ok: bool
    channel: str
    ts: str = ""


@router.post("/slack", response_model=SlackSendResult)
async def send_slack(req: SlackSendRequest) -> SlackSendResult:
    """Post an approved draft to Slack via Composio. 404 when the dashboard API is disabled."""
    if not get_settings().web_api_enabled:
        raise HTTPException(status_code=404)
    try:
        result = await get_connector_manager().send_slack_message(
            channel=req.channel, text=req.text
        )
    except ConnectorServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    _log.info("api.actions.slack_sent", channel=result.get("channel", ""))
    return SlackSendResult(**result)

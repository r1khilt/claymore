"""Inbound Twilio WhatsApp webhook — the messaging edge of the Ask loop (SECURITY.md §8).

Order of operations is security-load-bearing: verify the ``X-Twilio-Signature`` **before**
trusting any form content, then authenticate the sender against the enrolled-user directory,
then (and only then) hand the text to ``agent.handle`` as data. Unknown numbers get a generic
brush-off and never reach the agent. Fail-closed everywhere: no auth token configured → every
request is rejected.

The phone→User directory is injected at startup (``set_directory``), mirroring the
``agent.set_runtime`` pattern — the Postgres-backed enrollment table plugs in here when the
state layer lands.
"""

from __future__ import annotations

from urllib.parse import parse_qsl

from fastapi import APIRouter, Request, Response

from claymore import agent
from claymore.agent import RequestContext
from claymore.config import get_settings
from claymore.logging import get_logger
from claymore.messaging import directory_from_roster, render_reply
from claymore.messaging.whatsapp import (
    PhoneDirectory,
    parse_inbound,
    twiml_message,
    verify_twilio_signature,
)

_log = get_logger("api.whatsapp")

router = APIRouter()

_NOT_ENROLLED = "This number isn't enrolled with Claymore. Ask your lab admin to add you."

_directory: PhoneDirectory | None = None


def set_directory(directory: PhoneDirectory) -> None:
    """Install the phone→enrolled-User lookup (call once at startup)."""
    global _directory
    _directory = directory


def directory_from_enrollments(spec: str) -> PhoneDirectory:
    """Build a directory from the ``WHATSAPP_ENROLLMENTS`` env roster (see
    :func:`claymore.messaging.directory_from_roster`), keyed on E.164 phone."""
    return directory_from_roster(spec, key_is_phone=True)


def _signed_url(request: Request) -> str:
    """The URL Twilio signed. Behind a proxy the request's own host is internal, so prefer the
    configured public base URL; otherwise use the request URL as seen."""
    base = get_settings().public_base_url.rstrip("/")
    if not base:
        return str(request.url)
    url = base + request.url.path
    if request.url.query:
        url += "?" + request.url.query
    return url


def _twiml(text: str) -> Response:
    return Response(content=twiml_message(text), media_type="application/xml")


@router.post("/webhooks/twilio/whatsapp")
async def inbound_whatsapp(request: Request) -> Response:
    settings = get_settings()
    auth_token = settings.twilio_auth_token.get_secret_value()

    # Twilio webhooks are strictly application/x-www-form-urlencoded — parse the raw body
    # directly (no multipart surface, no extra parser dependency).
    raw = await request.body()
    form = dict(parse_qsl(raw.decode("utf-8", errors="replace"), keep_blank_values=True))
    signature = request.headers.get("X-Twilio-Signature", "")
    if not verify_twilio_signature(auth_token, _signed_url(request), form, signature):
        _log.warning("whatsapp.webhook.rejected", reason="bad_signature")
        return Response(status_code=403)

    message = parse_inbound(form)
    if message is None:
        _log.warning("whatsapp.webhook.rejected", reason="not_whatsapp_shaped")
        return Response(status_code=400)

    user = _directory(message.phone) if _directory is not None else None
    if user is None:
        # Verified-Twilio but unenrolled sender: generic reply, no agent access, no detail leak.
        _log.info("whatsapp.inbound.unenrolled")
        return _twiml(_NOT_ENROLLED)

    ctx = RequestContext(user_id=user.id, lab_id=user.lab_id, group_ids=(user.group_id(),))
    reply = await agent.handle(ctx, message.body)
    _log.info("whatsapp.inbound.handled", user_id=user.id, lab_id=user.lab_id)
    return _twiml(render_reply(reply))

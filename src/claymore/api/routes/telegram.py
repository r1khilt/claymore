"""Inbound Telegram webhook — the messaging edge of the Ask loop (SECURITY.md §8).

Order of operations is security-load-bearing: compare the ``X-Telegram-Bot-Api-Secret-Token``
header (registered via ``setWebhook``) **before** trusting any payload, then authenticate the
sender's numeric Telegram id against the enrolled-user directory, then (and only then) hand the
text to ``agent.handle`` as data. Unknown senders get a brush-off carrying their own Telegram id
(so an admin can enroll them) and never reach the agent. Fail-closed: no secret configured →
every request rejected.

The reply is returned in the webhook response body (``method=sendMessage``) — Telegram executes
it as the bot's answer, so the happy path costs zero extra API calls. Always answer 200 once the
secret checks out: a non-2xx makes Telegram re-deliver the same update in a retry loop.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from claymore import agent
from claymore.agent import RequestContext
from claymore.config import get_settings
from claymore.logging import get_logger
from claymore.messaging import render_reply
from claymore.messaging.telegram import TelegramDirectory, parse_update, verify_webhook_secret

_log = get_logger("api.telegram")

router = APIRouter()

_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token"  # noqa: S105 (header name, not a secret)

_directory: TelegramDirectory | None = None


def set_directory(directory: TelegramDirectory) -> None:
    """Install the Telegram-id→enrolled-User lookup (call once at startup)."""
    global _directory
    _directory = directory


def _reply_into_webhook(chat_id: str, text: str) -> JSONResponse:
    """Answer by riding the webhook response (Telegram's ``method`` mechanism)."""
    return JSONResponse({"method": "sendMessage", "chat_id": chat_id, "text": text})


@router.post("/webhooks/telegram")
async def inbound_telegram(request: Request) -> Response:
    settings = get_settings()
    secret = settings.telegram_webhook_secret.get_secret_value()

    if not verify_webhook_secret(secret, request.headers.get(_SECRET_HEADER, "")):
        _log.warning("telegram.webhook.rejected", reason="bad_secret")
        return Response(status_code=403)

    try:
        update: Any = await request.json()
    except ValueError:
        _log.warning("telegram.webhook.rejected", reason="not_json")
        return Response(status_code=200)  # authenticated garbage: swallow, don't trigger retries

    message = parse_update(update) if isinstance(update, dict) else None
    if message is None:
        # A non-text update (sticker, edit, join, …) — acknowledged and ignored.
        return Response(status_code=200)

    user = _directory(message.telegram_user_id) if _directory is not None else None
    if user is None:
        # Authenticated-webhook but unenrolled sender: no agent access. Echo their own id so an
        # admin can add them to the roster; nothing about the lab leaks.
        _log.info("telegram.inbound.unenrolled")
        return _reply_into_webhook(
            message.chat_id,
            f"This account isn't enrolled with Claymore. Your Telegram id is "
            f"{message.telegram_user_id} — ask your lab admin to add you.",
        )

    ctx = RequestContext(user_id=user.id, lab_id=user.lab_id, group_ids=(user.group_id(),))
    reply = await agent.handle(ctx, message.body)
    _log.info("telegram.inbound.handled", user_id=user.id, lab_id=user.lab_id)
    return _reply_into_webhook(message.chat_id, render_reply(reply))

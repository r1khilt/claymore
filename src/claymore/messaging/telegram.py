"""[Pipes] Telegram ``MessagingChannel`` adapter — the free messaging surface (CLAUDE.md §3).

Bot API over plain httpx (no framework needed for send + webhook). Inbound updates arrive on a
webhook registered with ``setWebhook(secret_token=...)``; Telegram echoes that secret back in
the ``X-Telegram-Bot-Api-Secret-Token`` header on every delivery, which we compare in constant
time before reading any content (SECURITY.md §8). The sender's numeric Telegram user id must
resolve to an enrolled lab user — unknown ids get a brush-off that includes their own id so an
admin can enroll them, and never reach the agent.

The reply rides back in the webhook HTTP response itself (Telegram's "reply into the webhook"
mechanism: a JSON body with ``method=sendMessage``) — zero extra round trips.
"""

from __future__ import annotations

import hmac
from collections.abc import Callable, Mapping
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from claymore.auth.models import User
from claymore.logging import get_logger
from claymore.ports import MessagingChannel

_log = get_logger("messaging.telegram")

_TELEGRAM_API = "https://api.telegram.org"
# Telegram caps a message at 4096 chars; longer replies are sent as ordered chunks.
_MAX_BODY_CHARS = 4096

# Numeric Telegram user id (as a string) → enrolled User, or None (SECURITY.md §8).
TelegramDirectory = Callable[[str], User | None]


def verify_webhook_secret(configured: str, received: str) -> bool:
    """Constant-time check of ``X-Telegram-Bot-Api-Secret-Token``. Fail-closed: an empty
    configured secret verifies nothing, so an unconfigured deployment accepts no webhook."""
    if not configured or not received:
        return False
    return hmac.compare_digest(configured, received)


class InboundMessage(BaseModel):
    """A verified, parsed inbound Telegram message."""

    model_config = ConfigDict(frozen=True)

    telegram_user_id: str
    chat_id: str
    body: str


def parse_update(update: Mapping[str, Any]) -> InboundMessage | None:
    """Extract sender + text from a Telegram ``Update``, or None if it isn't a text message
    (edits, stickers, joins, channel posts are ignored). Body is untrusted data, never
    instructions (hard rule 7)."""
    message = update.get("message")
    if not isinstance(message, Mapping):
        return None
    sender = message.get("from")
    chat = message.get("chat")
    text = message.get("text")
    if not (isinstance(sender, Mapping) and isinstance(chat, Mapping) and isinstance(text, str)):
        return None
    sender_id, chat_id = sender.get("id"), chat.get("id")
    if not (isinstance(sender_id, int) and isinstance(chat_id, int)):
        return None
    return InboundMessage(telegram_user_id=str(sender_id), chat_id=str(chat_id), body=text)


class TelegramChannel(MessagingChannel):
    """Outbound ``MessagingChannel`` over the Telegram Bot API.

    ``chat_for_user`` resolves an enrolled ``user_id`` to its Telegram chat id (for private
    chats this equals the numeric Telegram user id); an unenrolled id is a hard error. The
    httpx client is injected for tests (MockTransport) and connection reuse.
    """

    def __init__(
        self,
        *,
        bot_token: str,
        chat_for_user: Callable[[str], str | None],
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._bot_token = bot_token
        self._chat_for_user = chat_for_user
        self._http = http or httpx.AsyncClient(timeout=15.0)

    async def send(self, user_id: str, text: str) -> None:
        """Deliver ``text`` to an enrolled user, chunked to Telegram's message limit, in order."""
        chat_id = self._chat_for_user(user_id)
        if chat_id is None:
            raise ValueError(f"user {user_id!r} has no enrolled Telegram chat")
        chunks = [text[i : i + _MAX_BODY_CHARS] for i in range(0, len(text), _MAX_BODY_CHARS)] or [
            ""
        ]
        for chunk in chunks:
            resp = await self._http.post(
                f"{_TELEGRAM_API}/bot{self._bot_token}/sendMessage",
                json={"chat_id": chat_id, "text": chunk},
            )
            resp.raise_for_status()
        _log.info("telegram.sent", user_id=user_id, chunks=len(chunks))

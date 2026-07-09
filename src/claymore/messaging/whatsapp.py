"""[Pipes] WhatsApp ``MessagingChannel`` adapter — the hackathon surface (CLAUDE.md §3, 2026-07-09).

Twilio WhatsApp **sandbox** path: instant, no Meta Business approval. Outbound goes through the
Twilio Messages REST API over httpx; inbound webhooks are verified with ``X-Twilio-Signature``
before any content is read (SECURITY.md §8), and the sender must resolve to an enrolled
:class:`~claymore.auth.models.User` — caller-ID alone is never trust. Everything sits behind the
``MessagingChannel`` port so the Meta/Composio Business path is a one-adapter swap later.

WhatsApp has no inline buttons through the sandbox, so approvals use the same numbered-token
scheme as SMS (``approve A3``), rendered by :func:`render_reply`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Callable, Mapping
from xml.sax.saxutils import escape

import httpx
from pydantic import BaseModel, ConfigDict

from claymore.auth.models import User
from claymore.logging import get_logger
from claymore.messaging import render_reply
from claymore.ports import MessagingChannel

__all__ = [
    "TwilioWhatsAppChannel",
    "compute_twilio_signature",
    "parse_inbound",
    "render_reply",  # re-exported: shared renderer lives in claymore.messaging
    "twiml_message",
    "verify_twilio_signature",
]

_log = get_logger("messaging.whatsapp")

WHATSAPP_PREFIX = "whatsapp:"
_TWILIO_API = "https://api.twilio.com/2010-04-01"
# WhatsApp caps a message body at 1600 chars; longer replies are sent as ordered chunks.
_MAX_BODY_CHARS = 1600

# Pipes authenticates the human at the edge: phone (E.164, no ``whatsapp:`` prefix) → enrolled
# User, or None. Unknown numbers are untrusted and get no agent access (SECURITY.md §8).
PhoneDirectory = Callable[[str], User | None]


def compute_twilio_signature(auth_token: str, url: str, params: Mapping[str, str]) -> str:
    """Compute the ``X-Twilio-Signature`` value Twilio sends for a webhook request.

    Twilio's documented scheme: concatenate the full public URL with every POST param's
    ``key + value`` in lexicographic key order, then HMAC-SHA1 with the account's auth token,
    base64-encoded. SHA1 is mandated by Twilio's webhook contract — it is an HMAC keyed with a
    secret, not a bare digest, and there is no negotiable alternative on their side.
    """
    payload = url + "".join(k + params[k] for k in sorted(params))
    digest = hmac.new(auth_token.encode("utf-8"), payload.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def verify_twilio_signature(
    auth_token: str, url: str, params: Mapping[str, str], signature: str
) -> bool:
    """Constant-time check of an inbound webhook's ``X-Twilio-Signature`` (SECURITY.md §8).

    Fail-closed: an empty auth token verifies nothing (returns False), so an unconfigured
    deployment can never accept a forged webhook.
    """
    if not auth_token or not signature:
        return False
    expected = compute_twilio_signature(auth_token, url, params)
    return hmac.compare_digest(expected, signature)


class InboundMessage(BaseModel):
    """A verified, parsed inbound WhatsApp message. ``phone`` is bare E.164 (prefix stripped)."""

    model_config = ConfigDict(frozen=True)

    phone: str
    body: str
    message_sid: str = ""


def parse_inbound(form: Mapping[str, str]) -> InboundMessage | None:
    """Extract the sender + body from a Twilio webhook form, or None if it isn't WhatsApp-shaped.

    The body is untrusted content — it is carried as data only, never interpreted (hard rule 7).
    """
    sender = form.get("From", "")
    if not sender.startswith(WHATSAPP_PREFIX):
        return None
    phone = sender.removeprefix(WHATSAPP_PREFIX).strip()
    if not phone:
        return None
    return InboundMessage(
        phone=phone, body=form.get("Body", ""), message_sid=form.get("MessageSid", "")
    )


def twiml_message(text: str) -> str:
    """Wrap text in a TwiML ``<Message>`` response, XML-escaped so reply content (which may quote
    untrusted ingested text) can never inject TwiML verbs."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Message>{escape(text)}</Message></Response>"
    )


class TwilioWhatsAppChannel(MessagingChannel):
    """Outbound ``MessagingChannel`` over the Twilio WhatsApp sandbox.

    ``phone_for_user`` resolves an enrolled ``user_id`` to its verified E.164 number; an
    unenrolled id is a hard error (never message an unverified number). The httpx client is
    injected for tests (MockTransport) and connection reuse.
    """

    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        from_number: str,
        phone_for_user: Callable[[str], str | None],
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._from_number = from_number
        self._phone_for_user = phone_for_user
        self._http = http or httpx.AsyncClient(timeout=15.0)

    async def send(self, user_id: str, text: str) -> None:
        """Deliver ``text`` to an enrolled user, chunked to WhatsApp's body limit, in order."""
        phone = self._phone_for_user(user_id)
        if phone is None:
            raise ValueError(f"user {user_id!r} has no enrolled WhatsApp number")
        chunks = [text[i : i + _MAX_BODY_CHARS] for i in range(0, len(text), _MAX_BODY_CHARS)] or [
            ""
        ]
        for chunk in chunks:
            resp = await self._http.post(
                f"{_TWILIO_API}/Accounts/{self._account_sid}/Messages.json",
                auth=(self._account_sid, self._auth_token),
                data={
                    "From": f"{WHATSAPP_PREFIX}{self._from_number}",
                    "To": f"{WHATSAPP_PREFIX}{phone}",
                    "Body": chunk,
                },
            )
            resp.raise_for_status()
        _log.info("whatsapp.sent", user_id=user_id, chunks=len(chunks))

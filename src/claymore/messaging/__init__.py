"""[Pipes] Messaging channels — chat adapters behind the ``MessagingChannel`` port.

Shared here: the plain-text rendering of an agent :class:`~claymore.agent.Reply` (answer +
numbered citations + ``approve <token>`` prompt), which every text-first channel (Telegram,
WhatsApp, SMS) renders identically.
"""

from __future__ import annotations

from collections.abc import Callable

from claymore.agent import Reply
from claymore.auth.models import User


def directory_from_roster(spec: str, *, key_is_phone: bool = False) -> Callable[[str], User | None]:
    """Build a channel-handle→enrolled-User lookup from an env roster (demo path until the
    Postgres enrollment table lands): comma-separated ``handle:lab_id:user_id`` triples, where
    ``handle`` is the channel's sender key (E.164 phone, Telegram user id, …).

    Malformed entries raise at startup — a silently dropped enrollment would look like a
    security rejection at runtime, which is much harder to debug than a loud boot failure.
    """
    entries: dict[str, User] = {}
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        parts = [part.strip() for part in item.split(":")]
        if len(parts) != 3 or not all(parts):
            raise ValueError(f"malformed enrollment entry: {item!r}")
        handle, lab_id, user_id = parts
        entries[handle] = User(
            id=user_id,
            lab_id=lab_id,
            person_id=user_id,
            phone=handle if key_is_phone else None,
        )
    return lambda handle: entries.get(handle)


def render_reply(reply: Reply) -> str:
    """Render a :class:`Reply` as chat text: answer, numbered citations, approval token."""
    lines = [reply.text]
    if reply.citations:
        lines.append("")
        lines.extend(
            f"[{i}] {c.source_platform.value} {c.source_id} — {c.author}, {c.timestamp:%Y-%m-%d}"
            for i, c in enumerate(reply.citations, 1)
        )
    if reply.pending_action is not None:
        lines.append("")
        action = reply.pending_action
        lines.append(f'Reply "approve {action.token}" to run: {action.description}')
    return "\n".join(lines)

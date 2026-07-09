"""Participant handle -> canonical UserId resolution for visibility (R13).

Regression coverage for the ingest bug where a private episode's ``allowed_user_ids`` held raw
platform handles instead of ``User.id``s, making the episode invisible to everyone — including
its owner — because a handle never equals a UserId.
"""

from __future__ import annotations

from claymore.auth.models import User
from claymore.domain import SourcePlatform, Visibility
from claymore.ingest.composio.hub import FakeConnectorHub
from claymore.memory.identity import IdentityResolver

_LAB = "lab-x"
_ROSTER = [
    User(
        id="u_rikhin",
        lab_id=_LAB,
        person_id="p_rikhin",
        platform_handles={SourcePlatform.GMAIL: "rikhin@lab.org"},
    ),
    User(
        id="u_lucas",
        lab_id=_LAB,
        person_id="p_lucas",
        platform_handles={SourcePlatform.GMAIL: "lucas@lab.org"},
    ),
]


def test_resolve_user_maps_handle_to_userid() -> None:
    r = IdentityResolver(_LAB, _ROSTER)
    assert r.resolve_user(SourcePlatform.GMAIL, "rikhin@lab.org") == "u_rikhin"
    assert r.resolve_user(SourcePlatform.GMAIL, "Rikhin <rikhin@lab.org>") == "u_rikhin"
    # An external sender is not a lab member → None (dropped, never guessed into the allowlist).
    assert r.resolve_user(SourcePlatform.GMAIL, "team@voyage.example") is None


def test_resolve_users_keeps_only_lab_members() -> None:
    r = IdentityResolver(_LAB, _ROSTER)
    got = r.resolve_users(
        SourcePlatform.GMAIL, ["rikhin@lab.org", "lucas@lab.org", "spam@evil.example"]
    )
    assert got == frozenset({"u_rikhin", "u_lucas"})


async def test_ingested_email_is_visible_to_its_owner() -> None:
    # An email TO rikhin from an external sender: the owner must be able to see it after ingest.
    raw = {
        SourcePlatform.GMAIL: [
            {
                "messageId": "m1",
                "messageTimestamp": "2026-03-03T12:00:00Z",
                "messageText": "Your embeddings are ready.",
                "sender": "Voyage AI <team@voyage.example>",
                "to": "rikhin@lab.org",
                "subject": "Embeddings",
            }
        ]
    }
    resolver = IdentityResolver(_LAB, _ROSTER)
    hub = FakeConnectorHub(raw, resolver=resolver)
    episodes = [ep async for ep in hub.backfill(_LAB, SourcePlatform.GMAIL)]
    assert len(episodes) == 1
    vis = episodes[0].visibility
    assert isinstance(vis, Visibility)
    assert not vis.lab_wide  # email stays need-to-know
    assert vis.can_view("u_rikhin")  # the owner (recipient) resolves and can see it
    assert not vis.can_view("u_lucas")  # a lab member who wasn't on the email cannot

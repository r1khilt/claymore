"""Shared test fixtures — canonical Episodes / Users so Brain develops without Pipes.

The ``Episode`` shape is frozen (``ingest/normalize.py``); these builders let memory/agent/eval
tests exercise it with realistic, provenance-tagged data and nothing live.
"""

from __future__ import annotations

from datetime import UTC, datetime

from claymore.auth.models import Role, User
from claymore.domain import SourcePlatform, Visibility
from claymore.ingest.normalize import Episode

LAB = "lab1"
NOW = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)

LAB_WIDE = Visibility(lab_wide=True, source_label="#protein-eng")
DM_LUCAS_PHILIP = Visibility(
    lab_wide=False, allowed_user_ids=frozenset({"u_lucas", "u_philip"}), source_label="DM"
)


def make_user(
    user_id: str = "u_lucas",
    *,
    lab_id: str = LAB,
    person_id: str | None = None,
    role: Role = Role.MEMBER,
    handles: dict[SourcePlatform, str] | None = None,
) -> User:
    return User(
        id=user_id,
        lab_id=lab_id,
        person_id=person_id or f"p_{user_id.removeprefix('u_')}",
        role=role,
        platform_handles=handles or {},
    )


def make_episode(
    *,
    lab_id: str = LAB,
    platform: SourcePlatform = SourcePlatform.SLACK,
    source_id: str = "m1",
    author: str = "p_lucas",
    text: str = "Lucas suggested testing the Y hypothesis on the X protein.",
    timestamp: datetime = NOW,
    refs: tuple[str, ...] = ("Y-hypothesis",),
    visibility: Visibility = LAB_WIDE,
    is_untrusted: bool = True,
    source_hash: str | None = "h1",
    extra: dict[str, str] | None = None,
) -> Episode:
    return Episode(
        lab_id=lab_id,
        source_platform=platform,
        source_id=source_id,
        author=author,
        timestamp=timestamp,
        text=text,
        refs=refs,
        visibility=visibility,
        is_untrusted=is_untrusted,
        source_hash=source_hash,
        extra=extra or {},
    )


# A small roster whose handles seed identity resolution across platforms.
ROSTER = [
    make_user(
        "u_lucas",
        person_id="p_lucas",
        handles={
            SourcePlatform.SLACK: "@lucas",
            SourcePlatform.GMAIL: "lucas@lab.org",
            SourcePlatform.GITHUB: "lucas-dev",
        },
    ),
    make_user(
        "u_philip",
        person_id="p_philip",
        handles={
            SourcePlatform.SLACK: "@philip",
            SourcePlatform.GMAIL: "philip@lab.org",
        },
    ),
]

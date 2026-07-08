"""The ``Episode`` contract — the handoff from Pipes (ingest) to Brain (memory).

Every source item (a Slack message, an email, a Granola transcript, a code commit) is
normalized to an ``Episode`` before it touches the graph. This is the single most important
frozen shape: Pipes *emits* Episodes, Brain *consumes* them, and each side develops against
this schema (via fixtures / a stub) without waiting on the other (WORKPLAN.md §2/§5).

The Episode is also the durable **system of record** — persisted append-only in Postgres
(``ingest/episodes.py``, R14) so the graph is a rebuildable projection. Changing this schema is
a two-person contract decision.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from claymore.domain import UNKNOWN_AUTHOR, LabId, PersonId, SourcePlatform, Visibility


class Episode(BaseModel):
    """A normalized, provenance-tagged unit of lab memory, ready for extraction."""

    model_config = ConfigDict(frozen=True)

    # --- identity of the source item ---
    lab_id: LabId
    """Hard tenant boundary (R10). Every episode belongs to exactly one lab."""

    source_platform: SourcePlatform
    source_id: str
    """Stable id within the platform (message ts, email id, note id, commit sha)."""

    # --- content ---
    author: PersonId = UNKNOWN_AUTHOR
    """Canonical lab person after identity resolution (R11), or ``"unknown"`` — never guessed."""

    timestamp: datetime
    """The source event time. Used as Graphiti's ``reference_time`` so bi-temporal ordering is
    correct even on out-of-order backfill (R12) — NOT the ingest time."""

    text: str
    refs: tuple[str, ...] = ()
    """Referenced entities/threads/urls the source item points at."""

    # --- trust + scope (SECURITY.md §6, R13) ---
    visibility: Visibility
    """Derived from the source object's ACL; propagates onto every fact extracted from this
    episode (fail-closed)."""

    is_untrusted: bool = True
    """All ingested content is untrusted data, never instructions (SECURITY.md rule 1).
    Defaults True; only lower it for a first-party, authenticated source."""

    # --- bookkeeping ---
    source_hash: str | None = None
    """Content hash for dedup — don't re-extract unchanged episodes (R6)."""

    ingested_at: datetime | None = None
    """Set when written to the durable log; ``None`` before persistence."""

    extra: dict[str, str] = Field(default_factory=dict)
    """Platform-specific metadata (e.g. Granola meeting attendee list for speaker mapping)."""

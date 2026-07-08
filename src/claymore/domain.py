"""Shared domain primitives — the vocabulary both Pipes and Brain build on.

These are pure value types with zero vendor dependency (ENGINEERING_GUIDELINES.md §1: the
domain core must not import an SDK). ``Episode`` (ingest/normalize.py) and ``Fact``
(memory/ontology.py) both build on the primitives here, so they live in one place to avoid a
cross-module import cycle. Changing anything here is a **two-person contract decision**.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

# Canonical author sentinel: used when identity resolution cannot ground who authored an
# episode. Hard rule 1 — surface "unknown", never guess a name (R11).
UNKNOWN_AUTHOR = "unknown"

# Type aliases for the tenant/scope IDs threaded everywhere. `group_id` = per-user scope
# inside a lab; `lab_id` = the hard tenant boundary (R10/R13).
LabId = str
UserId = str
PersonId = str


class SourcePlatform(StrEnum):
    """Where an episode came from. `MANUAL` is a hand-made episode (Phase 0 / fixtures)."""

    SLACK = "slack"
    GMAIL = "gmail"
    GITHUB = "github"
    NOTION = "notion"
    GDRIVE = "gdrive"
    GDOCS = "gdocs"
    GRANOLA = "granola"
    CODELOGS = "codelogs"
    MANUAL = "manual"


class Visibility(BaseModel):
    """Who may see facts derived from a source — the intra-lab need-to-know policy (R13).

    Derived from the source object's ACL at ingest (channel membership, doc sharing). A graph
    fact reinforced by several episodes inherits the **most restrictive** contributing source's
    visibility (fail-closed) — see :func:`most_restrictive`. Retrieval filters the querying
    user's clearance against this; the ``group_id`` tenant boundary (R10) is enforced
    separately and first.
    """

    model_config = ConfigDict(frozen=True)

    lab_wide: bool
    """True if any member of the owning lab may see it (e.g. a public channel, a lab-shared doc)."""

    allowed_user_ids: frozenset[UserId] = frozenset()
    """Explicit allowlist used when ``lab_wide`` is False (e.g. a private DM's participants)."""

    source_label: str = ""
    """Human hint for surfacing provenance in answers, e.g. ``"#protein-eng"`` or ``"DM"``."""

    def can_view(self, user_id: UserId) -> bool:
        """Whether ``user_id`` (already known to be in the lab) may see this fact."""
        return self.lab_wide or user_id in self.allowed_user_ids


def most_restrictive(a: Visibility, b: Visibility) -> Visibility:
    """Combine two source visibilities into the tighter one (fail-closed, R13).

    Used when a fact is supported by more than one episode: it may only be as visible as its
    *least* visible source. lab-wide loses to restricted; two restricted sets intersect.
    """
    if a.lab_wide and b.lab_wide:
        return Visibility(lab_wide=True, source_label=a.source_label or b.source_label)
    if a.lab_wide:  # b is the restrictive one
        return b
    if b.lab_wide:
        return a
    return Visibility(
        lab_wide=False,
        allowed_user_ids=a.allowed_user_ids & b.allowed_user_ids,
        source_label=a.source_label or b.source_label,
    )

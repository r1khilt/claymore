"""[Pipes] Granola connector — meeting notes + transcripts (CLAUDE.md §5).

REST: ``GET /v1/notes`` (paginated, ``created_after``) + ``/v1/notes/{id}?include=transcript``,
Bearer ``grn_`` key (Business plan). Normalizes notes/transcripts to ``Episode``, attributing to
the meeting's speakers, mapping speaker labels to attendees where possible (R11).

TODO(Phase 1): backfill + incremental + transcript normalization.
"""

from __future__ import annotations

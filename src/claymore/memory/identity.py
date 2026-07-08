"""[Brain] Cross-source identity resolution (R11) — resolve authors BEFORE graph-write.

Resolves an episode's author/entities to a canonical lab ``Person`` across platforms (Slack
handle ↔ email ↔ GitHub login ↔ Granola speaker label). A ``person_identity`` table seeded from
the lab roster at enrollment; LLM-assisted merge for unknowns behind a confidence gate; else
``author=unknown`` and surfaced — never guessed (hard rule 1). Must run before facts are stored,
because retrofitting identity onto a populated graph is a rewrite.

TODO(Phase 1): person_identity table + resolve() + Granola-speaker→attendee mapping.
"""

from __future__ import annotations

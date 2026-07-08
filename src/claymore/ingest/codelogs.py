"""[Pipes] Claude Code / Codex session-log ingester (CLAUDE.md §5).

File-based: ingest session transcripts/commits as Episodes, attributed to the author + repo.

TODO(Phase 1): read CODELOGS_PATHS, normalize sessions/commits to Episode.
"""

from __future__ import annotations

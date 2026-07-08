"""[Brain] Attributed, scope-enforced retrieval (R10/R13, hard rule 1 & 4).

This is THE enforcement point for intra-lab need-to-know: every answer path (agent tools,
MCP-out, proactive) retrieves through :func:`retrieve`, never through ``MemoryStore.search``
directly. Order of checks is deliberate and fail-closed:

1. **Tenant boundary (R10)** — search only the requesting user's lab partition.
2. **Visibility (R13)** — drop any fact the user may not view (``Visibility.can_view``).
3. **Confidence (R12)** — optionally drop low-``extraction_confidence`` facts.

Every returned fact carries provenance by type (``Fact.provenance`` is required), so the caller
can always cite platform + id + timestamp + author; ungrounded → say "I can't find that", never
invent (hard rule 1). Temporal windowing ("last week") layers on top in ``agent/temporal.py``.
"""

from __future__ import annotations

import structlog

from claymore.auth.models import User
from claymore.memory.ontology import Fact
from claymore.ports import MemoryStore

logger = structlog.get_logger(__name__)

# Overfetch factor: visibility/confidence filtering happens *after* the store search, so ask the
# store for more than ``limit`` or a heavily-restricted user would get starved results.
_OVERFETCH = 3

# Defensive cap: a query is untrusted user input; a megabyte of text should not reach the
# embedder/BM25 layer (cost + abuse surface, R6). Longer queries are truncated, not rejected.
MAX_QUERY_CHARS = 2_000


async def retrieve(
    store: MemoryStore,
    user: User,
    query: str,
    *,
    limit: int = 10,
    min_extraction_confidence: float = 0.0,
) -> list[Fact]:
    """Search the user's lab memory, returning only facts this user may see."""
    if limit <= 0:
        return []
    trimmed = query.strip()[:MAX_QUERY_CHARS]
    if not trimmed:
        return []

    candidates = await store.search(
        user.lab_id, trimmed, group_ids=[user.lab_id], limit=limit * _OVERFETCH
    )

    visible: list[Fact] = []
    dropped_scope = 0
    for fact in candidates:
        if not fact.visibility.can_view(user.id):
            dropped_scope += 1  # counted, never logged with content (SECURITY.md §6)
            continue
        if fact.provenance.extraction_confidence < min_extraction_confidence:
            continue
        visible.append(fact)
        if len(visible) == limit:
            break

    if dropped_scope:
        logger.info(
            "retrieval.visibility_filtered",
            lab_id=user.lab_id,
            user_id=user.id,
            dropped=dropped_scope,
        )
    return visible

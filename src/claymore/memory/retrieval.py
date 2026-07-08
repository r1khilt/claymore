"""[Brain] Attributed, visibility-scoped retrieval (R2/R13).

Hybrid (graph + vector + BM25 + temporal) search, always scoped to explicit ``group_ids`` and
filtered on the querying user's clearance ∩ fact ``visibility`` — never a global search. Returns
facts with their provenance so every answer can be cited; ungrounded → say "I can't find that",
never invent (hard rule 1).

TODO(Phase 2): implement hybrid search + visibility filter + temporal windowing.
"""

from __future__ import annotations

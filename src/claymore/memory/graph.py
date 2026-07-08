"""[Brain] Graphiti wrapper — the ``MemoryStore`` adapter (CLAUDE.md §4, R6/R10).

Implements ``claymore.ports.MemoryStore`` over Graphiti on FalkorDB: per-lab graph isolation
(``group_id``/``graph_name``), cheap-model extraction with prompt caching (R6), and hybrid
retrieval scoped to explicit ``group_ids``. Extraction stores canonical persons (identity
resolved first, R11) and propagates ``visibility`` onto facts (R13).

TODO(Phase 1): implement add_episode / search / build_indices against graphiti-core.
"""

from __future__ import annotations

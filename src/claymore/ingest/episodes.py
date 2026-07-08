"""[Pipes] Durable append-only Episode log — the system of record (R14).

Every normalized ``Episode`` is persisted here (Postgres) BEFORE extraction, so the graph is a
rebuildable projection: losing FalkorDB never means re-hitting sources or re-paying extraction.
Also enables extraction A/B and cheap rebuilds. Encrypted at rest (holds raw source text, R7).

TODO(Phase 1): append() + stream_for_rebuild() + dedup by source_hash.
"""

from __future__ import annotations

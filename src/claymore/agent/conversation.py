"""[Brain] Per-user conversation state + follow-up coreference (BUILD_PLAN.md §4.5).

The primary mode is multi-turn ("expand on that," "who else touched it"). Keeps per-user session
context (last N turns + the node IDs cited in the last answer) in Redis; resolves deictic
follow-ups against that cited-node set before falling back to full retrieval.

TODO(Phase 2): session store + coreference resolution against cited nodes.
"""

from __future__ import annotations

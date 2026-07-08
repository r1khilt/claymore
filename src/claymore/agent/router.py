"""[Brain] Model-routed Claude tool-loop (BUILD_PLAN.md §4.5).

The engine behind ``agent.handle``: routes models (Haiku/Sonnet for cheap steps, Opus for query
planning/multi-hop reasoning), runs the tool loop over ``agent.tools``, and logs every tool call
+ which sources were touched (auditable). A reviewer pass decomposes the draft answer into atomic
claims and verifies each against retrieved context before it goes out (R2).

TODO(Phase 2): implement the tool loop + model routing + reviewer pass.
"""

from __future__ import annotations

"""[Brain, Phase 3] Claude Science hand-off (BUILD_PLAN.md §4.6).

Claude Science is a supervised workbench, NOT a headless API — so (a) Claymore's MCP memory is a
tool a scientist uses *inside* their own Claude Science session, and (b) heavy supervised runs are
framed and handed off there rather than driven programmatically. Kept behind the ``ComputeBackend``
seam so a real programmatic entry point can drop in later.

TODO(Phase 3): framing + hand-off surface (no headless dependency).
"""

from __future__ import annotations

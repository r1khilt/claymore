"""[Brain, Phase 3/4] Human-in-the-loop gate for physical/spend runs (BUILD_PLAN.md §4.7).

Reuses the base approval gate (``claymore.actions.approvals``) with the strictest confirmation for
``PHYSICAL_RUN`` / spend-incurring ``RUN_COMPUTE``: shows the plan + simulation output + reagent/
labware list, parks as a durable workflow (Temporal signal) until approved, and exposes an abort.

TODO(Phase 3/4): spend/physical confirmation flow on top of actions.approvals.
"""

from __future__ import annotations

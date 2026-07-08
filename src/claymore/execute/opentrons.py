"""[Brain, Phase 4] Wet-lab execution — Opentrons, gated, opt-in (BUILD_PLAN.md §4.7, R3).

Python Protocol API (apiLevel ≥ 2.28) to draft; ``opentrons.simulate`` to dry-run; HTTP API to
upload/run on a networked robot. MANDATORY flow: draft → simulate → surface plan+sim to a human →
explicit approval → run → ingest result. Off by default, opt-in per lab, always-available abort.
Never auto-run a physical protocol from a text (hard rule 2).

TODO(Phase 4): protocol gen -> simulate -> approval gate -> HTTP run. Do NOT build before Phase 4.
"""

from __future__ import annotations

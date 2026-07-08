"""[Brain, Phase 3] Claymore's own science-execution agent (BUILD_PLAN.md §4.6).

The SMS-triggerable "expand and run it" path: Claude Agent SDK + Anthropic science Agent Skills +
MCP connectors, on E2B/Modal/HPC, calling BioNeMo/Nextflow. Texts back a reproducible summary
(figure + code + env) and ingests the run back as ``Experiment``/``Result`` nodes. Every
spend-incurring/long run is gated (hard rule 3).

TODO(Phase 3): agent loop + skills + compute backend wiring.
"""

from __future__ import annotations

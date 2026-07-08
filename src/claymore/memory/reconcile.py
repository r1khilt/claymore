"""[Brain] Cross-episode reconciliation + extraction-quality gate (R12).

Runs after each episode's facts land: compares a new fact against existing facts on the same
entity and writes ``SUPERSEDES``/``CONTRADICTS`` edges with provenance (the engine behind
"suggested Mar 3, superseded Mar 10"). ``reference_time`` = source timestamp so ordering is
correct on out-of-order backfill. The same pass sample-audits extraction and tracks
extraction-attribution-error from Phase 1. The proactive contradiction trigger subscribes here.

TODO(Phase 1): reconcile() background job + extraction-quality sampling.
"""

from __future__ import annotations

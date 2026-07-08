"""Retrieval-attribution eval harness (build EARLY — Phase 1, BUILD_PLAN.md §6, R2).

The Reviewer-2-proof metric: seed a synthetic lab corpus with known ground truth (who said what,
when, what was superseded, mixed visibility) and measure temporal / multi-hop / knowledge-update
accuracy AND attribution correctness (hallucinated-source rate → ~0). Gate CI on faithfulness
(≥0.85) + attribution. Extend with deep-history recall, extraction-quality, a Granola-diarization
case, an action-correctness set, and a cross-tenant/visibility leak test.

TODO(Phase 1): GroundTruthCase model, corpus seeding, RAGAS/DeepEval scoring, CI gate.
"""

from __future__ import annotations

from pydantic import BaseModel


class GroundTruthCase(BaseModel):
    """One eval case: a question with its known-correct answer + the source that grounds it."""

    question: str
    expected_answer: str
    expected_source_ids: tuple[str, ...]
    category: str  # temporal | multi_hop | knowledge_update | single_session | deep_history

"""Live integration test — AnthropicLLM against the real Anthropic API.

Guarded like the Graphiti live test: skips unless CLAYMORE_RUN_LIVE=1 and a real
ANTHROPIC_API_KEY is configured. Proves the LLM adapter (the agent's phrasing call) works end
to end and that task routing selects the configured models. Voyage is NOT needed here.

    export ANTHROPIC_API_KEY=sk-ant-...
    CLAYMORE_RUN_LIVE=1 .venv/bin/pytest tests/integration/test_llm_live.py -v
"""

from __future__ import annotations

import os

import pytest

from claymore.config import get_settings

pytestmark = pytest.mark.integration


def _live_or_skip() -> object:
    settings = get_settings()
    if not settings.anthropic_api_key.get_secret_value():
        pytest.skip("ANTHROPIC_API_KEY not set — skipping live LLM test")
    return settings


def test_routing_selects_configured_models() -> None:
    from claymore.agent.llm import AnthropicLLM, TaskKind

    settings = get_settings()
    llm = AnthropicLLM(settings)  # type: ignore[arg-type]
    assert llm.route(TaskKind.EXTRACTION) == settings.extraction_model
    assert llm.route(TaskKind.REASONING) == settings.query_model


@pytest.mark.skipif(
    os.getenv("CLAYMORE_RUN_LIVE") != "1",
    reason="live test — set CLAYMORE_RUN_LIVE=1 (plus ANTHROPIC_API_KEY) to run",
)
async def test_complete_answers_from_the_given_fact() -> None:
    from claymore.agent.llm import AnthropicLLM

    settings = _live_or_skip()
    llm = AnthropicLLM(settings)  # type: ignore[arg-type]
    out = await llm.complete(
        system="Answer in one short sentence using ONLY the given fact. Invent nothing.",
        prompt=(
            "Fact: Lucas suggested a melt-assay thermostability test on the X protein. "
            "Question: what did Lucas suggest?"
        ),
        model=settings.extraction_model,  # type: ignore[union-attr]
        max_tokens=60,
    )
    assert out.strip()
    assert "melt" in out.lower() or "thermostab" in out.lower()

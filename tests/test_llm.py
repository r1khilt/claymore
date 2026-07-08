"""Unit tests for the Anthropic LLM adapter and its deterministic fake.

Offline only: no network, no API key. ``FakeLLM`` is the default LLM across Brain/eval tests, so
its queue/fallback/recording behaviour is pinned here. ``AnthropicLLM`` is exercised only through
its pure ``route()`` seam — the network path is never touched (that's the adapter's job to keep
optional, ENGINEERING_GUIDELINES §1, R6/R9).
"""

from __future__ import annotations

from claymore.agent.llm import CANNED_RESPONSE, AnthropicLLM, FakeLLM, TaskKind
from claymore.config import Settings


def _settings(
    *, extraction: str = "cheap-extract-model", query: str = "strong-query-model"
) -> Settings:
    # Explicit kwargs beat env/.env in pydantic-settings, so routing is asserted against known ids.
    return Settings(extraction_model=extraction, query_model=query)


# --- FakeLLM: queue then canned fallback ---


async def test_fake_pops_responses_in_order_then_falls_back() -> None:
    llm = FakeLLM(["first", "second"])
    assert await llm.complete(system="s", prompt="p1") == "first"
    assert await llm.complete(system="s", prompt="p2") == "second"
    # queue drained -> stable canned string
    assert await llm.complete(system="s", prompt="p3") == CANNED_RESPONSE
    assert await llm.complete(system="s", prompt="p4") == CANNED_RESPONSE


async def test_fake_with_no_responses_is_all_canned() -> None:
    llm = FakeLLM()
    assert await llm.complete(system="s", prompt="p") == CANNED_RESPONSE


# --- FakeLLM: call recording ---


async def test_fake_records_every_call_verbatim() -> None:
    llm = FakeLLM(["ok"])
    await llm.complete(system="sys-a", prompt="prompt-a", model="m-a", max_tokens=42)
    await llm.complete(system="sys-b", prompt="prompt-b")  # defaults: model=None, max_tokens=1024
    assert llm.calls == [
        ("sys-a", "prompt-a", "m-a", 42),
        ("sys-b", "prompt-b", None, 1024),
    ]


# --- AnthropicLLM.route: task -> configured model (R6) ---


def test_route_maps_tasks_to_configured_models() -> None:
    settings = _settings(extraction="haiku-x", query="opus-y")
    llm = AnthropicLLM(settings)
    assert llm.route(TaskKind.EXTRACTION) == "haiku-x"
    assert llm.route(TaskKind.REASONING) == "opus-y"


def test_route_reflects_custom_settings() -> None:
    llm = AnthropicLLM(_settings(extraction="e1", query="q1"))
    assert llm.route(TaskKind.EXTRACTION) == "e1"
    assert llm.route(TaskKind.REASONING) == "q1"


def test_complete_defaults_to_query_model_via_route_seam() -> None:
    # complete(model=None) resolves via route(REASONING); assert that seam without a network call.
    settings = _settings(query="the-reasoning-model")
    llm = AnthropicLLM(settings)
    assert llm.route(TaskKind.REASONING) == "the-reasoning-model"
    assert llm.route(TaskKind.REASONING) == settings.query_model


def test_taskkind_is_str_enum() -> None:
    assert TaskKind.EXTRACTION == "extraction"
    assert TaskKind.REASONING == "reasoning"


def test_anthropic_adapter_does_not_build_client_on_construction() -> None:
    # Constructing the adapter must not touch the SDK or the key (offline import safety).
    llm = AnthropicLLM(_settings())
    assert llm._client is None

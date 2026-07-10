"""Unit tests for conversation-history threading in ``agent/agent_loop.run_agent``.

Offline: the Anthropic client is replaced with a ``_FakeClient`` that captures the ``messages``
list passed to ``messages.create`` and returns a one-shot text answer (no tool use, so the loop
stops after a single iteration). The load-bearing property is that prior turns are seeded — with
correct roles + text, correctly normalized to a valid alternating Anthropic message list — before
the current query, and that empty history behaves exactly as the old single-query loop did.
"""

from __future__ import annotations

from typing import Any

import claymore.agent.agent_loop as agent_loop
from claymore.agent import RequestContext
from claymore.agent.agent_loop import run_agent
from claymore.memory.graph import InMemoryMemoryStore
from tests.fixtures import LAB, make_settings

CTX = RequestContext(user_id="u_lucas", lab_id=LAB, group_ids=(LAB,))


# --- fake Anthropic client (records the messages of the FIRST create call) --------------------


class _Block:
    """A minimal stand-in for a response content block (only a text block is needed here)."""

    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _Usage:
    def __init__(self) -> None:
        self.input_tokens = 1
        self.output_tokens = 1


class _Message:
    """A finished, non-tool message — makes the loop emit one answer and stop."""

    def __init__(self, text: str) -> None:
        self.content = [_Block(text)]
        self.stop_reason = "end_turn"
        self.usage = _Usage()


class _Messages:
    def __init__(self, recorder: list[list[dict[str, Any]]]) -> None:
        self._recorder = recorder

    async def create(self, **kwargs: Any) -> _Message:
        # Record a shallow copy of the messages list as passed on THIS iteration.
        self._recorder.append(list(kwargs["messages"]))
        return _Message("done")


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[list[dict[str, Any]]] = []
        self.messages = _Messages(self.calls)


async def _run(monkeypatch: Any, history: Any) -> list[list[dict[str, Any]]]:
    """Run ``run_agent`` once with a stubbed client and return the recorded ``create`` calls."""
    client = _FakeClient()
    monkeypatch.setattr(agent_loop, "_build_client", lambda _settings: client)
    settings = make_settings()
    store = InMemoryMemoryStore()
    async for _event in run_agent(CTX, "current question", store, settings, history=history):
        pass
    return client.calls


# --- history is seeded before the current query, with correct roles + text --------------------


async def test_history_seeds_prior_turns_before_current_query(monkeypatch: Any) -> None:
    history = [("user", "first question"), ("agent", "first answer")]
    calls = await _run(monkeypatch, history)

    first = calls[0]
    assert first == [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "current question"},
    ]
    # agent -> assistant mapping and the final current-query turn.
    assert first[-1] == {"role": "user", "content": "current question"}


async def test_empty_history_is_just_the_single_user_query(monkeypatch: Any) -> None:
    for history in ([], None):
        calls = await _run(monkeypatch, history)
        assert calls[0] == [{"role": "user", "content": "current question"}]


# --- normalization: valid, strictly-alternating, user-first ------------------------------------


async def test_leading_agent_turn_is_dropped_so_list_starts_with_user(monkeypatch: Any) -> None:
    # A conversation that (impossibly) starts with an agent turn must not produce a leading
    # assistant message — the API requires the first message to be ``user``.
    history = [("agent", "stray opener"), ("user", "real question")]
    calls = await _run(monkeypatch, history)

    seeded = calls[0]
    assert seeded[0]["role"] == "user"
    assert seeded == [
        {"role": "user", "content": "real question"},
        {"role": "user", "content": "current question"},
    ]


async def test_consecutive_same_role_turns_are_collapsed(monkeypatch: Any) -> None:
    history = [("user", "part one"), ("user", "part two"), ("agent", "reply")]
    calls = await _run(monkeypatch, history)

    assert calls[0] == [
        {"role": "user", "content": "part one\npart two"},
        {"role": "assistant", "content": "reply"},
        {"role": "user", "content": "current question"},
    ]


async def test_empty_and_whitespace_history_texts_are_skipped(monkeypatch: Any) -> None:
    history = [("user", "   "), ("agent", ""), ("user", "kept")]
    calls = await _run(monkeypatch, history)

    assert calls[0] == [
        {"role": "user", "content": "kept"},
        {"role": "user", "content": "current question"},
    ]

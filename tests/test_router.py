"""Unit tests for the Ask loop (``agent/router.py``) — grounded, cited, multi-turn answers.

Offline end-to-end: an ``InMemoryMemoryStore`` seeded from fixtures, a scripted ``FakeLLM``, and
an ``InMemoryConversationStore``. No credentials, no services. The load-bearing property under
test is that citations come from *retrieval*, never the model (anti-fabrication, hard rule 1).
"""

from __future__ import annotations

import claymore.agent as agent
from claymore.agent import RequestContext, set_runtime
from claymore.agent.conversation import InMemoryConversationStore
from claymore.agent.llm import CANNED_RESPONSE, FakeLLM
from claymore.agent.router import (
    NO_ANSWER_TEXT,
    AgentRuntime,
    answer,
    default_runtime,
)
from claymore.memory.graph import InMemoryMemoryStore
from tests.fixtures import LAB, make_episode

CTX = RequestContext(user_id="u_lucas", lab_id=LAB, group_ids=(LAB,))


async def _seeded_runtime(llm: FakeLLM | None = None) -> AgentRuntime:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode())  # Lucas suggested testing the Y hypothesis on X protein
    return AgentRuntime(
        store=store,
        llm=llm or FakeLLM(["Lucas suggested testing the Y hypothesis on the X protein."]),
        conversations=InMemoryConversationStore(),
    )


async def test_grounded_answer_has_text_and_matching_citation() -> None:
    runtime = await _seeded_runtime()
    reply = await answer(runtime, CTX, "what did Lucas suggest about the protein?")

    assert reply.text  # non-empty phrasing from the LLM
    assert reply.citations  # at least one citation
    cite = reply.citations[0]
    assert cite.source_id == "m1"  # the seeded episode
    assert cite.author == "p_lucas"
    assert reply.pending_action is None


async def test_fakellm_received_the_retrieved_facts() -> None:
    llm = FakeLLM(["phrased answer"])
    runtime = await _seeded_runtime(llm)
    await answer(runtime, CTX, "what did Lucas suggest about the protein?")

    assert len(llm.calls) == 1
    system, prompt, _model, _max = llm.calls[0]
    # The retrieved facts (their provenance) are in the prompt the model phrases from.
    assert "m1" in prompt
    assert "p_lucas" in prompt
    # The readable fact statement (the message content) is what the model phrases from.
    assert "hypothesis" in prompt.lower()
    # The system prompt forbids inventing sources.
    assert "citation" in system.lower()


async def test_citations_are_independent_of_llm_output() -> None:
    # Even when the model returns an empty/garbage string, the real citation still stands: it is
    # derived from retrieval provenance, not the model.
    runtime = await _seeded_runtime(FakeLLM([""]))
    reply = await answer(runtime, CTX, "what did Lucas suggest about the protein?")
    assert reply.citations
    assert reply.citations[0].source_id == "m1"


async def test_followup_reuses_prior_cited_context() -> None:
    llm = FakeLLM(["first answer", "expanded answer"])
    runtime = await _seeded_runtime(llm)

    first = await answer(runtime, CTX, "what did Lucas suggest about the protein?")
    assert first.citations

    # "expand on that" has no substantive terms; it must reuse the prior question's context
    # rather than returning an honest no-answer.
    followup = await answer(runtime, CTX, "expand on that")
    assert followup.text == "expanded answer"
    assert followup.citations  # same grounded context, re-cited
    assert followup.citations[0].source_id == "m1"
    assert len(llm.calls) == 2  # the follow-up did call the model (it was grounded)


async def test_conversation_records_both_turns() -> None:
    runtime = await _seeded_runtime()
    await answer(runtime, CTX, "what did Lucas suggest about the protein?")

    session = await runtime.conversations.get("u_lucas")
    assert session is not None
    assert [t.role for t in session.turns] == ["user", "agent"]
    agent_turn = session.turns[-1]
    assert agent_turn.cited_node_ids  # the referent a follow-up expands
    # The subject node of the seeded fact is recorded.
    assert "slack:m1" in agent_turn.cited_node_ids


async def test_handle_delegates_to_configured_runtime() -> None:
    runtime = await _seeded_runtime(FakeLLM(["handled"]))
    set_runtime(runtime)
    try:
        reply = await agent.handle(CTX, "what did Lucas suggest about the protein?")
        assert reply.text == "handled"
        assert reply.citations
    finally:
        set_runtime(default_runtime())  # don't leak the seeded runtime into other tests


async def test_default_runtime_is_all_in_memory_and_honest_when_empty() -> None:
    # A fresh default runtime has an empty store, so any question is ungrounded → honest no-answer.
    runtime = default_runtime()
    reply = await answer(runtime, CTX, "anything at all?")
    assert reply.text == NO_ANSWER_TEXT
    assert reply.citations == ()
    # The default FakeLLM was never consulted (nothing to phrase), so its canned fallback is unused.
    assert isinstance(runtime.llm, FakeLLM)
    assert runtime.llm.calls == []
    assert CANNED_RESPONSE  # sanity: the fallback constant exists but was not returned here

"""Unit tests for per-user conversation state + follow-up coreference.

Covers the happy path of the multi-turn ask mode (CLAUDE.md §1): sessions accumulate turns,
stay capped, expose the last answer's cited nodes, and resolve deictic follow-ups against them.
"""

from __future__ import annotations

import pytest

from claymore.agent.conversation import (
    MAX_TURNS,
    InMemoryConversationStore,
    Session,
    Turn,
    last_cited_ids,
    resolve_followup,
)

USER = "u_lucas"


def agent_turn(*ids: str, text: str = "answer") -> Turn:
    return Turn(role="agent", text=text, cited_node_ids=ids)


def user_turn(text: str = "question") -> Turn:
    return Turn(role="user", text=text)


# --- append_turn: create then accumulate ---


async def test_append_turn_creates_session_then_accumulates() -> None:
    store = InMemoryConversationStore()
    assert await store.get(USER) is None  # nothing yet

    s1 = await store.append_turn(USER, user_turn("what did Lucas suggest?"))
    assert s1.user_id == USER
    assert len(s1.turns) == 1

    s2 = await store.append_turn(USER, agent_turn("n1", "n2"))
    assert len(s2.turns) == 2
    assert s2.turns[-1].cited_node_ids == ("n1", "n2")
    assert (await store.get(USER)) == s2  # persisted


async def test_save_and_get_round_trip() -> None:
    store = InMemoryConversationStore()
    session = Session(user_id=USER, turns=(user_turn(), agent_turn("n1")))
    await store.save(session)
    assert await store.get(USER) == session


# --- MAX_TURNS cap keeps the most recent ---


async def test_max_turns_cap_keeps_most_recent() -> None:
    store = InMemoryConversationStore()
    for i in range(MAX_TURNS + 5):
        session = await store.append_turn(USER, user_turn(f"q{i}"))
    assert len(session.turns) == MAX_TURNS
    # Oldest five dropped; the last retained window is q5..q(MAX_TURNS+4).
    assert session.turns[0].text == "q5"
    assert session.turns[-1].text == f"q{MAX_TURNS + 4}"


# --- last_cited_ids ---


def test_last_cited_ids_returns_latest_agent_turn_ignoring_later_user_turns() -> None:
    session = Session(
        user_id=USER,
        turns=(
            user_turn("q1"),
            agent_turn("old1"),
            user_turn("q2"),
            agent_turn("n1", "n2"),
            user_turn("expand on that"),  # later user turn has no cites
        ),
    )
    assert last_cited_ids(session) == ("n1", "n2")
    assert session.last_cited_ids() == ("n1", "n2")  # method delegates to the function


def test_last_cited_ids_empty_when_no_agent_turn() -> None:
    session = Session(user_id=USER, turns=(user_turn("q1"), user_turn("q2")))
    assert last_cited_ids(session) == ()


# --- resolve_followup ---


def test_resolve_followup_returns_ids_for_expand_on_that() -> None:
    session = Session(user_id=USER, turns=(user_turn("q"), agent_turn("n1", "n2")))
    assert resolve_followup(session, "expand on that") == ("n1", "n2")


@pytest.mark.parametrize(
    "text",
    ["who else touched it", "what changed since?", "tell me more", "that idea", "more on that"],
)
def test_resolve_followup_recognizes_deictic_phrases(text: str) -> None:
    session = Session(user_id=USER, turns=(agent_turn("n1"),))
    assert resolve_followup(session, text) == ("n1",)


def test_resolve_followup_empty_for_fresh_substantive_query() -> None:
    session = Session(user_id=USER, turns=(agent_turn("n1", "n2"),))
    fresh = "what did Lucas suggest last week about the X protein?"
    assert resolve_followup(session, fresh) == ()


def test_resolve_followup_empty_when_nothing_cited() -> None:
    # A follow-up on an answer that grounded nothing must not invent a referent (hard-rule 1).
    session = Session(user_id=USER, turns=(user_turn("q"), agent_turn()))
    assert resolve_followup(session, "expand on that") == ()

"""[Brain] Per-user conversation state + deictic follow-up coreference (BUILD_PLAN.md §4.5).

Multi-turn is a **primary** ask mode (CLAUDE.md §1: "follow-ups on any of the above" —
*"expand on that"*, *"who else touched it"*, *"what changed since?"*). Those queries carry no
retrievable content on their own; their meaning lives in the *previous* answer. This module keeps
the minimal per-user session context needed to resolve them:

* a bounded rolling log of recent turns, and
* the node IDs the last answer cited — the referent a follow-up expands against.

Design constraints (why it looks the way it does):

* **Behind a port.** :class:`ConversationStore` is the seam; Phase 0 ships the in-memory adapter
  and a Redis-backed one lands later (ENGINEERING_GUIDELINES.md §1). Domain code depends on the
  ABC, never a concrete store.
* **Immutable models.** :class:`Turn` / :class:`Session` are frozen; every mutation rebuilds via
  ``model_copy`` — no aliased frozen model is ever mutated in place.
* **Concurrency-safe append.** ``append_turn`` is load-modify-store; two follow-ups for the same
  user must not lose an update or overrun the cap, so it runs under a per-user lock
  (ENGINEERING_GUIDELINES.md §2 concurrency; §5 adversarial concurrency).
* **Untrusted input, deterministic resolution.** Query text is data (CLAUDE.md §2 hard-rule 7):
  :func:`resolve_followup` is purely lexical — it matches a fixed pattern table and NEVER
  ``eval``/``exec``s or otherwise executes the text. No LLM in this path.

The referent contract (hard-rule 1, no fabricated attribution): a follow-up expands only the node
IDs an *agent* turn actually cited. If the last answer cited nothing, a follow-up resolves to the
empty set and the caller falls back to full retrieval rather than inventing a target.
"""

from __future__ import annotations

import asyncio
import re
from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel, ConfigDict

from claymore.domain import UserId

# --- tunable constants (no magic numbers scattered in logic, ENGINEERING_GUIDELINES §1) ---

MAX_TURNS = 20
"""Rolling cap on retained turns per session — keep the most recent N. Follow-up coreference
only ever needs the last answer; the small history exists for future multi-hop context. Bounding
it keeps memory flat in a long-running worker (ENGINEERING_GUIDELINES §2)."""

MAX_FOLLOWUP_SCAN_CHARS = 256
"""Prefix of a query actually scanned for follow-up cues. A deictic follow-up is short by nature;
capping keeps a pathological 100k-char input cheap and can't change a real-world result."""

_MAX_ANAPHORIC_WORDS = 6
"""A pronoun-led query longer than this is treated as substantive, not a follow-up. "that idea"
is a follow-up; "this assay buffer we discussed for the docking run last spring" is a new query."""

# Standalone anaphors: when a short query *leads* with one of these, its subject is the previous
# answer ("that idea", "it did?", "those results"). ASCII-only on purpose — a unicode lookalike
# must not read as an anaphor (mirrors the temporal resolver's untrusted-input stance).
_ANAPHORS: frozenset[str] = frozenset({"that", "it", "this", "these", "those", "them", "they"})

# Fixed phrase table. Each is matched with ``search`` against the normalized query; a hit means
# "the user is asking to continue on the previous answer." Deliberately conservative so a fresh
# substantive question does not accidentally read as a follow-up.
_FOLLOWUP_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bexpand on (that|this|it|these|those)\b"),
    re.compile(r"\bmore on (that|this|it)\b"),
    re.compile(r"\btell me more\b"),
    re.compile(r"\b(say|share) more\b"),
    re.compile(r"\bgo on\b"),
    re.compile(r"\belaborate\b"),
    re.compile(r"\bwho else\b"),
    re.compile(r"\bwhat about (that|this|it)\b"),
    re.compile(r"\bwhat (changed|else)\b"),
    re.compile(r"\bwhat'?s changed\b"),
    re.compile(r"\bwhat happened since\b"),
    re.compile(r"\banything else\b"),
)

# Extract ASCII word tokens for the pronoun-lead test — unicode is intentionally not tokenized so
# lookalike characters can't spoof an anaphor.
_WORD_RE = re.compile(r"[a-z0-9']+")


class Turn(BaseModel):
    """One utterance in a conversation — a user question or an agent answer.

    Immutable. ``cited_node_ids`` is populated only on ``agent`` turns and records exactly which
    graph nodes the answer was grounded in, so a subsequent follow-up can expand that same set
    without re-guessing the referent (hard-rule 1).
    """

    model_config = ConfigDict(frozen=True)

    role: Literal["user", "agent"]
    """Who spoke: the asker (``user``) or Claymore (``agent``)."""

    text: str
    """The raw utterance. Treated as untrusted data everywhere it is read."""

    cited_node_ids: tuple[str, ...] = ()
    """Graph node IDs this turn cited (agent turns only); the referent a follow-up expands."""


class Session(BaseModel):
    """A single user's bounded conversation history.

    Immutable — :class:`ConversationStore` rebuilds it with ``model_copy`` on every append. Turns
    are oldest-first; only the most recent :data:`MAX_TURNS` are retained.
    """

    model_config = ConfigDict(frozen=True)

    user_id: UserId
    """Owner of the session (per-user scope, R13). Sessions are never shared across users."""

    turns: tuple[Turn, ...] = ()
    """Recent turns, oldest first, capped at :data:`MAX_TURNS`."""

    def last_cited_ids(self) -> tuple[str, ...]:
        """The node IDs cited by the most recent **agent** turn (``()`` if none). See
        :func:`last_cited_ids`."""
        return last_cited_ids(self)


def last_cited_ids(session: Session) -> tuple[str, ...]:
    """Return the ``cited_node_ids`` of the most recent agent turn, or ``()`` if there is none.

    Later ``user`` turns (a bare follow-up carries no cites of its own) are skipped, so this always
    reflects the last thing the *agent* actually grounded — the referent a follow-up expands.
    """
    for turn in reversed(session.turns):
        if turn.role == "agent":
            return turn.cited_node_ids
    return ()


def resolve_followup(session: Session, text: str) -> tuple[str, ...]:
    """Resolve a deictic/anaphoric follow-up to the node-ID set it refers to.

    If ``text`` reads as a follow-up on the previous answer (*"expand on that"*, *"who else"*,
    *"what changed"*, or a short pronoun-led query like *"that idea"*), return the last agent
    turn's ``cited_node_ids``; otherwise return ``()`` so the caller runs full retrieval instead.

    Purely lexical and deterministic: ``text`` is untrusted data (CLAUDE.md §2 hard-rule 7),
    matched only against a fixed pattern table — never ``eval``'d, ``exec``'d, or used to build
    code. Empty, whitespace, huge, unicode, or injection-shaped input can never raise; it simply
    fails to match and yields ``()``. A follow-up on an answer that cited nothing also yields
    ``()`` (never invent a referent, hard-rule 1).
    """
    if not _is_followup(text):
        return ()
    return last_cited_ids(session)


def _is_followup(text: str) -> bool:
    """Whether ``text`` is a deictic follow-up. Pure lexical predicate over a capped prefix."""
    normalized = text.strip().lower()[:MAX_FOLLOWUP_SCAN_CHARS]
    if not normalized:
        return False
    if any(pattern.search(normalized) for pattern in _FOLLOWUP_PATTERNS):
        return True
    # A short query that *leads* with a bare anaphor points back at the previous answer.
    words = _WORD_RE.findall(normalized)
    return bool(words) and words[0] in _ANAPHORS and len(words) <= _MAX_ANAPHORIC_WORDS


class ConversationStore(ABC):
    """Per-user conversation session store (the vendor/impl seam, ENGINEERING_GUIDELINES §1).

    Phase 0 = :class:`InMemoryConversationStore`; a Redis-backed adapter lands later with the same
    contract. Sessions are strictly per-user (R13) — an implementation must never return one
    user's turns to another.
    """

    @abstractmethod
    async def get(self, user_id: UserId) -> Session | None:
        """Load a user's session, or ``None`` if they have no history yet."""

    @abstractmethod
    async def save(self, session: Session) -> None:
        """Persist a session, replacing any existing one for ``session.user_id``."""

    @abstractmethod
    async def append_turn(self, user_id: UserId, turn: Turn) -> Session:
        """Append ``turn`` to the user's session (creating it if absent), enforce the
        :data:`MAX_TURNS` cap keeping the most recent turns, and return the updated session.

        Must be atomic per user: concurrent appends for the same user never lose an update or
        overrun the cap.
        """


class InMemoryConversationStore(ConversationStore):
    """Dict-backed session store for Phase 0 / tests. Process-local, not durable.

    ``append_turn`` runs under a per-user :class:`asyncio.Lock` so concurrent follow-ups for the
    same user serialize their read-modify-write and never lose an update (ENGINEERING_GUIDELINES
    §2). Different users never contend. Frozen models are only ever *rebuilt*, never mutated.
    """

    def __init__(self) -> None:
        self._sessions: dict[UserId, Session] = {}
        self._locks: dict[UserId, asyncio.Lock] = {}
        # Guards lazy creation of the per-user locks so two tasks racing on a brand-new user get
        # the *same* lock (otherwise the first append could still be lost).
        self._locks_guard = asyncio.Lock()

    async def get(self, user_id: UserId) -> Session | None:
        return self._sessions.get(user_id)

    async def save(self, session: Session) -> None:
        self._sessions[session.user_id] = session

    async def append_turn(self, user_id: UserId, turn: Turn) -> Session:
        async with await self._lock_for(user_id):
            existing = self._sessions.get(user_id)
            turns = (existing.turns if existing else ()) + (turn,)
            session = Session(user_id=user_id, turns=turns[-MAX_TURNS:])
            self._sessions[user_id] = session
            return session

    async def _lock_for(self, user_id: UserId) -> asyncio.Lock:
        """Return the (lazily created) lock for ``user_id``, creating it atomically."""
        async with self._locks_guard:
            lock = self._locks.get(user_id)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[user_id] = lock
            return lock

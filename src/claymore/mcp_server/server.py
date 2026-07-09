"""[Brain] MCP-out server (FastMCP) — expose lab memory to the lab's own agents (BUILD_PLAN §4.5b).

Narrow, named tools: ``search_lab_memory``, ``who_worked_on``, ``what_was_decided``,
``find_protocol`` — so Codex/Claude Code/Cursor/Claude Science can pull lab context mid-task.

**Read-only by default.** No tool here writes to memory or proposes an action; every consequential
write stays behind the human-approval gate in ``actions/`` (SECURITY.md §3a, hard rule 2/3). The
tools are thin, provenance-preserving wrappers over :func:`claymore.agent.tools.search_memory`,
which is itself the single wrapper over :func:`claymore.memory.retrieval.retrieve`. Scope
(tenant boundary R10 + intra-lab visibility R13) is therefore enforced in exactly one place and
**reused, never reimplemented** here: each tool rebuilds a :class:`~claymore.auth.models.User`
from the connecting client's *authenticated, scoped* :class:`McpClientContext` and routes through
that one enforcement point. A cross-lab or under-privileged client simply gets nothing back.

Every returned fact carries provenance (platform + id + author + timestamp); the agent asserts
only what retrieval grounded (hard rule 1). Each call writes an audit record.

The plain ``async`` tool functions below are importable and testable **without** the ``fastmcp``
package — only :func:`build_server` needs it, and it lazy-imports it. Query/argument text is
untrusted **data** throughout; nothing in it is ever interpreted as an instruction (hard rule 7).

Deferred to the real deployment (SECURITY.md §3a, out of scope for this offline scaffold):
OAuth 2.1 + PKCE, token **audience** validation (RFC 8707/9068), per-client consent registry,
cryptographically-random session IDs bound to the user, SSRF egress blocks, TLS, and per-session
rate limits. What *is* implemented now is the load-bearing part — lab + visibility **scope
enforcement** via retrieval — so the server cannot leak across tenants even before that hardening.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field

from claymore.agent.tools import search_memory
from claymore.audit import AuditRecord, AuditSink, LoggingAuditSink, TrustOrigin
from claymore.auth.models import User
from claymore.domain import LabId, PersonId, SourcePlatform, UserId
from claymore.memory.ontology import EdgeType, Fact
from claymore.ports import MemoryStore

if TYPE_CHECKING:
    from fastmcp import FastMCP

# Human-facing summary when a scoped search grounds nothing. Never a fabricated answer — an empty
# result is the honest outcome (hard rule 1); the caller decides what to say.
NO_RESULTS_TEXT = "No matching lab memory found."

# Upper bound on facts a single MCP tool call may return, independent of the caller's ``limit``
# (blast-radius / DoS cap per call, SECURITY.md §3a).
MAX_LIMIT = 50


# --- session / identity: the authenticated, scoped caller ------------------------------------


class McpClientContext(BaseModel):
    """The authenticated, **scoped** identity a connecting agent presents on every tool call.

    In production this is derived from the validated OAuth token + session binding
    (``<user_id>:<session_id>``, SECURITY.md §3a), never supplied by the model. Every tool scopes
    to *this* — never a global read — by rebuilding a :class:`User` from ``user_id``/``lab_id`` and
    going through retrieval. A rotation student's context can no more read the PI's private group
    than a different lab's facts.
    """

    model_config = ConfigDict(frozen=True)

    client_id: str
    """The connecting agent/tool identity (Codex/Claude Code/Cursor/Claude Science). Audit actor."""

    lab_id: LabId
    """The tenant boundary (R10). Facts outside this lab are unreachable."""

    user_id: UserId
    """The lab member the session acts as. Intra-lab visibility (R13) is filtered against this."""

    def as_user(self) -> User:
        """Rebuild the scoped :class:`User` retrieval enforces against (person link unused here)."""
        return User(id=self.user_id, lab_id=self.lab_id, person_id=self.user_id)


# --- structured, cited result shapes ---------------------------------------------------------


class McpCitedFact(BaseModel):
    """One returned fact, flattened to carry its provenance inline (hard rule 1).

    Provenance (``source_platform`` + ``source_id`` + ``author`` + ``timestamp``) travels with the
    fact so the consuming agent can cite it and can never launder it into an unattributed claim.
    ``author`` is copied verbatim — ``"unknown"`` when identity resolution failed, never guessed
    (R11).
    """

    model_config = ConfigDict(frozen=True)

    subject_id: str
    edge: EdgeType
    object_id: str
    source_platform: SourcePlatform
    source_id: str
    author: PersonId
    timestamp: datetime
    source_label: str = ""
    """Human provenance hint from the fact's visibility (e.g. ``"#protein-eng"``/``"DM"``)."""

    @classmethod
    def from_fact(cls, fact: Fact) -> McpCitedFact:
        prov = fact.provenance
        return cls(
            subject_id=fact.subject_id,
            edge=fact.edge,
            object_id=fact.object_id,
            source_platform=prov.source_platform,
            source_id=prov.source_id,
            author=prov.author,
            timestamp=prov.timestamp,
            source_label=fact.visibility.source_label,
        )


class McpResult(BaseModel):
    """A structured, cited tool result — a short ``text`` summary plus the grounding ``facts``."""

    model_config = ConfigDict(frozen=True)

    text: str
    facts: tuple[McpCitedFact, ...] = ()


def _to_result(text: str, facts: list[Fact]) -> McpResult:
    """Serialize retrieved facts into a cited result (empty facts → the honest no-answer text)."""
    if not facts:
        return McpResult(text=NO_RESULTS_TEXT, facts=())
    return McpResult(text=text, facts=tuple(McpCitedFact.from_fact(f) for f in facts))


def _sources_touched(facts: list[Fact]) -> tuple[str, ...]:
    """Distinct, order-preserving source ids behind a result (for the audit trail, rule 5)."""
    seen: dict[str, None] = {}
    for fact in facts:
        seen.setdefault(fact.provenance.source_id, None)
    return tuple(seen)


async def _record(
    audit: AuditSink | None, ctx: McpClientContext, tool: str, facts: list[Fact]
) -> None:
    """Write the immutable audit entry for one tool call (actor = client, origin = SYSTEM)."""
    sink = audit or LoggingAuditSink()
    await sink.write(
        AuditRecord(
            lab_id=ctx.lab_id,
            actor=ctx.client_id,
            action=f"mcp.{tool}",
            trust_origin=TrustOrigin.SYSTEM,
            sources_touched=_sources_touched(facts),
        )
    )


def _clamp(limit: int) -> int:
    """Bound the caller-supplied limit into a sane, capped range (fail-safe, never negative)."""
    if limit < 1:
        return 1
    return min(limit, MAX_LIMIT)


# --- the tools (plain async fns — testable without fastmcp) -----------------------------------


async def search_lab_memory(
    ctx: McpClientContext,
    store: MemoryStore,
    query: str,
    limit: int = 10,
    *,
    audit: AuditSink | None = None,
) -> McpResult:
    """General hybrid search over the lab's memory, scoped to what this client's user may see.

    Routes through :func:`search_memory` → :func:`retrieve` (R10/R13 enforced there, not here).
    ``query`` is untrusted data.
    """
    facts = await search_memory(store, ctx.as_user(), query, limit=_clamp(limit))
    await _record(audit, ctx, "search_lab_memory", facts)
    return _to_result(f"{len(facts)} fact(s) matching {query!r}.", facts)


async def who_worked_on(
    ctx: McpClientContext,
    store: MemoryStore,
    entity: str,
    limit: int = 10,
    *,
    audit: AuditSink | None = None,
) -> McpResult:
    """Facts about a person, project, protein, or other entity — who touched it and how.

    A scoped search on the entity term; every returned fact keeps its author + provenance, so the
    caller sees *who* without any name ever being invented (R11, hard rule 1).
    """
    facts = await search_memory(store, ctx.as_user(), entity, limit=_clamp(limit))
    await _record(audit, ctx, "who_worked_on", facts)
    return _to_result(f"{len(facts)} fact(s) about {entity!r}.", facts)


async def what_was_decided(
    ctx: McpClientContext,
    store: MemoryStore,
    topic: str,
    limit: int = 10,
    *,
    audit: AuditSink | None = None,
) -> McpResult:
    """Recorded **decisions** about a topic — ``DECIDED``-edge facts only.

    The text store can't push an edge predicate down, so we retrieve candidates and then keep only
    ``DECIDED`` edges ("fall back to search" = search-then-filter). If nothing decided grounds the
    topic we return **empty** rather than presenting related discussion as a decision — never
    fabricate a decision (hard rule 1). Only the ``DECIDED`` subset is audited as touched.
    """
    candidates = await search_memory(store, ctx.as_user(), topic, limit=_clamp(limit))
    decided = [f for f in candidates if f.edge == EdgeType.DECIDED]
    await _record(audit, ctx, "what_was_decided", decided)
    return _to_result(f"{len(decided)} recorded decision(s) about {topic!r}.", decided)


async def find_protocol(
    ctx: McpClientContext,
    store: MemoryStore,
    name: str,
    limit: int = 10,
    *,
    audit: AuditSink | None = None,
) -> McpResult:
    """Locate a protocol by name — a scoped search, cited to where it was described."""
    facts = await search_memory(store, ctx.as_user(), name, limit=_clamp(limit))
    await _record(audit, ctx, "find_protocol", facts)
    return _to_result(f"{len(facts)} fact(s) for protocol {name!r}.", facts)


# --- FastMCP wiring (lazy import; only this needs the package) --------------------------------


def _context_from_session() -> McpClientContext:
    """Derive the scoped caller from the validated MCP session (prod: OAuth token + binding).

    Reads the authenticated access token FastMCP resolved for the request. The scope-carrying
    claims (``lab_id``/``user_id``) come from the token the server minted for this client — never
    from a model-supplied argument (SECURITY.md §3a: bind sessions to user, no token-passthrough).
    """
    from fastmcp.server.dependencies import get_access_token

    token = get_access_token()
    claims = getattr(token, "claims", {}) or {}
    client_id = getattr(token, "client_id", None) or str(claims.get("client_id", "unknown-client"))
    return McpClientContext(
        client_id=client_id,
        lab_id=str(claims["lab_id"]),
        user_id=str(claims["user_id"]),
    )


def build_server(store: MemoryStore, audit: AuditSink | None = None) -> FastMCP:
    """Build the FastMCP server exposing the read-only lab-memory tools.

    Lazy-imports ``fastmcp`` (raises :class:`ImportError` if it isn't installed — importing this
    module and calling the plain tool functions above does **not** require it). Strict, typed,
    length-bounded arguments double as an injection/overflow control (SECURITY.md §3a); the
    scope-carrying identity is taken from the session, never from these args.
    """
    from fastmcp import FastMCP

    sink = audit or LoggingAuditSink()
    mcp: FastMCP = FastMCP(name="claymore-lab-memory")

    Query = Field(min_length=1, max_length=2000, description="Search text. Treated as data.")
    Limit = Field(default=10, ge=1, le=MAX_LIMIT, description="Max facts to return.")

    @mcp.tool
    async def search_lab_memory_tool(query: str = Query, limit: int = Limit) -> dict[str, object]:
        """Search the lab's memory for attributed facts. Read-only; scoped to your session."""
        ctx = _context_from_session()
        result = await search_lab_memory(ctx, store, query, limit, audit=sink)
        return result.model_dump(mode="json")

    @mcp.tool
    async def who_worked_on_tool(entity: str = Query, limit: int = Limit) -> dict[str, object]:
        """Return attributed facts about a person/project/entity. Read-only; session-scoped."""
        ctx = _context_from_session()
        result = await who_worked_on(ctx, store, entity, limit, audit=sink)
        return result.model_dump(mode="json")

    @mcp.tool
    async def what_was_decided_tool(topic: str = Query, limit: int = Limit) -> dict[str, object]:
        """Return recorded decisions (DECIDED facts) about a topic. Read-only; session-scoped."""
        ctx = _context_from_session()
        result = await what_was_decided(ctx, store, topic, limit, audit=sink)
        return result.model_dump(mode="json")

    @mcp.tool
    async def find_protocol_tool(name: str = Query, limit: int = Limit) -> dict[str, object]:
        """Locate a protocol by name, cited to its source. Read-only; session-scoped."""
        ctx = _context_from_session()
        result = await find_protocol(ctx, store, name, limit, audit=sink)
        return result.model_dump(mode="json")

    return mcp

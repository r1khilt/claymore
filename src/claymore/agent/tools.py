"""[Brain] Agent tool definitions — the read tool + the non-executing write proposers.

The agent's capability surface is deliberately split in two, and that split is a security
control, not an ergonomic one (SECURITY.md §3a, CLAUDE.md hard rule 7 — the "lethal trifecta"):

* **Read** — :func:`search_memory` is the ONLY data-access tool. It is a thin wrapper over
  :func:`claymore.memory.retrieval.retrieve`, so tenant + visibility scoping (R10/R13) is
  enforced in exactly one place and never reimplemented here (DRY). An extraction/reader context
  that must handle untrusted content can be handed *only* this tool and thus can never act.
* **Write** — :func:`propose_draft_reply`, :func:`propose_file_issue`,
  :func:`propose_create_page` are *proposers*: each returns a :class:`PendingAction` and performs
  **no side effect** (hard rule 3). Execution happens elsewhere, only after an explicit human
  ✅ through the approval gate. The action agent works on structured, provenance-tagged facts;
  untrusted body/title text is embedded inertly in the action ``payload`` and is never parsed or
  interpreted as an instruction (hard rule 7).

:data:`TOOL_SCHEMAS` declares strict JSON-schema args for each tool. Strict schemas
(``additionalProperties: false`` + explicit ``required``) are themselves a defense: they bound
what an injected instruction can smuggle into a tool call (SECURITY.md §3a).

Treat both the ``query`` and any ``Fact`` content as untrusted data throughout.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict

from claymore.actions.approvals import ActionKind, PendingAction
from claymore.agent import Citation
from claymore.auth.models import User
from claymore.memory.ontology import Fact
from claymore.memory.retrieval import retrieve
from claymore.ports import MemoryStore

# --- read tool: the core of "Ask" ------------------------------------------------------------


async def search_memory(
    store: MemoryStore,
    user: User,
    query: str,
    *,
    limit: int = 10,
    min_extraction_confidence: float = 0.0,
) -> list[Fact]:
    """Search the asking user's lab memory for facts they are allowed to see.

    Thin, correct wrapper over :func:`retrieve` — the single enforcement point for the tenant
    boundary (R10) and intra-lab visibility (R13). We do NOT reimplement scoping here; doing so
    would create a second, drift-prone copy of the security-critical filter. ``query`` is
    untrusted user input and is treated as data only (never as instructions).
    """
    return await retrieve(
        store,
        user,
        query,
        limit=limit,
        min_extraction_confidence=min_extraction_confidence,
    )


def facts_to_citations(facts: Sequence[Fact]) -> tuple[Citation, ...]:
    """Map each fact's provenance to a :class:`Citation`, deduped, order-preserving.

    Every asserted claim must carry a source (hard rule 1). Several facts often share one source
    episode (e.g. an ``AUTHORED_BY`` and a ``MENTIONS`` edge from the same Slack message), so
    identical citations collapse to one. Author is copied verbatim from provenance — when
    identity resolution failed it is ``"unknown"``, and we surface that rather than fabricate a
    name (R11). The source label / attribution here is never invented.
    """
    seen: set[tuple[str, str, str, str]] = set()
    citations: list[Citation] = []
    for fact in facts:
        prov = fact.provenance
        key = (
            str(prov.source_platform),
            prov.source_id,
            prov.author,
            prov.timestamp.isoformat(),
        )
        if key in seen:
            continue
        seen.add(key)
        citations.append(
            Citation(
                source_platform=prov.source_platform,
                source_id=prov.source_id,
                author=prov.author,
                timestamp=prov.timestamp,
                quote=fact.statement.strip()[:280],
            )
        )
    return tuple(citations)


# --- write tools: proposers only (never execute — hard rule 3) --------------------------------


def _idempotency_key(kind: ActionKind, user: User, payload: dict[str, str]) -> str:
    """Deterministic key over (kind, requester, payload) so re-proposing the same write yields
    the same key — a lost ack can't double-file (approvals.py, R-idempotency)."""
    canonical = "|".join(
        [kind.value, user.lab_id, user.id, *(f"{k}={payload[k]}" for k in sorted(payload))]
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _propose(
    kind: ActionKind, user: User, description: str, payload: dict[str, str]
) -> PendingAction:
    """Build a PENDING action. Never executes; the human-approval gate assigns the SMS token and
    runs it later. The provisional token is derived from the idempotency key for traceability."""
    idem = _idempotency_key(kind, user, payload)
    return PendingAction(
        token=f"P{idem[:8]}",  # provisional; the gate reassigns a short SMS token on request()
        lab_id=user.lab_id,
        requested_by=user.id,
        kind=kind,
        description=description,
        payload=payload,
        idempotency_key=idem,
    )


def propose_draft_reply(
    user: User, *, channel: str, body: str, recipient: str = ""
) -> PendingAction:
    """Propose (do NOT send) a reply. ``body``/``recipient`` are untrusted data embedded inertly
    in the payload; nothing is transmitted until a human approves (hard rule 3)."""
    payload = {"channel": channel, "recipient": recipient, "body": body}
    return _propose(ActionKind.DRAFT_REPLY, user, f"Draft a reply in {channel!r}", payload)


def propose_file_issue(user: User, *, repo: str, title: str, body: str) -> PendingAction:
    """Propose (do NOT file) a GitHub issue. Executed only after human approval (hard rule 3)."""
    payload = {"repo": repo, "title": title, "body": body}
    return _propose(ActionKind.FILE_ISSUE, user, f"File an issue in {repo!r}", payload)


def propose_create_page(user: User, *, title: str, body: str, parent: str = "") -> PendingAction:
    """Propose (do NOT create) a Notion/Docs page. Executed only after human approval (rule 3)."""
    payload = {"title": title, "body": body, "parent": parent}
    return _propose(ActionKind.CREATE_PAGE, user, f"Create a page titled {title!r}", payload)


# --- tool schema registry (strict args = a security control, SECURITY.md §3a) -----------------


class ToolSchema(BaseModel):
    """A tool's LLM-facing contract: name, description, and a strict JSON-schema for its args.

    ``input_schema`` describes only the args the model supplies — the ``store`` / ``user`` a tool
    needs are injected by the router, never model-controlled. Strict schemas
    (``additionalProperties: false``) bound what an injected instruction can smuggle in.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    description: str
    input_schema: dict[str, object]


def _strict(properties: dict[str, object], required: list[str]) -> dict[str, object]:
    """A closed JSON-schema object: only the declared keys, only the required ones optional-free."""
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


TOOL_SCHEMAS: tuple[ToolSchema, ...] = (
    ToolSchema(
        name="search_memory",
        description=(
            "Search the lab's memory for attributed facts relevant to a question. "
            "Returns provenance-bearing facts scoped to what the asking user may see. "
            "This is the only way to read lab memory; it cannot change anything."
        ),
        input_schema=_strict(
            {
                "query": {
                    "type": "string",
                    "description": "The natural-language question to search for. Treated as data.",
                    "minLength": 1,
                    "maxLength": 2000,
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of facts to return.",
                    "minimum": 1,
                    "maximum": 50,
                },
                "min_extraction_confidence": {
                    "type": "number",
                    "description": "Drop facts extracted below this confidence (0.0-1.0).",
                    "minimum": 0.0,
                    "maximum": 1.0,
                },
            },
            required=["query"],
        ),
    ),
    ToolSchema(
        name="propose_draft_reply",
        description=(
            "Propose a reply to a message. Does NOT send it — it creates a pending action a "
            "human must approve first."
        ),
        input_schema=_strict(
            {
                "channel": {"type": "string", "description": "Channel/thread to reply in."},
                "recipient": {"type": "string", "description": "Recipient handle, if a DM."},
                "body": {"type": "string", "description": "The proposed reply text."},
            },
            required=["channel", "body"],
        ),
    ),
    ToolSchema(
        name="propose_file_issue",
        description=(
            "Propose filing a GitHub issue. Does NOT file it — it creates a pending action a "
            "human must approve first."
        ),
        input_schema=_strict(
            {
                "repo": {"type": "string", "description": "owner/repo to file the issue in."},
                "title": {"type": "string", "description": "The issue title."},
                "body": {"type": "string", "description": "The issue body."},
            },
            required=["repo", "title", "body"],
        ),
    ),
    ToolSchema(
        name="propose_create_page",
        description=(
            "Propose creating a Notion/Docs page. Does NOT create it — it creates a pending "
            "action a human must approve first."
        ),
        input_schema=_strict(
            {
                "title": {"type": "string", "description": "The page title."},
                "body": {"type": "string", "description": "The page body."},
                "parent": {"type": "string", "description": "Parent page/space, if any."},
            },
            required=["title", "body"],
        ),
    ),
)

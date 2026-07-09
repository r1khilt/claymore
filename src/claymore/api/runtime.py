"""Assemble the production ``AgentRuntime`` from settings — the Brain↔Pipes glue.

``agent.handle`` runs whatever runtime was installed at startup. This module decides which one:
with the real keys present (Anthropic for reasoning, Voyage for Graphiti's hybrid search) it
wires the FalkorDB-backed :class:`GraphitiMemoryStore` + :class:`AnthropicLLM`; otherwise it
returns ``None`` and the caller stays on the safe in-memory default (FakeLLM, empty store) so a
keyless checkout still boots and answers honestly.

The runtime's ``store`` is deliberately shared with the admin ingest routes
(``agent.get_runtime().store``): the Graphiti wrapper keeps its provenance sidecar in-process,
so ingest and ask MUST run against the same instance until the Postgres state layer lands.
"""

from __future__ import annotations

from pydantic import TypeAdapter

from claymore.agent.router import AgentRuntime
from claymore.auth.models import User
from claymore.config import Settings
from claymore.logging import get_logger

_log = get_logger("api.runtime")

_ROSTER_ADAPTER = TypeAdapter(list[User])


def roster_from_json(spec: str) -> list[User]:
    """Parse the ``LAB_ROSTER_JSON`` roster. Malformed JSON raises at startup — a silently
    empty roster would make every author resolve to ``unknown``, which reads like an ingest
    bug rather than the config mistake it is."""
    if not spec.strip():
        return []
    return _ROSTER_ADAPTER.validate_json(spec)


def build_runtime(settings: Settings) -> AgentRuntime | None:
    """Build the real-adapter runtime, or ``None`` when required keys are missing.

    Real mode needs both the Anthropic key (query reasoning + Graphiti extraction) and the
    Voyage key (embeddings for hybrid search). Partial configuration falls back to the
    in-memory default rather than a runtime that would fail on first use.
    """
    if not (
        settings.anthropic_api_key.get_secret_value() and settings.voyage_api_key.get_secret_value()
    ):
        _log.info("runtime.default", reason="missing anthropic/voyage keys")
        return None
    from claymore.agent.llm import AnthropicLLM
    from claymore.memory.graph import GraphitiMemoryStore

    _log.info("runtime.real", falkordb=settings.falkordb_uri)
    return AgentRuntime(store=GraphitiMemoryStore(settings), llm=AnthropicLLM(settings))

"""[Brain] The ``MemoryStore`` adapters (CLAUDE.md §4, R6/R10/R13/R14).

Two implementations of ``claymore.ports.MemoryStore``:

- ``GraphitiMemoryStore`` — the real adapter: Graphiti on FalkorDB, one FalkorDB *database per
  lab* (hard tenant isolation, R10), cheap-model extraction (R6), hybrid retrieval. Requires
  the ``memory`` extra + a running FalkorDB + API keys.
- ``InMemoryMemoryStore`` — Phase-0/dev/test double with deterministic (LLM-free) extraction,
  so downstream layers (agent, retrieval, evals) develop against real ``Fact`` shapes without
  services or spend. Same contract, same scoping rules.

Scoping model (decided here, referenced by retrieval.py): the graph partition (``group_id`` /
database) is the **lab** — the R10 tenant boundary. Fine-grained intra-lab need-to-know is NOT
a graph partition; it is enforced at retrieval time by filtering each ``Fact.visibility``
(R13, ``memory/retrieval.py``). Partitioning per user would force duplicating every lab-wide
fact into every member's partition.

Provenance rule (hard rule 1): a search hit whose provenance cannot be recovered is dropped and
logged, never returned unattributed.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import structlog

from claymore.config import Settings
from claymore.domain import UNKNOWN_AUTHOR, LabId, Visibility, most_restrictive
from claymore.ingest.normalize import Episode
from claymore.memory.ontology import EdgeType, Fact, Provenance
from claymore.ports import MemoryStore

if TYPE_CHECKING:
    from graphiti_core import Graphiti

logger = structlog.get_logger(__name__)


def ensure_aware(dt: datetime) -> datetime:
    """Coerce a naive datetime to UTC-aware (bi-temporal ordering breaks on mixed tz-ness).

    Sources should emit aware timestamps; a naive one is *assumed* UTC and logged, because
    silently comparing naive and aware datetimes raises at query time — much later and far from
    the cause.
    """
    if dt.tzinfo is None:
        logger.warning("memory.naive_timestamp_assumed_utc")
        return dt.replace(tzinfo=UTC)
    return dt


def episode_key(episode: Episode) -> str:
    """Stable dedup identity for an episode (R6: never re-extract unchanged content)."""
    return f"{episode.source_platform}:{episode.source_id}:{episode.source_hash or ''}"


class InMemoryMemoryStore(MemoryStore):
    """Deterministic, dependency-free ``MemoryStore`` (Phase 0 / tests / fixtures).

    Extraction is intentionally trivial — one ``AUTHORED_BY`` fact per attributed episode and
    one ``MENTIONS`` fact per ``ref`` — because its job is to exercise the *contract* (scoping,
    provenance, dedup, temporal fields), not to be smart. Episode text is treated strictly as
    data: nothing in it is interpreted, executed, or matched as instructions (SECURITY.md).
    """

    def __init__(self) -> None:
        # lab_id → episode_key → extracted facts (+ searchable text alongside each fact)
        self._facts: dict[LabId, dict[str, list[tuple[Fact, str]]]] = {}

    async def add_episode(self, episode: Episode) -> None:
        lab = self._facts.setdefault(episode.lab_id, {})
        key = episode_key(episode)
        if key in lab:  # idempotent: replays and duplicate deliveries are expected (R6/R14)
            return
        provenance = Provenance(
            source_platform=episode.source_platform,
            source_id=episode.source_id,
            timestamp=ensure_aware(episode.timestamp),
            author=episode.author,
        )
        facts: list[tuple[Fact, str]] = []
        subject = f"{episode.source_platform}:{episode.source_id}"
        if episode.author != UNKNOWN_AUTHOR:
            facts.append(
                (
                    Fact(
                        subject_id=subject,
                        edge=EdgeType.AUTHORED_BY,
                        object_id=episode.author,
                        valid_from=provenance.timestamp,
                        provenance=provenance,
                        visibility=episode.visibility,
                    ),
                    episode.text,
                )
            )
        for ref in episode.refs:
            facts.append(
                (
                    Fact(
                        subject_id=subject,
                        edge=EdgeType.MENTIONS,
                        object_id=ref,
                        valid_from=provenance.timestamp,
                        provenance=provenance,
                        visibility=episode.visibility,
                    ),
                    episode.text,
                )
            )
        lab[key] = facts

    async def search(
        self, lab_id: LabId, query: str, *, group_ids: Sequence[str], limit: int = 10
    ) -> list[Fact]:
        # Tenant scoping first (R10): only this lab's store, and only if the caller explicitly
        # asked for it — an empty group_ids or one not containing the lab returns nothing
        # rather than everything (fail closed, mirrors "never a global search").
        if lab_id not in group_ids:
            return []
        terms = [t for t in query.casefold().split() if t]
        if not terms:
            return []
        hits: list[tuple[datetime, Fact]] = []
        for facts in self._facts.get(lab_id, {}).values():
            for fact, text in facts:
                haystack = f"{text} {fact.subject_id} {fact.object_id}".casefold()
                if any(term in haystack for term in terms):
                    hits.append((fact.provenance.timestamp, fact))
        hits.sort(key=lambda pair: pair[0], reverse=True)  # recency as the tiebreak ranking
        return [fact for _, fact in hits[:limit]]

    async def build_indices(self, lab_id: LabId) -> None:
        self._facts.setdefault(lab_id, {})


class GraphitiMemoryStore(MemoryStore):
    """Graphiti-on-FalkorDB adapter. One FalkorDB database per lab (R10).

    Provenance/visibility sidecar: Graphiti's ``EntityEdge`` records which episode UUIDs support
    a fact, but not our platform-level provenance. ``add_episode`` therefore records
    ``graphiti episode uuid → (Provenance, Visibility)`` and ``search`` joins back through it;
    a fact whose episodes are all unknown to the sidecar is dropped (hard rule 1).
    TODO(state layer): persist the sidecar in Postgres alongside the durable Episode log (R14)
    so it survives restarts; today a restart means re-adding episodes (idempotent).
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._clients: dict[LabId, Graphiti] = {}
        self._seen: dict[LabId, set[str]] = {}  # episode_key dedup (R6)
        self._sidecar: dict[LabId, dict[str, tuple[Provenance, Visibility]]] = {}

    def _client(self, lab_id: LabId) -> Graphiti:
        """Lazily build one Graphiti client per lab, isolated by FalkorDB database name."""
        if lab_id in self._clients:
            return self._clients[lab_id]
        from urllib.parse import urlparse

        from graphiti_core import Graphiti
        from graphiti_core.driver.falkordb_driver import FalkorDriver
        from graphiti_core.embedder.voyage import VoyageAIEmbedder, VoyageAIEmbedderConfig
        from graphiti_core.llm_client.anthropic_client import AnthropicClient
        from graphiti_core.llm_client.config import LLMConfig

        uri = urlparse(self._settings.falkordb_uri)
        driver = FalkorDriver(
            host=uri.hostname or "localhost",
            port=uri.port or 6379,
            # Database name is the isolation boundary — derived from lab_id only (R10).
            database=f"lab-{lab_id}",
        )
        client = Graphiti(
            graph_driver=driver,
            llm_client=AnthropicClient(
                LLMConfig(
                    api_key=self._settings.anthropic_api_key.get_secret_value(),
                    model=self._settings.extraction_model,  # cheap model for extraction (R6)
                    small_model=self._settings.extraction_model,
                )
            ),
            embedder=VoyageAIEmbedder(
                VoyageAIEmbedderConfig(api_key=self._settings.voyage_api_key.get_secret_value())
            ),
            max_coroutines=self._settings.graphiti_semaphore_limit,
        )
        self._clients[lab_id] = client
        return client

    async def add_episode(self, episode: Episode) -> None:
        key = episode_key(episode)
        if key in self._seen.setdefault(episode.lab_id, set()):
            return
        from graphiti_core.nodes import EpisodeType

        reference_time = ensure_aware(episode.timestamp)
        result = await self._client(episode.lab_id).add_episode(
            name=f"{episode.source_platform}:{episode.source_id}",
            episode_body=episode.text,
            # Description is metadata only — never instructions derived from content.
            source_description=(
                f"{episode.source_platform} | author={episode.author} | "
                f"{episode.visibility.source_label or 'unlabeled'}"
            ),
            reference_time=reference_time,
            source=EpisodeType.message,
            group_id=episode.lab_id,
        )
        provenance = Provenance(
            source_platform=episode.source_platform,
            source_id=episode.source_id,
            timestamp=reference_time,
            author=episode.author,
        )
        self._sidecar.setdefault(episode.lab_id, {})[result.episode.uuid] = (
            provenance,
            episode.visibility,
        )
        self._seen[episode.lab_id].add(key)
        logger.info(
            "memory.episode_added",
            lab_id=episode.lab_id,
            platform=episode.source_platform,
            source_id=episode.source_id,
        )

    async def search(
        self, lab_id: LabId, query: str, *, group_ids: Sequence[str], limit: int = 10
    ) -> list[Fact]:
        if lab_id not in group_ids:  # fail closed, same rule as the in-memory store
            return []
        if not query.strip():
            return []
        edges = await self._client(lab_id).search(query, group_ids=[lab_id], num_results=limit)
        sidecar = self._sidecar.get(lab_id, {})
        facts: list[Fact] = []
        for edge in edges:
            supports = [sidecar[uuid] for uuid in edge.episodes if uuid in sidecar]
            if not supports:
                # No recoverable provenance → never assert the fact (hard rule 1).
                logger.warning("memory.fact_dropped_no_provenance", lab_id=lab_id)
                continue
            provenance = supports[0][0]
            visibility = supports[0][1]
            for _, vis in supports[1:]:
                visibility = most_restrictive(visibility, vis)  # fail-closed merge (R13)
            try:
                edge_type = EdgeType(edge.name)
            except ValueError:
                edge_type = EdgeType.MENTIONS  # graphiti free-form relations map to MENTIONS
            facts.append(
                Fact(
                    subject_id=edge.source_node_uuid,
                    edge=edge_type,
                    object_id=edge.target_node_uuid,
                    valid_from=ensure_aware(edge.valid_at or provenance.timestamp),
                    valid_to=ensure_aware(edge.invalid_at) if edge.invalid_at else None,
                    provenance=provenance,
                    visibility=visibility,
                )
            )
        return facts

    async def build_indices(self, lab_id: LabId) -> None:
        await self._client(lab_id).build_indices_and_constraints()

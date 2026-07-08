"""The vendor-swap seams (ENGINEERING_GUIDELINES.md §1, R9).

Every external vendor sits behind one of these narrow interfaces. Domain code depends on the
interface, never a concrete SDK — so swapping a vendor is one new adapter with zero changes to
core, and each adapter is testable in isolation. Adapters live in their owning module
(``memory/graph.py`` implements ``MemoryStore``, ``messaging/telegram.py`` implements
``MessagingChannel``, …).

These signatures are a frozen contract. Keep them narrow: expose named capabilities, not raw
SDK surface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Sequence
from datetime import datetime

from pydantic import BaseModel

from claymore.domain import LabId, SourcePlatform
from claymore.ingest.normalize import Episode
from claymore.memory.ontology import Fact


class ComputeResult(BaseModel):
    """Outcome of a sandboxed run — reproducible artifacts, not just stdout (SECURITY.md §4)."""

    ok: bool
    summary: str
    code: str
    artifacts: tuple[str, ...] = ()
    logs: str = ""


class MemoryStore(ABC):
    """Graph memory (Graphiti/FalkorDB today). Bi-temporal facts + episodic provenance."""

    @abstractmethod
    async def add_episode(self, episode: Episode) -> None:
        """Extract + persist a single episode's facts into the lab's graph."""

    @abstractmethod
    async def search(
        self, lab_id: LabId, query: str, *, group_ids: Sequence[str], limit: int = 10
    ) -> list[Fact]:
        """Hybrid (graph+vector+BM25+temporal) retrieval, scoped to explicit ``group_ids``
        (never a global search — cross-tenant leak, R10/R13)."""

    @abstractmethod
    async def build_indices(self, lab_id: LabId) -> None:
        """One-time index/constraint setup per lab graph (call once, not per request)."""


class ConnectorHub(ABC):
    """Managed source connectors (Composio today) — read side."""

    @abstractmethod
    def backfill(
        self, lab_id: LabId, source: SourcePlatform, since: datetime | None = None
    ) -> AsyncIterator[Episode]:
        """Stream historical Episodes (paged/generator — never slurp a whole history, R6/§2)."""

    @abstractmethod
    def incremental(self, lab_id: LabId, source: SourcePlatform) -> AsyncIterator[Episode]:
        """Stream new Episodes since the last sync checkpoint."""


class LLM(ABC):
    """Anthropic today. Model routing (Haiku/Sonnet/Opus by task) lives inside the adapter."""

    @abstractmethod
    async def complete(
        self, *, system: str, prompt: str, model: str | None = None, max_tokens: int = 1024
    ) -> str:
        """One completion. ``model=None`` lets the adapter route by task/cost."""


class Embedder(ABC):
    """Embeddings for hybrid search (Voyage today). Behind a seam so it has a fallback path."""

    @abstractmethod
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed a batch of texts. Batch to control cost/latency (R6)."""


class ComputeBackend(ABC):
    """Sandboxed code execution (E2B/Modal/HPC). microVM isolation, deny-egress (SECURITY.md §4)."""

    @abstractmethod
    async def run(self, code: str, *, timeout_s: int = 300) -> ComputeResult:
        """Run untrusted/agent-generated code in an ephemeral sandbox and return artifacts."""


class MessagingChannel(ABC):
    """The chat interface (Telegram dev / Twilio SMS prod). Outbound side."""

    @abstractmethod
    async def send(self, user_id: str, text: str) -> None:
        """Deliver a message to an enrolled user over this channel."""


class SecretsProvider(ABC):
    """Runtime secret injection (env / Infisical). The LLM never sees a secret (SECURITY.md §7)."""

    @abstractmethod
    def get(self, name: str) -> str:
        """Fetch a secret by name at the infra layer."""

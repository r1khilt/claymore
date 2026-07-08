"""[Pipes] Durable append-only Episode log — the system of record (R14).

Every normalized ``Episode`` is persisted here BEFORE extraction, so the graph is a
*rebuildable projection*: losing FalkorDB never means re-hitting sources or re-paying the
per-episode extraction bill. The log also enables extraction A/B and cheap rebuilds. In prod
this is Postgres, encrypted at rest (it holds raw source text, R7); Phase 0 ships the in-memory
double below behind the same ABC so downstream layers develop without a database.

Design invariants (why this shape):

- **Append-only.** We never overwrite. An edited source item (same ``source_id``, new
  ``source_hash``) is stored as a *new version* alongside the old one — the log is the audit
  trail, and a rebuild replays every version in source-time order.
- **Dedup identity is :func:`claymore.memory.graph.episode_key`** (platform + source_id +
  source_hash), reused verbatim so the log and the graph agree on "same episode" (DRY, R6). A
  re-delivered identical episode is an idempotent no-op.
- **Per-lab scoping is a hard boundary (R10).** Iteration, counting, and replay for one lab
  never observe another lab's episodes.
- **Content is untrusted data (SECURITY.md rule 1).** Nothing in ``episode.text`` is ever
  interpreted here; the log only reads provenance/identity metadata to key and order episodes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime

from claymore.domain import LabId
from claymore.ingest.normalize import Episode
from claymore.memory.graph import ensure_aware, episode_key
from claymore.ports import MemoryStore


class EpisodeLog(ABC):
    """The durable, append-only Episode store — replay source of truth (R14).

    The real adapter (Postgres) and the Phase-0 in-memory double both implement this narrow
    contract, so :func:`replay` and every caller depend on the interface, not the backend.
    """

    @abstractmethod
    async def append(self, episode: Episode) -> bool:
        """Persist ``episode``, stamping ``ingested_at``.

        Returns ``True`` if it was newly stored, ``False`` if an identical episode (same
        :func:`episode_key`) already exists — a duplicate delivery / replay is an idempotent
        no-op (R6/R14). An edited item (same ``source_id``, different ``source_hash``) has a
        different key, so it is stored as a new version rather than deduped.
        """

    @abstractmethod
    async def exists(self, episode: Episode) -> bool:
        """Whether an episode with the same :func:`episode_key` is already in the log."""

    @abstractmethod
    def iter_since(self, lab_id: LabId, since: datetime | None = None) -> AsyncIterator[Episode]:
        """Yield ``lab_id``'s episodes ordered by source ``timestamp`` (ascending).

        ``since=None`` streams from the beginning; otherwise only episodes at or after ``since``
        (inclusive). Scoped to one lab (R10). Declared ``def`` returning an ``AsyncIterator`` so
        implementations can be ``async`` generators.
        """

    @abstractmethod
    async def count(self, lab_id: LabId) -> int:
        """How many episodes are stored for ``lab_id`` (that lab only, R10)."""


class InMemoryEpisodeLog(EpisodeLog):
    """Dependency-free ``EpisodeLog`` for Phase 0 / dev / tests.

    Storage is per-lab and append-only: a list preserves insertion (arrival) order for a stable
    tiebreak, and a companion key-set gives O(1) dedup / existence checks. ``ingested_at`` is
    stamped from an **injected clock** so tests are deterministic. The input ``Episode`` is
    frozen and is never mutated — we persist a ``model_copy`` with the stamp applied.

    Concurrency: append has no ``await`` between its dedup check and its mutation, so under a
    single event loop concurrent duplicate appends (``asyncio.gather``) store exactly once.
    """

    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._clock = clock
        # lab_id → episodes in arrival order (append-only; versions retained).
        self._episodes: dict[LabId, list[Episode]] = {}
        # lab_id → set of episode_keys already stored (dedup, R6).
        self._keys: dict[LabId, set[str]] = {}

    async def append(self, episode: Episode) -> bool:
        lab = episode.lab_id
        keys = self._keys.setdefault(lab, set())
        key = episode_key(episode)
        if key in keys:  # idempotent: duplicate delivery / replay is a no-op (R6/R14)
            return False
        # Stamp ingest time without mutating the frozen input (persistence-time provenance).
        stamped = episode.model_copy(update={"ingested_at": self._clock()})
        # No await between the check above and these mutations → atomic under asyncio.
        keys.add(key)
        self._episodes.setdefault(lab, []).append(stamped)
        return True

    async def exists(self, episode: Episode) -> bool:
        return episode_key(episode) in self._keys.get(episode.lab_id, set())

    async def iter_since(
        self, lab_id: LabId, since: datetime | None = None
    ) -> AsyncIterator[Episode]:
        cutoff = ensure_aware(since) if since is not None else None
        # Stable sort by source time; equal timestamps keep arrival order (out-of-order safe).
        ordered = sorted(self._episodes.get(lab_id, ()), key=lambda ep: ensure_aware(ep.timestamp))
        for episode in ordered:
            if cutoff is not None and ensure_aware(episode.timestamp) < cutoff:
                continue
            yield episode

    async def count(self, lab_id: LabId) -> int:
        return len(self._episodes.get(lab_id, ()))


async def replay(log: EpisodeLog, store: MemoryStore, lab_id: LabId) -> int:
    """Re-add every episode for ``lab_id`` into ``store`` in source-time order (R14).

    This is the proof that the graph is a rebuildable projection of the durable log: no source
    is re-hit and no extraction is re-paid beyond the store's own work. It is safe to run
    repeatedly — ordering is deterministic and idempotency relies on the ``MemoryStore``'s own
    dedup (:func:`episode_key`), so a second run re-adds the same episodes to no effect. Scoped
    to one lab (R10). Returns the number of episodes replayed.
    """
    replayed = 0
    async for episode in log.iter_since(lab_id, None):
        await store.add_episode(episode)
        replayed += 1
    return replayed

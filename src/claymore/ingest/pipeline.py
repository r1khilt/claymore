"""[Ingest] The end-to-end ingest pipeline: source -> identity -> durable log -> graph.

Ties the read-side connectors (``ConnectorHub``) to memory. For each Episode a source emits:

1. **Resolve identity** (R11) — canonicalize the author BEFORE anything is stored, so the graph
   never holds an unresolved handle (retrofitting identity onto a populated graph is a rewrite).
2. **Append to the durable log** (R14) — the append-only Episode log is the replay source of
   truth; the graph is a derived, rebuildable projection. Dedup here means we never re-pay
   extraction for an episode we've already seen (R6).
3. **Extract into the graph** — only episodes newly added to the log are handed to the
   ``MemoryStore`` (which is itself idempotent, so a crash mid-run is safe to re-run).

Every run writes one audit record (R5/CLAUDE.md rule 5). A single malformed episode is skipped
and logged — it never aborts the batch (a lab's whole backfill shouldn't die on one bad item).
Content stays untrusted throughout: nothing here interprets episode text (SECURITY.md rule 7).
"""

from __future__ import annotations

from datetime import datetime

import structlog
from pydantic import BaseModel, ConfigDict

from claymore.audit import AuditRecord, AuditSink, LoggingAuditSink, TrustOrigin
from claymore.domain import LabId, SourcePlatform
from claymore.ingest.episodes import EpisodeLog
from claymore.memory.identity import IdentityResolver
from claymore.ports import ConnectorHub, MemoryStore

logger = structlog.get_logger(__name__)


class IngestStats(BaseModel):
    """Outcome of one ingest run — what a caller (or the audit log) needs to see."""

    model_config = ConfigDict(frozen=True)

    lab_id: LabId
    source: SourcePlatform
    seen: int
    """Episodes streamed from the source."""

    stored: int
    """Episodes newly appended to the durable log (not duplicates)."""

    extracted: int
    """Episodes handed to the graph for extraction (== stored, minus any per-item failures)."""

    skipped_errors: int
    """Episodes dropped because parsing/resolution/extraction raised — logged, never fatal."""

    unresolved_authors: int
    """Stored episodes whose author could not be resolved to a lab person (surfaced, R11)."""


async def ingest_source(
    hub: ConnectorHub,
    log: EpisodeLog,
    store: MemoryStore,
    *,
    lab_id: LabId,
    source: SourcePlatform,
    resolver: IdentityResolver | None = None,
    since: datetime | None = None,
    audit: AuditSink | None = None,
    incremental: bool = False,
) -> IngestStats:
    """Stream a source into memory. Returns counts; writes one audit record.

    ``incremental=True`` uses the hub's incremental (since-last-checkpoint) stream instead of a
    full backfill. ``resolver`` (if given) canonicalizes authors before storage; without it,
    episodes keep whatever author the parser set (typically ``unknown`` + a raw handle in
    ``extra`` for a later resolution pass).
    """
    from claymore.domain import UNKNOWN_AUTHOR

    audit = audit or LoggingAuditSink()
    seen = stored = extracted = skipped = unresolved = 0

    stream = hub.incremental(lab_id, source) if incremental else hub.backfill(lab_id, source, since)
    async for episode in stream:
        seen += 1
        try:
            if episode.lab_id != lab_id:
                # A connector must never emit another lab's data into this run (R10).
                logger.warning(
                    "ingest.lab_mismatch",
                    expected=lab_id,
                    got=episode.lab_id,
                    source=source,
                )
                skipped += 1
                continue
            if resolver is not None:
                episode = resolver.resolve_episode(episode)
            is_new = await log.append(episode)
            if not is_new:
                continue  # duplicate — already ingested + extracted (R6)
            stored += 1
            if episode.author == UNKNOWN_AUTHOR:
                unresolved += 1
            await store.add_episode(episode)
            extracted += 1
        except Exception:
            # One bad item never aborts a whole backfill (ENGINEERING_GUIDELINES §3).
            skipped += 1
            logger.exception("ingest.episode_failed", lab_id=lab_id, source=source)

    stats = IngestStats(
        lab_id=lab_id,
        source=source,
        seen=seen,
        stored=stored,
        extracted=extracted,
        skipped_errors=skipped,
        unresolved_authors=unresolved,
    )
    await audit.write(
        AuditRecord(
            lab_id=lab_id,
            actor="ingest.pipeline",
            action=f"ingest.{source}",
            trust_origin=TrustOrigin.SYSTEM,
            detail={
                "source": str(source),
                "seen": str(seen),
                "stored": str(stored),
                "extracted": str(extracted),
                "skipped_errors": str(skipped),
                "unresolved_authors": str(unresolved),
                "mode": "incremental" if incremental else "backfill",
            },
        )
    )
    logger.info("ingest.run_complete", **stats.model_dump(mode="json"))
    return stats

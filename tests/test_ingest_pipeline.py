"""Unit tests for the end-to-end ingest pipeline (source -> identity -> log -> graph)."""

from __future__ import annotations

from claymore.audit import AuditRecord, AuditSink
from claymore.domain import UNKNOWN_AUTHOR, SourcePlatform
from claymore.ingest.composio.hub import FakeConnectorHub
from claymore.ingest.episodes import InMemoryEpisodeLog
from claymore.ingest.pipeline import ingest_source
from claymore.memory.graph import InMemoryMemoryStore
from claymore.memory.identity import IdentityResolver
from tests.fixtures import ROSTER


class _RecordingAudit(AuditSink):
    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    async def write(self, record: AuditRecord) -> None:
        self.records.append(record)


_SLACK_RAW = {
    SourcePlatform.SLACK: [
        {
            "ts": "1709467200.0001",
            "user": "@lucas",
            "text": "Suggest testing thermostability of the X protein.",
            "channel": "C1",
            "channel_name": "protein-eng",
            "is_private": False,
        },
        {
            "ts": "1709470800.0002",
            "user": "@philip",
            "text": "Docking pipeline results look good.",
            "channel": "C1",
            "channel_name": "protein-eng",
            "is_private": False,
        },
    ]
}


async def test_ingest_streams_source_into_log_and_graph() -> None:
    hub = FakeConnectorHub(_SLACK_RAW)
    log = InMemoryEpisodeLog()
    store = InMemoryMemoryStore()
    audit = _RecordingAudit()

    stats = await ingest_source(
        hub, log, store, lab_id="lab1", source=SourcePlatform.SLACK, audit=audit
    )
    assert stats.seen == 2
    assert stats.stored == 2
    assert stats.extracted == 2
    assert stats.skipped_errors == 0
    assert await log.count("lab1") == 2
    assert len(audit.records) == 1
    assert audit.records[0].action == "ingest.slack"


async def test_ingest_resolves_identity_before_storage() -> None:
    hub = FakeConnectorHub(_SLACK_RAW)
    log = InMemoryEpisodeLog()
    store = InMemoryMemoryStore()
    resolver = IdentityResolver("lab1", ROSTER)

    await ingest_source(
        hub, log, store, lab_id="lab1", source=SourcePlatform.SLACK, resolver=resolver
    )
    # The Slack handles @lucas / @philip resolve to canonical persons; a search finds
    # authored-by facts with resolved authors.
    facts = await store.search("lab1", "thermostability", group_ids=["lab1"])
    authors = {f.provenance.author for f in facts}
    assert "p_lucas" in authors
    assert UNKNOWN_AUTHOR not in authors


async def test_ingest_is_idempotent_on_rerun() -> None:
    hub = FakeConnectorHub(_SLACK_RAW)
    log = InMemoryEpisodeLog()
    store = InMemoryMemoryStore()

    first = await ingest_source(hub, log, store, lab_id="lab1", source=SourcePlatform.SLACK)
    second = await ingest_source(hub, log, store, lab_id="lab1", source=SourcePlatform.SLACK)
    assert first.stored == 2
    assert second.stored == 0  # nothing new on the second run (dedup, R6)
    assert await log.count("lab1") == 2


async def test_ingest_counts_unresolved_authors() -> None:
    # No resolver → authors stay unknown; the pipeline surfaces the count (never guesses).
    hub = FakeConnectorHub(_SLACK_RAW)
    log = InMemoryEpisodeLog()
    store = InMemoryMemoryStore()
    stats = await ingest_source(hub, log, store, lab_id="lab1", source=SourcePlatform.SLACK)
    assert stats.unresolved_authors == 2

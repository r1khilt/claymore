"""Unit tests for the durable append-only Episode log (R14).

Covers the log's contract: newly-stored vs duplicate append, edited-content versioning,
timestamp ordering + ``since`` filtering, injected-clock ``ingested_at`` stamping, and that
:func:`replay` reproduces the graph projection and stays idempotent when run twice.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from claymore.ingest.episodes import InMemoryEpisodeLog, SQLiteEpisodeLog, replay
from claymore.memory.graph import InMemoryMemoryStore
from tests.fixtures import LAB, make_episode

# A fixed clock so ingested_at is deterministic.
FIXED = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)


def fixed_clock() -> datetime:
    return FIXED


# --- append: new vs duplicate vs edited ---


async def test_append_new_returns_true_and_counts() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    assert await log.append(make_episode()) is True
    assert await log.count(LAB) == 1


async def test_duplicate_append_is_noop() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    ep = make_episode()
    assert await log.append(ep) is True
    assert await log.append(ep) is False  # same key → no-op
    assert await log.count(LAB) == 1


async def test_edited_content_stored_as_new_version() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    # Same source_id, different source_hash → a new version; both are retained (append-only).
    assert await log.append(make_episode(source_id="m1", source_hash="h1")) is True
    assert await log.append(make_episode(source_id="m1", source_hash="h2")) is True
    assert await log.count(LAB) == 2


async def test_exists_tracks_stored_keys() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    ep = make_episode()
    assert await log.exists(ep) is False
    await log.append(ep)
    assert await log.exists(ep) is True
    # A different version is a different key.
    assert await log.exists(make_episode(source_hash="other")) is False


# --- ingested_at stamping ---


async def test_ingested_at_stamped_from_injected_clock() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    original = make_episode()
    assert original.ingested_at is None  # unstamped before persistence
    await log.append(original)
    [stored] = [ep async for ep in log.iter_since(LAB)]
    assert stored.ingested_at == FIXED
    # The frozen input was not mutated.
    assert original.ingested_at is None


# --- iter_since: ordering + filtering ---


async def test_iter_since_orders_by_timestamp() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    t1 = datetime(2026, 1, 1, tzinfo=UTC)
    t2 = datetime(2026, 3, 1, tzinfo=UTC)
    t3 = datetime(2026, 6, 1, tzinfo=UTC)
    # Insert out of order; iteration must still be by source time.
    await log.append(make_episode(source_id="b", source_hash="hb", timestamp=t2))
    await log.append(make_episode(source_id="c", source_hash="hc", timestamp=t3))
    await log.append(make_episode(source_id="a", source_hash="ha", timestamp=t1))
    ids = [ep.source_id async for ep in log.iter_since(LAB)]
    assert ids == ["a", "b", "c"]


async def test_iter_since_filters_by_cutoff() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    early = datetime(2026, 1, 1, tzinfo=UTC)
    late = datetime(2026, 6, 1, tzinfo=UTC)
    await log.append(make_episode(source_id="early", source_hash="he", timestamp=early))
    await log.append(make_episode(source_id="late", source_hash="hl", timestamp=late))
    ids = [ep.source_id async for ep in log.iter_since(LAB, datetime(2026, 3, 1, tzinfo=UTC))]
    assert ids == ["late"]
    # Inclusive lower bound.
    ids_incl = [ep.source_id async for ep in log.iter_since(LAB, early)]
    assert ids_incl == ["early", "late"]


# --- replay reproduces the graph projection, idempotently ---


async def test_replay_reproduces_facts() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    await log.append(make_episode(refs=("Y-hypothesis", "X-protein")))
    store = InMemoryMemoryStore()
    n = await replay(log, store, LAB)
    assert n == 1
    facts = await store.search(LAB, "hypothesis", group_ids=[LAB])
    assert facts  # rebuilt from the durable log alone
    assert all(f.provenance.source_id == "m1" for f in facts)


async def test_replay_is_idempotent() -> None:
    log = InMemoryEpisodeLog(clock=fixed_clock)
    await log.append(make_episode())
    store = InMemoryMemoryStore()
    await replay(log, store, LAB)
    first = await store.search(LAB, "hypothesis", group_ids=[LAB])
    # Running replay again relies on the store's own dedup — no doubling.
    await replay(log, store, LAB)
    second = await store.search(LAB, "hypothesis", group_ids=[LAB])
    assert len(first) == len(second)


# --- SQLite adapter: the local product path survives process/object restarts ------------------


async def test_sqlite_log_is_durable_and_deduplicates_after_reopen(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    episode = make_episode(source_id="durable", source_hash="v1")
    first = SQLiteEpisodeLog(path, clock=fixed_clock)
    assert await first.append(episode) is True

    reopened = SQLiteEpisodeLog(path, clock=fixed_clock)
    assert await reopened.append(episode) is False
    assert await reopened.exists(episode) is True
    assert await reopened.count(LAB) == 1
    [stored] = [ep async for ep in reopened.iter_since(LAB)]
    assert stored.source_id == "durable"
    assert stored.ingested_at == FIXED


async def test_sqlite_log_keeps_labs_and_versions_separate(tmp_path: Path) -> None:
    log = SQLiteEpisodeLog(tmp_path / "state.sqlite3", clock=fixed_clock)
    await log.append(make_episode(lab_id="lab-a", source_id="m", source_hash="v1"))
    await log.append(make_episode(lab_id="lab-a", source_id="m", source_hash="v2"))
    await log.append(make_episode(lab_id="lab-b", source_id="m", source_hash="v1"))
    assert await log.count("lab-a") == 2
    assert await log.count("lab-b") == 1


async def test_sqlite_log_orders_mixed_offsets_by_absolute_time(tmp_path: Path) -> None:
    log = SQLiteEpisodeLog(tmp_path / "state.sqlite3", clock=fixed_clock)
    earlier = datetime(2026, 1, 1, 1, 0, tzinfo=timezone(timedelta(hours=2)))
    later = datetime(2025, 12, 31, 23, 30, tzinfo=UTC)
    await log.append(make_episode(source_id="earlier", timestamp=earlier))
    await log.append(make_episode(source_id="later", timestamp=later))
    ordered = [episode.source_id async for episode in log.iter_since(LAB)]
    assert ordered == ["earlier", "later"]

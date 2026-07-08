"""Live integration test — GraphitiMemoryStore against a real FalkorDB + real LLM/embedder.

This is the proof that the fake (`InMemoryMemoryStore`) and the real adapter are truly
interchangeable behind the `MemoryStore` port: the SAME contract assertions the unit tests make
against the fake are made here against Graphiti-on-FalkorDB.

It is GUARDED so the default test run (and CI) stays hermetic and free: it skips unless a live
FalkorDB is reachable AND real Anthropic + Voyage keys are configured (Graphiti calls the LLM to
extract facts and Voyage to embed them). To run it:

    docker run -d --name claymore-falkordb -p 6379:6379 falkordb/falkordb:latest
    export ANTHROPIC_API_KEY=sk-ant-...   VOYAGE_API_KEY=...
    .venv/bin/pytest tests/integration -v

Cost note (R6): each add_episode makes one cheap-model extraction call + embeddings. The test
adds a handful of episodes, so a run is a few cents at most.
"""

from __future__ import annotations

import os

import pytest

from claymore.config import get_settings
from claymore.domain import SourcePlatform
from tests.fixtures import LAB, make_episode

pytestmark = pytest.mark.integration


def _falkordb_reachable(uri: str) -> bool:
    from urllib.parse import urlparse

    try:
        import redis  # falkordb speaks the redis protocol
    except ImportError:  # pragma: no cover - redis ships with the memory extra
        return False
    parsed = urlparse(uri)
    try:
        client = redis.Redis(host=parsed.hostname or "localhost", port=parsed.port or 6379)
        return bool(client.ping())
    except Exception:
        return False


def _live_or_skip() -> object:
    settings = get_settings()
    if not settings.anthropic_api_key.get_secret_value():
        pytest.skip("ANTHROPIC_API_KEY not set — skipping live Graphiti integration test")
    if not settings.voyage_api_key.get_secret_value():
        pytest.skip("VOYAGE_API_KEY not set — skipping live Graphiti integration test")
    if not _falkordb_reachable(settings.falkordb_uri):
        pytest.skip(f"FalkorDB not reachable at {settings.falkordb_uri} — skipping")
    return settings


@pytest.mark.skipif(
    os.getenv("CLAYMORE_RUN_LIVE") != "1",
    reason="live test — set CLAYMORE_RUN_LIVE=1 (plus FalkorDB + keys) to run",
)
async def test_graphiti_roundtrip_is_attributed() -> None:
    """add_episode → search returns a fact whose provenance grounds the answer (hard rule 1)."""
    from claymore.memory.graph import GraphitiMemoryStore

    settings = _live_or_skip()
    assert not isinstance(settings, type(None))
    store = GraphitiMemoryStore(settings)  # type: ignore[arg-type]

    lab = f"{LAB}-itest"
    await store.build_indices(lab)
    episode = make_episode(
        lab_id=lab,
        author="p_lucas",
        text="Lucas suggested testing the thermostability of the X protein via a melt assay.",
        refs=("X-protein",),
    )
    await store.add_episode(episode)

    facts = await store.search(lab, "thermostability protein", group_ids=[lab], limit=10)
    assert facts, "expected at least one extracted fact from the live graph"
    # Every returned fact must carry recoverable provenance — the whole point of the adapter.
    for fact in facts:
        assert fact.provenance.source_id == episode.source_id
        assert fact.provenance.source_platform is SourcePlatform.SLACK


@pytest.mark.skipif(
    os.getenv("CLAYMORE_RUN_LIVE") != "1",
    reason="live test — set CLAYMORE_RUN_LIVE=1 (plus FalkorDB + keys) to run",
)
async def test_graphiti_cross_lab_isolation() -> None:
    """A search in one lab's database never sees another lab's episode (R10)."""
    from claymore.memory.graph import GraphitiMemoryStore

    settings = _live_or_skip()
    store = GraphitiMemoryStore(settings)  # type: ignore[arg-type]

    lab_a, lab_b = f"{LAB}-itest-a", f"{LAB}-itest-b"
    for lab in (lab_a, lab_b):
        await store.build_indices(lab)
    await store.add_episode(
        make_episode(lab_id=lab_a, source_id="a1", text="Assay buffer uses phosphate at pH 7.4.")
    )
    facts_b = await store.search(lab_b, "phosphate buffer", group_ids=[lab_b], limit=10)
    assert facts_b == [], "lab B must not see lab A's facts (tenant isolation)"

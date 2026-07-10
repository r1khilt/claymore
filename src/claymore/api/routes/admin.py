"""Admin routes — token-gated ingest triggers (the second Brain↔Pipes link).

``POST /admin/ingest`` starts a backfill of one Composio source into the shared runtime store;
because Graphiti extraction is an LLM call per episode (R6) the run happens in a background
asyncio task and the caller polls ``GET /admin/ingest/{job_id}``.

Security (SECURITY.md §8): the API may be exposed through a public tunnel, so every admin
request must carry ``X-Claymore-Admin-Token`` matching the configured secret — compared in
constant time, fail-closed when unconfigured. These routes only *read* sources and write to
the lab's own memory; they still count as spend (Composio executions + extraction tokens),
hence the gate.

State: one process-wide ``InMemoryEpisodeLog`` (dedup across runs, R6) and the ask loop's own
``MemoryStore`` via ``agent.get_runtime().store`` — ingest and ask must share the store
instance while the Graphiti provenance sidecar is in-process (see ``api/runtime.py``).
"""

from __future__ import annotations

import asyncio
import hmac
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from claymore.agent import get_runtime
from claymore.api.runtime import roster_from_json
from claymore.config import Settings, get_settings
from claymore.domain import SourcePlatform
from claymore.ingest.episodes import InMemoryEpisodeLog
from claymore.ingest.pipeline import IngestStats, ingest_source
from claymore.logging import get_logger
from claymore.memory.identity import IdentityResolver
from claymore.ports import ConnectorHub

_log = get_logger("api.admin")

router = APIRouter()

_TOKEN_HEADER = "X-Claymore-Admin-Token"  # noqa: S105 (header name, not a secret)

# Process-wide episode log: dedup across ingest runs so a re-trigger never re-pays extraction.
_episode_log = InMemoryEpisodeLog()


class IngestRequest(BaseModel):
    source: SourcePlatform
    lab_id: str = "lab1"
    days: int = Field(default=7, ge=1, le=365)
    """Backfill window. Small by default — extraction is an LLM call per episode (R6)."""
    limit: int | None = Field(default=None, ge=1, le=1000)
    """Optional hard cap on newly-stored episodes (each = one extraction call). Bounds spend."""


class IngestJob(BaseModel):
    job_id: str
    source: SourcePlatform
    lab_id: str
    status: Literal["running", "done", "failed"]
    stats: IngestStats | None = None
    error: str | None = None


_jobs: dict[str, IngestJob] = {}
_tasks: dict[str, asyncio.Task[None]] = {}  # strong refs: an un-referenced task can be GC'd


def _authorized(request: Request, settings: Settings) -> bool:
    configured = settings.admin_api_token.get_secret_value()
    received = request.headers.get(_TOKEN_HEADER, "")
    if not configured or not received:
        return False  # fail-closed: unconfigured deployments accept nothing
    return hmac.compare_digest(configured, received)


def _build_hub(settings: Settings, resolver: IdentityResolver | None) -> ConnectorHub:
    """Live Composio hub. Module-level seam so tests swap in a ``FakeConnectorHub``."""
    from claymore.ingest.composio.hub import ComposioConnectorHub

    return ComposioConnectorHub(
        settings, resolver=resolver, user_id=settings.composio_user_id or None
    )


async def _run_ingest(job_id: str, req: IngestRequest, settings: Settings) -> None:
    job = _jobs[job_id]
    try:
        roster = roster_from_json(settings.lab_roster_json)
        resolver = IdentityResolver(req.lab_id, roster) if roster else None
        hub = _build_hub(settings, resolver)
        stats = await ingest_source(
            hub,
            _episode_log,
            get_runtime().store,
            lab_id=req.lab_id,
            source=req.source,
            resolver=resolver,
            since=datetime.now(UTC) - timedelta(days=req.days),
            limit=req.limit,
        )
        _jobs[job_id] = job.model_copy(update={"status": "done", "stats": stats})
        _log.info("admin.ingest.done", job_id=job_id, source=req.source, stored=stats.stored)
    except Exception as exc:  # surfaced via the job record; never a hung "running" forever
        _jobs[job_id] = job.model_copy(update={"status": "failed", "error": str(exc)[:500]})
        _log.error("admin.ingest.failed", job_id=job_id, source=req.source, error=str(exc)[:500])
    finally:
        _tasks.pop(job_id, None)


@router.post("/admin/ingest", response_model=None)
async def start_ingest(request: Request, body: IngestRequest) -> Response | IngestJob:
    settings = get_settings()
    if not _authorized(request, settings):
        _log.warning("admin.rejected", path="/admin/ingest")
        return Response(status_code=403)
    job_id = uuid.uuid4().hex[:12]
    job = IngestJob(job_id=job_id, source=body.source, lab_id=body.lab_id, status="running")
    _jobs[job_id] = job
    _tasks[job_id] = asyncio.create_task(_run_ingest(job_id, body, settings))
    _log.info("admin.ingest.started", job_id=job_id, source=body.source, days=body.days)
    return job


@router.get("/admin/ingest/{job_id}", response_model=None)
async def get_ingest_job(request: Request, job_id: str) -> Response | IngestJob:
    if not _authorized(request, get_settings()):
        return Response(status_code=403)
    job = _jobs.get(job_id)
    if job is None:
        return Response(status_code=404)
    return job


@router.get("/admin/ingest", response_model=None)
async def list_ingest_jobs(request: Request) -> Response | list[IngestJob]:
    if not _authorized(request, get_settings()):
        return Response(status_code=403)
    return list(_jobs.values())

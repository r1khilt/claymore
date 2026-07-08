"""FastAPI application — webhook receivers, SMS inbound, health (CLAUDE.md §4).

Phase-0 skeleton: the app boots, configures structured logging, and exposes liveness/readiness
so a deploy has something to gate on (ENGINEERING_GUIDELINES.md §3). Inbound webhook + SMS
routes (with signature verification, SECURITY.md §8) land as they're built, behind flags.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from claymore import __version__
from claymore.config import get_settings
from claymore.logging import configure_logging, get_logger

_log = get_logger("api")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    _log.info("startup", env=settings.env, version=__version__)
    yield
    _log.info("shutdown")


app = FastAPI(title="Claymore", version=__version__, lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness: the process is up."""
    return {"status": "ok", "version": __version__}


@app.get("/readyz")
async def readyz() -> dict[str, str]:
    """Readiness. Phase 0: always ready. Later: check FalkorDB/Postgres/Redis connectivity."""
    return {"status": "ready"}

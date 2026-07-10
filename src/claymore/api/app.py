"""FastAPI application — webhook receivers, SMS inbound, health (CLAUDE.md §4).

Phase-0 skeleton: the app boots, configures structured logging, and exposes liveness/readiness
so a deploy has something to gate on (ENGINEERING_GUIDELINES.md §3). Inbound webhook + SMS
routes (with signature verification, SECURITY.md §8) land as they're built, behind flags.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from claymore import __version__, agent
from claymore.api.routes.admin import router as admin_router
from claymore.api.routes.agent import router as agent_router
from claymore.api.routes.ask import router as ask_router
from claymore.api.routes.connectors import router as connectors_router
from claymore.api.routes.local import router as local_router
from claymore.api.routes.telegram import router as telegram_router
from claymore.api.routes.whatsapp import router as whatsapp_router
from claymore.api.runtime import build_runtime
from claymore.config import get_settings
from claymore.logging import configure_logging, get_logger

_log = get_logger("api")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    runtime = build_runtime(settings)
    if runtime is not None:
        agent.set_runtime(runtime)  # real graph + real LLM behind the Ask loop
    if settings.whatsapp_enrollments:
        from claymore.api.routes.whatsapp import directory_from_enrollments, set_directory

        set_directory(directory_from_enrollments(settings.whatsapp_enrollments))
        _log.info("whatsapp.directory_installed")
    if settings.telegram_enrollments:
        from claymore.api.routes.telegram import set_directory as set_telegram_directory
        from claymore.messaging import directory_from_roster

        set_telegram_directory(directory_from_roster(settings.telegram_enrollments))
        _log.info("telegram.directory_installed")
    _log.info("startup", env=settings.env, version=__version__)
    yield
    _log.info("shutdown")


app = FastAPI(title="Claymore", version=__version__, lifespan=lifespan)
app.include_router(whatsapp_router)
app.include_router(telegram_router)
app.include_router(admin_router)
app.include_router(ask_router)  # POST /api/ask (web dashboard; gated by WEB_API_ENABLED)
app.include_router(agent_router)  # POST /api/agent (Composer SSE; gated by WEB_API_ENABLED + key)
app.include_router(connectors_router)  # /api/connectors/* (Composio OAuth + durable sync)
app.include_router(local_router)  # /api/local/* (chats/settings/metrics; local file, ungated)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness: the process is up."""
    return {"status": "ok", "version": __version__}


@app.get("/readyz")
async def readyz() -> dict[str, str]:
    """Readiness. Phase 0: always ready. Later: check FalkorDB/Postgres/Redis connectivity."""
    return {"status": "ready"}

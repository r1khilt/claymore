"""Local-store endpoints — the web dashboard's ``keep-it-local`` persistence surface.

``/api/local/*`` reads and writes the single-user on-disk document in ``local_store`` (chats,
settings, profile, metrics, error log). Unlike ``/api/ask`` and ``/api/agent`` these are **not**
gated on ``WEB_API_ENABLED`` or a model key — they touch only the user's own folder, hold no lab
IP, and run no model. They exist so the sidebar's Recent chats, the Settings panel (profile,
API keys, reasoning level, debug), the usage/metrics view and the error log all persist across
refreshes without a database. If the backend isn't running the web client falls back to
``localStorage`` (see ``web/src/lib/local.ts``), so these are a convenience, never a hard dep.

Security note: these routes can read/write the Anthropic key the user pastes into Settings. That
key lives only in ``~/.claymore/local.json`` (git-ignored) and is used solely to build the live
Composer's Anthropic client server-side — it is never logged and never sent to any other host.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from claymore import local_store
from claymore.logging import get_logger

_log = get_logger("api.local")

router = APIRouter(prefix="/api/local")

# The JSON body for the "raw dict" endpoints (chat upsert, settings/profile patch). Using an
# Annotated alias keeps the ``Body()`` marker out of the parameter default (ruff B008).
JsonBody = Annotated[dict[str, Any], Body(...)]


class ErrorIn(BaseModel):
    message: str
    level: str = "error"
    context: str = ""


@router.get("/state")
async def get_state() -> dict[str, Any]:
    """Full local state — profile, settings, metrics, error log, and chat summaries."""
    state = local_store.get_state()
    state["meta"] = {"path": str(local_store.local_path())}
    return state


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str) -> dict[str, Any]:
    chat = local_store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(status_code=404, detail="chat not found")
    return chat


@router.put("/chats/{chat_id}")
async def put_chat(chat_id: str, chat: JsonBody) -> dict[str, Any]:
    """Insert or replace a chat (the Composer saves each conversation here)."""
    chat = {**chat, "id": chat_id}
    try:
        return local_store.upsert_chat(chat)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str) -> dict[str, str]:
    local_store.delete_chat(chat_id)
    return {"status": "ok"}


@router.delete("/chats")
async def clear_chats() -> dict[str, str]:
    local_store.clear_chats()
    return {"status": "ok"}


@router.patch("/settings")
async def patch_settings(patch: JsonBody) -> dict[str, Any]:
    return local_store.update_settings(patch)


@router.patch("/profile")
async def patch_profile(patch: JsonBody) -> dict[str, Any]:
    return local_store.update_profile(patch)


@router.post("/errors")
async def post_error(body: ErrorIn) -> dict[str, str]:
    """Let the web client record its own errors (failed fetch, SSE drop) into the debug log."""
    local_store.record_error(body.message, level=body.level, context=body.context)
    return {"status": "ok"}


@router.delete("/errors")
async def clear_errors() -> dict[str, str]:
    local_store.clear_errors()
    return {"status": "ok"}


@router.delete("/metrics")
async def reset_metrics() -> dict[str, str]:
    local_store.reset_metrics()
    return {"status": "ok"}

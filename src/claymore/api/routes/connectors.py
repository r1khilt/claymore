"""Local dashboard API for Composio connection lifecycle and source syncing."""

from __future__ import annotations

import html
import json
import secrets
from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from claymore.config import get_settings
from claymore.domain import SourcePlatform
from claymore.ingest.composio.manager import (
    AuthorizationLink,
    ConnectorManager,
    ConnectorServiceError,
    ConnectorView,
    SyncStarted,
)

router = APIRouter(prefix="/api/connectors", tags=["connectors"])

_manager: ConnectorManager | None = None


class ConnectRequest(BaseModel):
    reconnect: bool = False


class ConnectorList(BaseModel):
    connectors: list[ConnectorView]


def set_connector_manager(manager: ConnectorManager | None) -> None:
    """Install a manager double in tests, or clear the lazy singleton."""
    global _manager
    _manager = manager


def get_connector_manager() -> ConnectorManager:
    global _manager
    if _manager is None:
        _manager = ConnectorManager(get_settings())
    return _manager


def _require_dashboard() -> None:
    if not get_settings().web_api_enabled:
        raise HTTPException(status_code=404)


def _raise_safe(exc: ConnectorServiceError) -> NoReturn:
    raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _callback_url(request: Request) -> str:
    configured = get_settings().public_base_url.strip()
    path = request.app.url_path_for("connector_callback")
    if configured:
        return f"{configured.rstrip('/')}{path}"
    return str(request.url_for("connector_callback"))


@router.get("", response_model=ConnectorList)
async def list_connectors() -> ConnectorList:
    _require_dashboard()
    connectors = await get_connector_manager().list_connectors()
    return ConnectorList(connectors=connectors)


@router.post("/{source}/connect", response_model=AuthorizationLink)
async def connect_connector(
    request: Request, source: SourcePlatform, _body: ConnectRequest
) -> AuthorizationLink:
    _require_dashboard()
    try:
        return await get_connector_manager().start_authorization(source, _callback_url(request))
    except ConnectorServiceError as exc:
        _raise_safe(exc)


@router.post("/{source}/sync", response_model=SyncStarted, status_code=status.HTTP_202_ACCEPTED)
async def sync_connector(source: SourcePlatform) -> SyncStarted:
    _require_dashboard()
    try:
        return await get_connector_manager().start_sync(source)
    except ConnectorServiceError as exc:
        _raise_safe(exc)


@router.delete("/{source}", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_connector(source: SourcePlatform) -> Response:
    _require_dashboard()
    try:
        await get_connector_manager().disconnect(source)
    except ConnectorServiceError as exc:
        _raise_safe(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _callback_page(
    *, source: str, callback_status: str, message: str, status_code: int = 200
) -> HTMLResponse:
    nonce = secrets.token_urlsafe(18)
    payload: dict[str, Any] = {
        "type": "claymore:connector-oauth",
        "platform": source,
        "status": callback_status,
    }
    payload_json = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c")
    title = "Connected" if callback_status == "connected" else "Connection not completed"
    body = f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{html.escape(title)}</title></head>
<body style="font:16px system-ui;padding:2rem;color:#24332a;background:#f7f5ef">
<h1>{html.escape(title)}</h1><p>{html.escape(message)}</p>
<script nonce="{nonce}">
if (window.opener) window.opener.postMessage({payload_json}, "*");
window.setTimeout(() => window.close(), 150);
</script></body></html>"""
    return HTMLResponse(
        body,
        status_code=status_code,
        headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'unsafe-inline'; "
                f"script-src 'nonce-{nonce}'; base-uri 'none'; frame-ancestors 'none'"
            ),
        },
    )


@router.get("/callback", name="connector_callback", response_model=None)
async def connector_callback(request: Request) -> HTMLResponse:
    _require_dashboard()
    query = request.query_params
    state_token = query.get("state", "")
    callback_status = query.get("status")
    account_id = query.get("connectedAccountId") or query.get("connected_account_id")
    if not 16 <= len(state_token) <= 256:
        return _callback_page(
            source="unknown",
            callback_status="error",
            message="The authorization callback did not include a state token.",
            status_code=400,
        )
    try:
        result = await get_connector_manager().finish_authorization(
            state_token,
            callback_status=callback_status,
            callback_account_id=account_id,
        )
    except ConnectorServiceError as exc:
        return _callback_page(
            source="unknown",
            callback_status="error",
            message=str(exc),
            status_code=exc.status_code,
        )
    return _callback_page(
        source=result.source.value,
        callback_status=result.status,
        message=result.message,
    )

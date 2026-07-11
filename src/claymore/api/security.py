"""Shared web-API auth dependency — a loopback-or-token gate (SECURITY.md §8).

The browser-dashboard routes (``/api/agent``, ``/api/ask``, ``/api/local/*``) are a single-user
local surface: they answer as one configured demo identity and (unlike Telegram/WhatsApp/admin)
carry no per-message channel auth. Left open they let anyone who can reach the port drive the agent
(spend), read lab-scoped memory, or read/overwrite the pasted API keys. This dependency closes that
without adding friction to local dev:

* ``WEB_API_TOKEN`` **set**  → every request must present ``Authorization: Bearer <token>``
  (compared in constant time). Lockdown mode for any networked / tunnelled deployment.
* ``WEB_API_TOKEN`` **empty** → only loopback clients are served; a non-loopback caller gets 403.
  Local dev is friction-free, but a bind to ``0.0.0.0`` / a shared host is not exposed.

``request.client.host`` is the real transport peer set by the ASGI server (uvicorn) — it is NOT a
spoofable header, so the loopback check is sound for a *direct* connection. A same-host reverse
proxy or tunnel (ngrok/cloudflared) terminates locally and therefore presents as loopback; in that
case a token is the only protection, so ``WEB_API_TOKEN`` MUST be set before exposing the app that
way. WhatsApp/Telegram/admin routes keep their own stronger auth and are unaffected.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

from claymore.config import get_settings
from claymore.logging import get_logger

_log = get_logger("api.security")

_BEARER = "bearer "
# Transport peers that count as "local". "testclient" is Starlette's in-process test client (never a
# real network peer); the rest are the loopback forms uvicorn reports for a real localhost socket.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "testclient"})


def _is_loopback_client(request: Request) -> bool:
    client = request.client
    if client is None:
        return False
    host = (client.host or "").strip("[]").lower()
    return host in _LOOPBACK_HOSTS or host.startswith("127.")


def _bearer_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    return header[len(_BEARER) :].strip() if header.lower().startswith(_BEARER) else ""


def require_web_auth(request: Request) -> None:
    """FastAPI dependency guarding the web surface. Raises 403 unless the caller is authorized
    (valid bearer token when one is configured, else a loopback client)."""
    settings = get_settings()
    token = settings.web_api_token.get_secret_value().strip()
    if token:
        received = _bearer_token(request)
        if hmac.compare_digest(token, received):
            return
        _log.warning("web.auth.rejected", reason="bad_token", path=request.url.path)
        raise HTTPException(status_code=403, detail="missing or invalid API token")
    if _is_loopback_client(request):
        return
    _log.warning("web.auth.rejected", reason="remote_no_token", path=request.url.path)
    raise HTTPException(status_code=403, detail="remote access requires WEB_API_TOKEN")

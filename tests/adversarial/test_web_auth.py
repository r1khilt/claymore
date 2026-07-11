"""Adversarial suite for the web-API auth gate (``api/security.py``, CLAUDE.md §8).

The browser-dashboard routes answer as one demo identity with no per-message auth, so
``require_web_auth`` is the guard: loopback-only when ``WEB_API_TOKEN`` is unset, bearer-token
required (from anywhere) when it is set. This suite proves a remote caller can't reach the surface
unauthenticated, that a set token is enforced even from loopback, and that bearer parsing rejects
malformed/near-miss headers. ``request.client.host`` is the real transport peer (not a spoofable
header), so these cover the actual trust boundary. A red test here is a real hole — fix the code.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from claymore.api import security
from tests.fixtures import make_settings


def _req(host: str, headers: dict[str, str] | None = None, path: str = "/api/agent") -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": raw,
        "client": (host, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
        "query_string": b"",
    }
    return Request(scope)


def _use_token(monkeypatch: pytest.MonkeyPatch, token: str) -> None:
    monkeypatch.setattr(security, "get_settings", lambda: make_settings(web_api_token=token))


def test_loopback_allowed_when_no_token(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_token(monkeypatch, "")
    for host in ("127.0.0.1", "::1", "localhost", "testclient", "127.0.0.5", "::ffff:127.0.0.1"):
        security.require_web_auth(_req(host))  # must not raise


def test_remote_blocked_when_no_token(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_token(monkeypatch, "")
    for host in ("203.0.113.7", "10.0.0.4", "192.168.1.9", "8.8.8.8"):
        with pytest.raises(HTTPException) as exc:
            security.require_web_auth(_req(host))
        assert exc.value.status_code == 403


def test_token_required_even_from_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_token(monkeypatch, "s3cret-token")
    # Loopback no longer bypasses once a token is configured (closes the tunnel-presents-as-loopback
    # gap): a loopback caller with no/incorrect token is refused.
    with pytest.raises(HTTPException):
        security.require_web_auth(_req("127.0.0.1"))
    with pytest.raises(HTTPException):
        security.require_web_auth(_req("127.0.0.1", {"authorization": "Bearer wrong"}))
    # The correct token is accepted from anywhere, including a remote host.
    security.require_web_auth(_req("203.0.113.7", {"authorization": "Bearer s3cret-token"}))


def test_bearer_parsing_rejects_near_misses(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_token(monkeypatch, "tok")
    # Case-insensitive scheme, trailing space tolerated.
    security.require_web_auth(_req("1.2.3.4", {"authorization": "bearer tok"}))
    security.require_web_auth(_req("1.2.3.4", {"authorization": "Bearer  tok  "}))
    for bad in ("Basic tok", "tok", "Bearer ", "Bearertok", "Bearer to", "Bearer tokk", ""):
        with pytest.raises(HTTPException):
            security.require_web_auth(_req("1.2.3.4", {"authorization": bad}))

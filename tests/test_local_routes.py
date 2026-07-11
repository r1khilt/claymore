"""Route smoke tests for the local-store endpoints (``/api/local/*``).

They need no ``WEB_API_ENABLED`` or model key (they touch only the user's own file), but they sit
behind the loopback-or-token web-auth gate (``api/security.py``); the in-process TestClient counts
as a loopback peer, so no token is needed here. The suite drives the full round-trip through
FastAPI: read state, save + restore + delete a chat, patch settings/profile, log + clear an error
— pointing the store at a throwaway dir.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from claymore.api.app import app


@pytest.fixture(autouse=True)
def _isolated_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CLAYMORE_LOCAL_DIR", str(tmp_path))
    yield


def test_state_defaults_and_path() -> None:
    client = TestClient(app)
    resp = client.get("/api/local/state")
    assert resp.status_code == 200
    body = resp.json()
    assert body["profile"]["name"] == "Rikhil T"
    assert body["chats"] == []
    assert body["metrics"]["totalRuns"] == 0
    assert "local.json" in body["meta"]["path"]


def test_chat_round_trip() -> None:
    client = TestClient(app)
    chat = {"id": "c1", "title": "", "turns": [{"q": "what did Lucas suggest?", "events": []}]}
    put = client.put("/api/local/chats/c1", json=chat)
    assert put.status_code == 200
    assert put.json()["title"] == "what did Lucas suggest?"  # derived from first turn

    # Appears as a summary in state, restorable in full by id.
    assert client.get("/api/local/state").json()["chats"][0]["id"] == "c1"
    full = client.get("/api/local/chats/c1").json()
    assert full["turns"][0]["q"] == "what did Lucas suggest?"

    assert client.delete("/api/local/chats/c1").status_code == 200
    assert client.get("/api/local/chats/c1").status_code == 404


def test_patch_settings_and_profile() -> None:
    client = TestClient(app)
    s = client.patch(
        "/api/local/settings", json={"reasoningLevel": "high", "liveMode": True, "junk": 9}
    )
    assert s.status_code == 200
    body = s.json()
    assert body["reasoningLevel"] == "high"
    assert body["liveMode"] is True
    assert "junk" not in body

    p = client.patch("/api/local/profile", json={"name": "Ada Lovelace"})
    assert p.json()["name"] == "Ada Lovelace"


def test_error_log_post_and_clear() -> None:
    client = TestClient(app)
    posted = client.post("/api/local/errors", json={"message": "boom", "context": "web"})
    assert posted.status_code == 200
    assert len(client.get("/api/local/state").json()["errorLog"]) == 1
    assert client.delete("/api/local/errors").status_code == 200
    assert client.get("/api/local/state").json()["errorLog"] == []


def test_api_keys_masked_over_the_wire() -> None:
    """The stored Anthropic/Voyage keys are never sent to the client raw — masked on read, and a
    masked echo back from the Settings panel never wipes the real key."""
    from claymore import local_store
    from claymore.local_store import MASKED_SECRET

    client = TestClient(app)
    client.patch("/api/local/settings", json={"anthropicApiKey": "sk-ant-xyz"})
    # GET /state masks the stored key.
    assert client.get("/api/local/state").json()["settings"]["anthropicApiKey"] == MASKED_SECRET
    # The PATCH response is masked too, and echoing the mask keeps the real key server-side.
    echoed = client.patch("/api/local/settings", json={"anthropicApiKey": MASKED_SECRET}).json()
    assert echoed["anthropicApiKey"] == MASKED_SECRET
    assert local_store.stored_anthropic_key() == "sk-ant-xyz"

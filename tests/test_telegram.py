"""Telegram adapter + inbound webhook — happy paths and contract behavior."""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

import claymore.agent as agent_module
import claymore.api.routes.telegram as telegram_route
from claymore.agent import Reply, RequestContext
from claymore.api.app import app
from claymore.messaging import directory_from_roster
from claymore.messaging.telegram import (
    TelegramChannel,
    parse_update,
    verify_webhook_secret,
)
from tests.fixtures import make_settings, make_user

WEBHOOK_PATH = "/webhooks/telegram"
SECRET = "wh-secret-42"
ENROLLED_TG_ID = "777000111"


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    settings = make_settings(telegram_webhook_secret=SECRET)
    monkeypatch.setattr(telegram_route, "get_settings", lambda: settings)
    user = make_user("u_rikhin")
    telegram_route.set_directory(lambda tg_id: user if tg_id == ENROLLED_TG_ID else None)
    yield
    telegram_route.set_directory(lambda tg_id: None)


def update(text: str = "what did lucas suggest?", sender: int = 777000111) -> dict[str, object]:
    return {
        "update_id": 1,
        "message": {
            "message_id": 5,
            "from": {"id": sender, "is_bot": False, "first_name": "R"},
            "chat": {"id": sender, "type": "private"},
            "text": text,
        },
    }


def post(client: TestClient, payload: object, *, secret: str = SECRET):
    return client.post(
        WEBHOOK_PATH, json=payload, headers={"X-Telegram-Bot-Api-Secret-Token": secret}
    )


# --- secret verification / parsing ---


def test_verify_webhook_secret() -> None:
    assert verify_webhook_secret(SECRET, SECRET)
    assert not verify_webhook_secret(SECRET, "wrong")
    assert not verify_webhook_secret(SECRET, "")
    assert not verify_webhook_secret("", "")  # fail-closed when unconfigured


def test_parse_update_extracts_text_message() -> None:
    msg = parse_update(update("hello"))
    assert msg is not None
    assert (msg.telegram_user_id, msg.chat_id, msg.body) == ("777000111", "777000111", "hello")


def test_parse_update_ignores_non_text() -> None:
    assert parse_update({"update_id": 1}) is None
    assert parse_update({"message": {"from": {"id": 1}, "chat": {"id": 1}}}) is None  # no text
    assert parse_update({"message": {"chat": {"id": 1}, "text": "hi"}}) is None  # no sender
    assert parse_update({"edited_message": {"text": "hi"}}) is None


# --- roster ---


def test_directory_from_roster_telegram_ids() -> None:
    directory = directory_from_roster("777000111:lab1:u_rikhin")
    user = directory("777000111")
    assert user is not None
    assert (user.id, user.lab_id, user.phone) == ("u_rikhin", "lab1", None)
    assert directory("123") is None


# --- outbound channel ---


async def test_send_posts_to_telegram() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    channel = TelegramChannel(
        bot_token="123:ABC",
        chat_for_user=lambda uid: ENROLLED_TG_ID if uid == "u_rikhin" else None,
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await channel.send("u_rikhin", "hello lab")
    assert len(seen) == 1
    assert seen[0].url.path == "/bot123:ABC/sendMessage"
    import json

    assert json.loads(seen[0].content)["chat_id"] == "777000111"


async def test_send_chunks_long_messages() -> None:
    count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        return httpx.Response(200, json={"ok": True})

    channel = TelegramChannel(
        bot_token="123:ABC",
        chat_for_user=lambda uid: ENROLLED_TG_ID,
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await channel.send("u_rikhin", "x" * 8193)  # 4096 + 4096 + 1
    assert count == 3


async def test_send_unenrolled_user_raises() -> None:
    channel = TelegramChannel(
        bot_token="123:ABC",
        chat_for_user=lambda uid: None,
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))),
    )
    with pytest.raises(ValueError, match="no enrolled"):
        await channel.send("u_ghost", "hi")


# --- inbound webhook, happy path ---


def test_inbound_routes_to_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_handle(ctx: RequestContext, text: str) -> Reply:
        captured["ctx"] = ctx
        captured["text"] = text
        return Reply(text="grounded answer")

    monkeypatch.setattr(agent_module, "handle", fake_handle)
    client = TestClient(app)
    resp = post(client, update())
    assert resp.status_code == 200
    body = resp.json()
    assert body["method"] == "sendMessage"
    assert body["chat_id"] == ENROLLED_TG_ID
    assert "grounded answer" in body["text"]
    ctx = captured["ctx"]
    assert isinstance(ctx, RequestContext)
    assert ctx.user_id == "u_rikhin"
    assert ctx.group_ids == ("lab1:u_rikhin",)
    assert captured["text"] == "what did lucas suggest?"


def test_non_text_update_acknowledged(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_handle(ctx: RequestContext, text: str) -> Reply:
        captured["text"] = text
        return Reply(text="x")

    monkeypatch.setattr(agent_module, "handle", fake_handle)
    client = TestClient(app)
    resp = post(client, {"update_id": 2, "message": {"chat": {"id": 1}, "sticker": {}}})
    assert resp.status_code == 200
    assert "text" not in captured

"""WhatsApp adapter + inbound webhook — happy paths and contract behavior."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

import claymore.agent as agent_module
import claymore.api.routes.whatsapp as whatsapp_route
from claymore.actions.approvals import ActionKind, PendingAction
from claymore.agent import Citation, Reply, RequestContext
from claymore.api.app import app
from claymore.domain import SourcePlatform
from claymore.messaging.whatsapp import (
    TwilioWhatsAppChannel,
    compute_twilio_signature,
    parse_inbound,
    render_reply,
    twiml_message,
    verify_twilio_signature,
)
from tests.fixtures import make_settings, make_user

WEBHOOK_PATH = "/webhooks/twilio/whatsapp"
WEBHOOK_URL = f"http://testserver{WEBHOOK_PATH}"
AUTH_TOKEN = "tok-123"
ENROLLED_PHONE = "+15550001111"


@pytest.fixture()
def enrolled_user():
    user = make_user("u_lucas")
    return user.model_copy(update={"phone": ENROLLED_PHONE})


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch, enrolled_user) -> Iterator[None]:
    settings = make_settings(
        twilio_auth_token=AUTH_TOKEN,
        twilio_whatsapp_from="+14155238886",
    )
    monkeypatch.setattr(whatsapp_route, "get_settings", lambda: settings)
    whatsapp_route.set_directory(lambda phone: enrolled_user if phone == ENROLLED_PHONE else None)
    yield
    whatsapp_route.set_directory(lambda phone: None)


def signed_post(client: TestClient, form: dict[str, str], *, token: str = AUTH_TOKEN):
    sig = compute_twilio_signature(token, WEBHOOK_URL, form)
    return client.post(WEBHOOK_PATH, data=form, headers={"X-Twilio-Signature": sig})


def whatsapp_form(
    body: str = "what did lucas suggest?", phone: str = ENROLLED_PHONE
) -> dict[str, str]:
    return {"From": f"whatsapp:{phone}", "Body": body, "MessageSid": "SM123"}


# --- signature ---


def test_signature_roundtrip() -> None:
    params = {"Body": "hi", "From": "whatsapp:+15550001111"}
    sig = compute_twilio_signature(AUTH_TOKEN, WEBHOOK_URL, params)
    assert verify_twilio_signature(AUTH_TOKEN, WEBHOOK_URL, params, sig)


def test_signature_rejects_param_tamper() -> None:
    params = {"Body": "hi"}
    sig = compute_twilio_signature(AUTH_TOKEN, WEBHOOK_URL, params)
    assert not verify_twilio_signature(AUTH_TOKEN, WEBHOOK_URL, {"Body": "bye"}, sig)


def test_signature_rejects_url_tamper() -> None:
    params = {"Body": "hi"}
    sig = compute_twilio_signature(AUTH_TOKEN, WEBHOOK_URL, params)
    assert not verify_twilio_signature(AUTH_TOKEN, "http://evil/webhook", params, sig)


def test_signature_rejects_wrong_token() -> None:
    params = {"Body": "hi"}
    sig = compute_twilio_signature("other-token", WEBHOOK_URL, params)
    assert not verify_twilio_signature(AUTH_TOKEN, WEBHOOK_URL, params, sig)


# --- parsing / rendering ---


def test_parse_inbound_strips_prefix() -> None:
    msg = parse_inbound(whatsapp_form())
    assert msg is not None
    assert msg.phone == ENROLLED_PHONE
    assert msg.body == "what did lucas suggest?"
    assert msg.message_sid == "SM123"


def test_parse_inbound_rejects_non_whatsapp() -> None:
    assert parse_inbound({"From": "+15550001111", "Body": "hi"}) is None
    assert parse_inbound({"Body": "hi"}) is None
    assert parse_inbound({"From": "whatsapp:", "Body": "hi"}) is None


def test_render_reply_with_citations_and_action() -> None:
    reply = Reply(
        text="Lucas suggested testing Y.",
        citations=(
            Citation(
                source_platform=SourcePlatform.SLACK,
                source_id="m1",
                author="p_lucas",
                timestamp=datetime(2026, 3, 3, tzinfo=UTC),
            ),
        ),
        pending_action=PendingAction(
            token="A3",
            lab_id="lab1",
            requested_by="u_lucas",
            kind=ActionKind.FILE_ISSUE,
            description="File a GitHub issue to test Y",
            payload={},
            idempotency_key="k1",
        ),
    )
    text = render_reply(reply)
    assert "Lucas suggested testing Y." in text
    assert "[1] slack m1 — p_lucas, 2026-03-03" in text
    assert 'Reply "approve A3"' in text
    assert "File a GitHub issue to test Y" in text


def test_twiml_escapes_xml() -> None:
    out = twiml_message("a <b> & 'c'")
    assert (
        "<b>" not in out.replace("<Response><Message>", "").replace("</Message></Response>", "")
        or "&lt;b&gt;" in out
    )
    assert "&lt;b&gt;" in out
    assert "&amp;" in out


# --- outbound channel ---


async def test_send_posts_to_twilio() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={"sid": "SM1"})

    channel = TwilioWhatsAppChannel(
        account_sid="AC1",
        auth_token=AUTH_TOKEN,
        from_number="+14155238886",
        phone_for_user=lambda uid: ENROLLED_PHONE if uid == "u_lucas" else None,
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await channel.send("u_lucas", "hello lab")
    assert len(seen) == 1
    req = seen[0]
    assert req.url.path == "/2010-04-01/Accounts/AC1/Messages.json"
    body = req.content.decode()
    assert "From=whatsapp%3A%2B14155238886" in body
    assert "To=whatsapp%3A%2B15550001111" in body
    assert "Body=hello+lab" in body
    assert req.headers["Authorization"].startswith("Basic ")


async def test_send_chunks_long_messages() -> None:
    count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        return httpx.Response(201, json={"sid": f"SM{count}"})

    channel = TwilioWhatsAppChannel(
        account_sid="AC1",
        auth_token=AUTH_TOKEN,
        from_number="+14155238886",
        phone_for_user=lambda uid: ENROLLED_PHONE,
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await channel.send("u_lucas", "x" * 3201)  # 1600 + 1600 + 1
    assert count == 3


async def test_send_unenrolled_user_raises() -> None:
    channel = TwilioWhatsAppChannel(
        account_sid="AC1",
        auth_token=AUTH_TOKEN,
        from_number="+14155238886",
        phone_for_user=lambda uid: None,
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(201))),
    )
    with pytest.raises(ValueError, match="no enrolled"):
        await channel.send("u_ghost", "hi")


# --- enrollment roster parsing ---


def test_directory_from_enrollments() -> None:
    directory = whatsapp_route.directory_from_enrollments(
        "+12602099455:lab1:u_rikhin, +15550001111:lab1:u_lucas ,"
    )
    user = directory("+12602099455")
    assert user is not None
    assert (user.id, user.lab_id, user.phone) == ("u_rikhin", "lab1", "+12602099455")
    assert directory("+15550001111") is not None
    assert directory("+19999999999") is None


def test_directory_from_enrollments_malformed_raises() -> None:
    with pytest.raises(ValueError, match="malformed"):
        whatsapp_route.directory_from_enrollments("+1555:lab1")
    with pytest.raises(ValueError, match="malformed"):
        whatsapp_route.directory_from_enrollments("+1555::u_x")


# --- inbound webhook, happy path ---


def test_inbound_routes_to_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_handle(ctx: RequestContext, text: str) -> Reply:
        captured["ctx"] = ctx
        captured["text"] = text
        return Reply(text="grounded answer")

    monkeypatch.setattr(agent_module, "handle", fake_handle)
    client = TestClient(app)
    resp = signed_post(client, whatsapp_form())
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    assert "grounded answer" in resp.text
    ctx = captured["ctx"]
    assert isinstance(ctx, RequestContext)
    assert ctx.user_id == "u_lucas"
    assert ctx.lab_id == "lab1"
    assert ctx.group_ids == ("lab1:u_lucas",)
    assert captured["text"] == "what did lucas suggest?"

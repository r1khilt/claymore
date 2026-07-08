"""Config defaults + API health smoke tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from claymore.api.app import app
from claymore.config import Settings


def test_feature_flags_default_off() -> None:
    # Half-built layers must be off by default so they can't break a demo (R1).
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.ingest_enabled is False
    assert s.act_enabled is False
    assert s.mcp_out_enabled is False
    assert s.exec_compute_enabled is False
    assert s.exec_wetlab_enabled is False
    assert s.graphiti_semaphore_limit == 10


def test_secrets_are_not_stringified() -> None:
    # SecretStr keeps keys out of logs/repr (SECURITY.md §7).
    s = Settings(_env_file=None, anthropic_api_key="sk-ant-secret")  # type: ignore[call-arg]
    assert "sk-ant-secret" not in str(s.anthropic_api_key)
    assert s.anthropic_api_key.get_secret_value() == "sk-ant-secret"


def test_healthz() -> None:
    client = TestClient(app)
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_readyz() -> None:
    client = TestClient(app)
    assert client.get("/readyz").status_code == 200

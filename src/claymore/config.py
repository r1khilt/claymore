"""Central, env-driven configuration (ENGINEERING_GUIDELINES.md §1: single source of truth).

Every tunable and every secret reference lives here, validated by Pydantic at startup —
no magic numbers or scattered ``os.getenv`` calls. Secrets are read from the environment
at runtime and never logged, never placed in the graph or a prompt (SECURITY.md §7).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings, populated from environment / ``.env`` (see ``.env.example``)."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", frozen=True
    )

    # --- runtime ---
    env: Literal["local", "staging", "prod"] = "local"
    log_level: str = "INFO"

    # --- core (Phase 0) ---
    anthropic_api_key: SecretStr = SecretStr("")
    voyage_api_key: SecretStr = SecretStr("")
    telegram_bot_token: SecretStr = SecretStr("")
    database_url: str = "postgresql+asyncpg://claymore:claymore@localhost:5432/claymore"
    redis_url: str = "redis://localhost:6380/0"
    falkordb_uri: str = "redis://localhost:6379"

    # --- ingestion (Phase 1) ---
    composio_api_key: SecretStr = SecretStr("")
    granola_api_key: SecretStr = SecretStr("")
    codelogs_paths: tuple[str, ...] = ()

    # --- messaging (Phase 2) ---
    twilio_account_sid: SecretStr = SecretStr("")
    twilio_auth_token: SecretStr = SecretStr("")
    twilio_messaging_service_sid: str = ""
    twilio_phone_number: str = ""

    # --- execution (Phase 3) ---
    modal_token_id: SecretStr = SecretStr("")
    modal_token_secret: SecretStr = SecretStr("")
    e2b_api_key: SecretStr = SecretStr("")

    # --- cost / behavior knobs (R6) ---
    extraction_model: str = "claude-haiku-4-5-20251001"
    query_model: str = "claude-opus-4-8"
    graphiti_semaphore_limit: int = Field(default=10, ge=1, le=100)
    per_lab_monthly_spend_cap_usd: float | None = None

    @field_validator("per_lab_monthly_spend_cap_usd", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        """Treat a blank/whitespace env var as unset (None).

        A commented-out or empty ``PER_LAB_MONTHLY_SPEND_CAP_USD=`` line in ``.env`` is the
        natural way to say "no cap", but pydantic would otherwise try to parse ``""`` as a float
        and fail app startup. Empty → None keeps a blank line meaning "unset" for every optional
        numeric knob.
        """
        if isinstance(v, str) and not v.strip():
            return None
        return v

    # --- feature flags (default OFF until a layer is built + eval'd; R1) ---
    ingest_enabled: bool = False
    act_enabled: bool = False
    mcp_out_enabled: bool = False
    exec_compute_enabled: bool = False
    exec_wetlab_enabled: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton (built once, reused everywhere)."""
    return Settings()

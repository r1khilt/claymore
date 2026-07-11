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
    telegram_webhook_secret: SecretStr = SecretStr("")
    """Random secret registered with ``setWebhook``; Telegram echoes it on every delivery."""
    telegram_enrollments: str = ""
    """Demo roster: comma-separated ``telegram_user_id:lab_id:user_id`` triples."""
    database_url: str = "postgresql+asyncpg://claymore:claymore@localhost:5432/claymore"
    redis_url: str = "redis://localhost:6380/0"
    falkordb_uri: str = "redis://localhost:6379"

    # --- ingestion (Phase 1) ---
    composio_api_key: SecretStr = SecretStr("")
    composio_user_id: str = ""
    """Optional Composio user id override. Empty uses ``WEB_USER_ID`` so a local install only
    needs ``COMPOSIO_API_KEY``; Composio Sessions create the managed OAuth connections."""
    composio_slack_version: str = "20260512_00"
    composio_gmail_version: str = "20260702_01"
    composio_github_version: str = "20260702_00"
    composio_notion_version: str = "20260702_00"
    """Pinned toolkit schemas. These differ by provider; Claymore parses their outputs in Python,
    so direct execution must never silently float to a new response shape."""
    composio_sync_days: int = Field(default=30, ge=1, le=365)
    """Default first-sync window. Provider-side filters keep the window bounded before paging."""
    composio_cache_dir: str = ""
    """Optional Composio SDK cache directory. Empty uses Claymore's local state directory."""
    granola_api_key: SecretStr = SecretStr("")
    codelogs_paths: tuple[str, ...] = ()
    lab_roster_json: str = ""
    """Demo roster until the Postgres state layer lands: JSON list of ``auth.models.User``
    objects (id, lab_id, person_id, platform_handles) seeding identity resolution (R11)."""

    # --- admin API (ingest triggers) ---
    admin_api_token: SecretStr = SecretStr("")
    """Bearer for ``/admin/*``. Empty ⇒ every admin request is rejected (fail-closed) — the
    API may be exposed through a public tunnel, so these routes are never open."""

    # --- web UI (browser dashboard -> /api/ask) ---
    web_api_enabled: bool = False
    """Expose ``POST /api/ask`` for the ``web/`` dashboard. Off by default: unlike Telegram it
    has no per-message auth and answers as one configured demo identity, so enable only for
    local dev / a trusted deployment. Retrieval scoping + grounding still apply (R10/R13)."""
    web_lab_id: str = "lab1"
    web_user_id: str = "web-user"

    # --- messaging (Phase 2) ---
    twilio_account_sid: SecretStr = SecretStr("")
    twilio_auth_token: SecretStr = SecretStr("")
    twilio_messaging_service_sid: str = ""
    twilio_phone_number: str = ""
    twilio_whatsapp_from: str = ""
    """Twilio WhatsApp sender, bare E.164 (sandbox default is +14155238886)."""
    whatsapp_enrollments: str = ""
    """Demo roster until the Postgres enrollment table lands: comma-separated
    ``phone:lab_id:user_id`` triples allowed to talk to the agent over WhatsApp."""
    public_base_url: str = ""
    """Public origin Twilio signs webhook URLs against (e.g. an ngrok/Fly URL); empty = as-seen."""

    # --- execution (Phase 3) ---
    modal_token_id: SecretStr = SecretStr("")
    modal_token_secret: SecretStr = SecretStr("")
    e2b_api_key: SecretStr = SecretStr("")
    claude_science_url: str = "http://localhost:8765"
    """Local Claude Science daemon Claymore drives over its HTTP API (execute/claude_science.py).
    MUST be a loopback origin (localhost/127.0.0.0-8/::1) — a non-loopback value is refused and the
    tool degrades to a simulated preview. Unreachable ⇒ preview as well."""
    claude_science_model: str = "claude-opus-4-8"
    """Model Claude Science runs the submitted task with (its own agents call it server-side)."""
    claude_science_effort: str = "high"
    """Reasoning effort Claude Science runs the task at (``low`` | ``medium`` | ``high``)."""
    claude_science_project_id: str = ""
    """Target Claude Science project id; empty ⇒ Claymore picks the first non-example project."""
    claude_science_cli: str = ""
    """Path to the ``claude-science`` CLI used to mint a one-time login nonce; empty ⇒
    ``~/.claude-science/bin/claude-science``."""
    claude_science_poll_interval_s: float = 2.0
    """How often (seconds) Claymore polls a running Claude Science frame for progress."""
    claude_science_run_timeout_s: float = 900.0
    """Max seconds Claymore waits for a Claude Science run before giving up (the run keeps going
    server-side; Claymore just stops waiting and returns an honest 'still running' result)."""
    claude_science_allowed_domains: str = (
        "figshare.com,zenodo.org,datadryad.org,osf.io,dryad.org,cern.ch,"
        "nih.gov,ncbi.nlm.nih.gov,ebi.ac.uk,ensembl.org,uniprot.org,rcsb.org,wwpdb.org,pdbe.org,"
        "biorxiv.org,medrxiv.org,arxiv.org,europepmc.org,ncbi.nlm.nih.gov,"
        "reactome.org,kegg.jp,string-db.org,proteinatlas.org,genome.ucsc.edu,ucsc.edu,"
        "github.com,githubusercontent.com,huggingface.co,addgene.org,pypi.org,files.pythonhosted.org"
    )
    """Comma-separated allowlist of domains a Claude Science run MAY reach for the outside world
    (dataset downloads, doc/DB lookups). Egress is deny-by-default (CLAUDE.md rule 7): the run's
    external-network requests are auto-approved ONLY when the target host matches one of these base
    domains (or a subdomain of one), and denied otherwise — so a run can pull public data but can't
    exfiltrate to an arbitrary host. Set to empty to restore deny-all egress; extend per lab. A
    match is exact host or a dot-boundary subdomain (``api.figshare.com`` matches ``figshare.com``;
    ``figshare.com.evil.com`` does not)."""

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

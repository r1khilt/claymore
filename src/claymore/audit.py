"""Immutable audit trail (CLAUDE.md rule 5, SECURITY.md §10).

Every ingestion, query, action, and execution writes a record: who/what/when, which sources
were touched, and whether it originated from a *user instruction* or from *ingested content*
(the trust-origin distinction is the most reliable injection-detection signal, SECURITY.md §2).
This module owns the record shape + a sink interface; the Postgres append-only sink lands with
the state layer. The dev sink just logs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from claymore.domain import LabId
from claymore.logging import get_logger

_log = get_logger("audit")


class TrustOrigin(StrEnum):
    """Did this action originate from a human's instruction, or from ingested (untrusted) text?"""

    USER = "user"
    INGESTED = "ingested"
    SYSTEM = "system"


class AuditRecord(BaseModel):
    """One immutable audit entry."""

    model_config = ConfigDict(frozen=True)

    lab_id: LabId
    actor: str
    """User id, MCP client id, or a system component name."""

    action: str
    """e.g. ``"query"``, ``"ingest_episode"``, ``"action.file_issue"``, ``"exec.run_compute"``."""

    trust_origin: TrustOrigin
    sources_touched: tuple[str, ...] = ()
    detail: dict[str, str] = Field(default_factory=dict)
    at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AuditSink(ABC):
    """Where audit records go. Must be append-only + immutable in prod (SECURITY.md §10)."""

    @abstractmethod
    async def write(self, record: AuditRecord) -> None: ...


class LoggingAuditSink(AuditSink):
    """Dev sink — emits the record to the structured log. Replace with the Postgres sink in prod."""

    async def write(self, record: AuditRecord) -> None:
        _log.info("audit", **record.model_dump(mode="json"))

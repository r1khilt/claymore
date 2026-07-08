"""Structured JSON logging with correlation IDs (ENGINEERING_GUIDELINES.md §3).

A correlation ID is bound per request/pipeline and threaded through the whole async flow
(ingest → extract → store → retrieve → generate → act) so a single run is traceable end to
end. Raw source text and secrets never go in logs (SECURITY.md §6/§7) — that is a review rule,
not something enforced here; keep log payloads to IDs and metadata.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar

import structlog

# Bound per request; empty until a handler sets it. Threads across await points.
correlation_id: ContextVar[str] = ContextVar("correlation_id", default="")


def _add_correlation_id(
    _logger: object, _method: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    cid = correlation_id.get()
    if cid:
        event_dict["correlation_id"] = cid
    return event_dict


def configure_logging(level: str = "INFO") -> None:
    """Install JSON structured logging process-wide. Call once at startup."""
    logging.basicConfig(format="%(message)s", level=getattr(logging, level.upper(), logging.INFO))
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _add_correlation_id,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Return a bound structured logger for ``name``."""
    return structlog.get_logger(name)  # type: ignore[no-any-return]

"""The Anthropic ``LLM`` adapter — a dumb, injection-safe transport with model routing.

This is the concrete ``claymore.ports.LLM`` seam (ENGINEERING_GUIDELINES §1, R9): domain code
depends on the ``LLM`` interface, this file is the only place that touches the Anthropic SDK, so
swapping providers is one new adapter with zero changes to core.

Two responsibilities live here and nowhere else:

* **Model routing (R6).** Extraction is cheap-per-episode and runs on every ingested item, so it
  uses the cheap model (``settings.extraction_model``, Haiku/Sonnet); query-time reasoning uses the
  strong model (``settings.query_model``, Opus). ``route()`` maps a ``TaskKind`` to the configured
  id — callers name the *task*, not the model string.
* **Injection posture (CLAUDE.md hard rule 7 / SECURITY.md rule 7).** Claymore is a lethal-trifecta
  system, so this adapter treats ``system`` and ``prompt`` as opaque **data** and passes them
  through verbatim — it never parses, templates, or interprets them. Keeping untrusted content from
  ever acting as instructions is the *caller's* job (the extraction agent holds no action tools; the
  action agent works only on structured, provenance-tagged facts). The adapter's one and only
  content rule is a defensive ``max_tokens`` bound.

The Anthropic SDK is imported **lazily inside methods**, never at module top level: the package may
be absent in some installs, and the unit/eval suites must run offline with no key and no network.
The API key is read from ``Settings`` via ``get_secret_value()`` only at call time and is never
logged nor placed in an exception message (SECURITY.md §7).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from enum import StrEnum
from typing import TYPE_CHECKING

from claymore.config import Settings
from claymore.ports import LLM

if TYPE_CHECKING:  # types only — never imported at runtime, so the SDK stays optional
    from anthropic import AsyncAnthropic
    from anthropic.types import MessageParam

#: Returned by :class:`FakeLLM` once a scripted response queue is exhausted. Stable so tests can
#: assert the fallback deterministically.
CANNED_RESPONSE = "[fake-llm] no scripted response"


class TaskKind(StrEnum):
    """What a completion is *for*, so routing picks cost-appropriate models (R6)."""

    EXTRACTION = "extraction"  # per-episode, high volume -> cheap model
    REASONING = "reasoning"  # query-time answers/planning -> strong model


def _check_max_tokens(max_tokens: int) -> None:
    """Reject a nonsensical budget before any transport work (shared by both adapters).

    A non-positive cap is a caller bug, not untrusted input, so it fails loudly with ``ValueError``
    rather than degrading silently.
    """
    if max_tokens <= 0:
        raise ValueError("max_tokens must be a positive integer")


class AnthropicLLM(LLM):
    """``LLM`` backed by Anthropic's Messages API, with Haiku/Opus task routing (R6)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Built lazily on first call so importing this module never requires the SDK or a key.
        self._client: AsyncAnthropic | None = None

    def route(self, task: TaskKind) -> str:
        """Map a task to its configured model id (extraction -> cheap, reasoning -> strong, R6)."""
        if task is TaskKind.EXTRACTION:
            return self._settings.extraction_model
        return self._settings.query_model

    def _client_or_build(self) -> AsyncAnthropic:
        """Return the cached async client, constructing it (and reading the key) on first use.

        The key is fetched via ``get_secret_value()`` here, at call time — never at import, never
        stored on the instance, never logged (SECURITY.md §7).
        """
        if self._client is None:
            from anthropic import AsyncAnthropic  # lazy: SDK optional, offline tests never hit this

            self._client = AsyncAnthropic(
                api_key=self._settings.anthropic_api_key.get_secret_value()
            )
        return self._client

    async def complete(
        self, *, system: str, prompt: str, model: str | None = None, max_tokens: int = 1024
    ) -> str:
        """One completion. ``model=None`` routes to the reasoning model (R6).

        ``system`` and ``prompt`` are forwarded verbatim as data and never interpreted
        (injection posture, SECURITY.md rule 7).
        """
        _check_max_tokens(max_tokens)
        chosen = model or self.route(TaskKind.REASONING)
        client = self._client_or_build()
        messages: list[MessageParam] = [{"role": "user", "content": prompt}]
        message = await client.messages.create(
            model=chosen,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
        return "".join(block.text for block in message.content if block.type == "text")


class FakeLLM(LLM):
    """Deterministic, offline ``LLM`` for tests and the eval harness — no SDK, no key, no network.

    Pops ``responses`` in order per :meth:`complete` call, then falls back to
    :data:`CANNED_RESPONSE` once drained. Every call is recorded on :attr:`calls` so tests assert
    exactly what was sent (and, per the injection posture, that untrusted text arrived verbatim).
    """

    def __init__(self, responses: Sequence[str] | None = None) -> None:
        self._responses: deque[str] = deque(responses or ())
        #: One ``(system, prompt, model, max_tokens)`` tuple per completed call, in order.
        self.calls: list[tuple[str, str, str | None, int]] = []

    async def complete(
        self, *, system: str, prompt: str, model: str | None = None, max_tokens: int = 1024
    ) -> str:
        """Record the call verbatim and return the next scripted (or canned) response."""
        _check_max_tokens(max_tokens)
        self.calls.append((system, prompt, model, max_tokens))
        if self._responses:
            return self._responses.popleft()
        return CANNED_RESPONSE

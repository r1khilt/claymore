"""[Pipes] Telegram ``MessagingChannel`` adapter — dev/pilot channel (CLAUDE.md §3).

Free, instant, no carrier gate — the default for all agent iteration until Twilio 10DLC clears.
Inline buttons render the approval ✅/❌. Inbound messages authenticate the human against the
enrolled-user allowlist (SECURITY.md §8), build a ``RequestContext``, and call ``agent.handle``.

TODO(Phase 0): echo bot + round-trip. (Phase 2): wire to agent.handle + approval buttons.
"""

from __future__ import annotations

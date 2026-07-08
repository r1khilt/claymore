"""[Pipes] Twilio SMS ``MessagingChannel`` adapter — prod channel (CLAUDE.md §3, R4).

Behind the A2P 10DLC gate (10-15 day carrier review). Verifies ``X-Twilio-Signature`` on every
inbound webhook (SECURITY.md §8). SMS has no buttons — approvals use numbered tokens
(``approve A3``), resolved via the approval gate. Flip prod here from Telegram with a one-line
channel swap when the campaign clears.

TODO(Phase 2): inbound signature verify + send() + numbered-token approval replies.
"""

from __future__ import annotations

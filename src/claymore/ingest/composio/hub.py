"""[Pipes] Composio ``ConnectorHub`` adapter — Slack, Gmail, GitHub, Notion, Drive, Docs.

Implements ``claymore.ports.ConnectorHub`` over Composio managed OAuth (per-user connected
accounts). Verifies signed webhooks (``webhook-signature``, SECURITY.md §8); populates each
``Episode``'s ``visibility`` from the source object's ACL (R13); streams backfill (never slurp,
R6). Note the 15-min polling default on managed OAuth.

TODO(Phase 1): backfill/incremental per source + ACL→visibility mapping + webhook verify.
"""

from __future__ import annotations

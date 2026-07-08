"""[Brain] MCP-out server (FastMCP) — expose lab memory to the lab's own agents (BUILD_PLAN §4.5b).

Narrow, named tools: ``search_lab_memory``, ``who_worked_on``, ``what_was_decided``,
``find_protocol`` — so Codex/Claude Code/Cursor/Claude Science can pull lab context mid-task.
OAuth 2.1+PKCE, audience validation, per-client consent, strict schemas, SSRF blocks, per-session
scope; read-only by default, writes stay behind the approval gate (SECURITY.md §3a).

TODO(Phase 2.5): FastMCP server + tools + scope enforcement + hardening.
"""

from __future__ import annotations

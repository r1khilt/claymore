"""[Brain] Agent tool definitions (BUILD_PLAN.md §4.5).

base: search_memory, draft_reply, file_issue, create_page, make_link, request_approval,
post_result. bio: expand_idea, run_compute, propose_protocol. Strict JSON-schema args double as
a security control (SECURITY.md §3a). Write tools only ever propose a ``PendingAction`` — they
never execute directly; the approval gate does (hard rule 3).

TODO(Phase 2/2.5): declare tool schemas + bind to retrieval / actions / execute.
"""

from __future__ import annotations

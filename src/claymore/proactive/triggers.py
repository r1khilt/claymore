"""Proactive surfacing — reach out first (BUILD_PLAN.md §4.5c).

Scheduled + event-triggered: pre-meeting briefs, "this idea was never tested," digests, "a
decision was just contradicted." The contradiction/never-tested triggers subscribe to the
reconciliation pass's edge-creation events (R12). Respects a per-user notification budget
(rate-limit, quiet hours, batch low-priority into the digest).

TODO(Phase 2.5): one scheduled digest + one event trigger, behind a notification budget.
"""

from __future__ import annotations

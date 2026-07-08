"""Proactive surfacing — reach out first (CLAUDE.md §1 feature 5, BUILD_PLAN.md §4.5c).

Deterministic, on-graph triggers that turn facts and reconciled edges into *grounded*
notifications the lab never asked for: "this idea from last week was never tested", "a decision
was just contradicted", and a periodic digest. This module decides **what** to surface and
**why** — it never sends anything (messaging is a separate layer, ``messaging/*``) and holds no
credentials.

How notifications stay grounded (hard rule 1 — never fabricate attribution): every
``Notification`` carries a non-empty tuple of :class:`Citation`, each pointing at the exact
``Fact`` edge it rests on (via :func:`claymore.memory.reconcile.fact_identity`) together with
that fact's provenance (platform, source id, timestamp, author). Nothing is asserted that isn't
traceable to a stored fact. Where an idea's author could not be resolved, the citation surfaces
``UNKNOWN_AUTHOR`` verbatim — we never guess a name (R11).

Security (SECURITY.md, lethal-trifecta): all ``object_id`` / ``subject_id`` / source text here
originates from untrusted ingested content. This module treats every bit of it as **inert
data** — grouped, counted, and string-formatted into notification bodies, never parsed or
interpreted as instructions.

Determinism: the trigger and budget logic take ``now`` (and window bounds) as arguments and
never read the wall clock, so results are reproducible and testable (ENGINEERING_GUIDELINES.md
§1: golden-set friendly). ``Fact`` inputs are frozen and never mutated.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from claymore.domain import PersonId, SourcePlatform, UserId
from claymore.memory.ontology import EdgeType, Fact
from claymore.memory.reconcile import fact_identity

# --- notification vocabulary ---

NotificationKind = Literal["never_tested", "contradiction", "digest"]
Priority = Literal["low", "normal", "high"]

# Edges that mark an idea as *acted on* — a SUGGESTED idea touched by one of these was tested,
# so it no longer warrants a "never tested" nudge (CLAUDE.md §6).
_ACTED_ON_EDGES: frozenset[EdgeType] = frozenset({EdgeType.RAN, EdgeType.PRODUCED})

# Send-ordering rank; lower sends first. High-priority (e.g. a contradicted decision) is surfaced
# ahead of routine nudges and consumes the rate-limit budget first.
_PRIORITY_RANK: dict[Priority, int] = {"high": 0, "normal": 1, "low": 2}

# How many headline items a digest lists inline before it just reports counts.
_DIGEST_HEADLINES = 5


class Citation(BaseModel):
    """A single grounding pointer: the exact fact-edge a notification claim rests on.

    ``fact_id`` is :func:`claymore.memory.reconcile.fact_identity` of the source fact, so a
    reader can trace the claim back to one precise edge. The provenance fields are copied inertly
    from that fact; ``author`` is surfaced as-is (``UNKNOWN_AUTHOR`` when unresolved — never
    guessed, R11 / hard rule 1).
    """

    model_config = ConfigDict(frozen=True)

    fact_id: str
    source_platform: SourcePlatform
    source_id: str
    timestamp: datetime
    author: PersonId


class Notification(BaseModel):
    """A grounded, ready-to-route proactive message. Rendering/sending is the messaging layer's.

    Invariant (hard rule 1): ``citations`` is non-empty — a notification that cannot be traced to
    at least one stored fact must not exist. ``user_id`` is the intended recipient; for the
    on-graph triggers it is the person the surfaced fact is attributed to (which may be
    ``UNKNOWN_AUTHOR``), and fan-out to every eligible viewer is the messaging layer's job.
    """

    model_config = ConfigDict(frozen=True)

    user_id: UserId
    kind: NotificationKind
    title: str
    body: str
    citations: tuple[Citation, ...]
    priority: Priority = "normal"

    @field_validator("citations")
    @classmethod
    def _must_be_grounded(cls, value: tuple[Citation, ...]) -> tuple[Citation, ...]:
        """Refuse an ungrounded notification (hard rule 1: no source → don't assert it)."""
        if not value:
            raise ValueError("a Notification must carry at least one Citation (hard rule 1)")
        return value


def _cite(fact: Fact) -> Citation:
    """Build a :class:`Citation` from a fact's identity + provenance (grounding helper)."""
    prov = fact.provenance
    return Citation(
        fact_id=fact_identity(fact),
        source_platform=prov.source_platform,
        source_id=prov.source_id,
        timestamp=prov.timestamp,
        author=prov.author,
    )


def _order_key(fact: Fact) -> tuple[str, str]:
    """Deterministic originating-fact order: earliest timestamp, then identity as a stable tie."""
    return (fact.provenance.timestamp.isoformat(), fact_identity(fact))


# --- triggers ---


def never_tested_ideas(facts: Sequence[Fact]) -> list[Notification]:
    """Surface SUGGESTED ideas that were proposed but never acted on (CLAUDE.md §1.5).

    An idea is identified by the ``object_id`` of its ``SUGGESTED`` edge (the thing suggested —
    *not* the suggester, so a person running something unrelated never silences their own untested
    idea). It counts as *acted on* if that id appears on either end of any ``RAN`` / ``PRODUCED``
    fact (``_ACTED_ON_EDGES``); such ideas are dropped. The remaining ideas each become one
    "this idea from <when> was never tested" nudge.

    Grounding: each nudge cites the **originating** suggestion (earliest by timestamp) and is
    attributed to that fact's author (``UNKNOWN_AUTHOR`` surfaced, never guessed — R11). Dedupe:
    many suggestions of the same idea collapse to a single nudge. Deterministic and
    input-order-independent; inputs are never mutated. Untrusted ``object_id`` text is embedded
    inertly in the body (SECURITY.md, lethal-trifecta).
    """
    acted_on: set[str] = set()
    suggested: list[Fact] = []
    for fact in facts:
        if fact.edge in _ACTED_ON_EDGES:
            acted_on.add(fact.subject_id)
            acted_on.add(fact.object_id)
        elif fact.edge is EdgeType.SUGGESTED:
            suggested.append(fact)

    # Keep the originating (earliest) suggestion per idea; skip ideas already acted on.
    originating: dict[str, Fact] = {}
    for fact in suggested:
        if fact.object_id in acted_on:
            continue
        current = originating.get(fact.object_id)
        if current is None or _order_key(fact) < _order_key(current):
            originating[fact.object_id] = fact

    notifications: list[Notification] = []
    for idea in sorted(originating):  # sort keys for a stable, reproducible output order
        fact = originating[idea]
        when = fact.provenance.timestamp.date().isoformat()
        notifications.append(
            Notification(
                user_id=fact.provenance.author,
                kind="never_tested",
                title=f"Untested idea: {idea}",
                body=(
                    f"Suggested by {fact.provenance.author} on {when} and never tested since. "
                    f"Worth a look? [{idea}]"
                ),
                citations=(_cite(fact),),
                priority="normal",
            )
        )
    return notifications


def contradiction_alerts(reconciled_edges: Sequence[Fact]) -> list[Notification]:
    """Turn reconciled ``CONTRADICTS`` edges into high-priority "a decision was contradicted".

    Input is the output of :func:`claymore.memory.reconcile.reconcile` (edges in
    ``{CONTRADICTS, SUPERSEDES}``, R12). Only ``CONTRADICTS`` is surfaced here — a supersession is
    an orderly timeline update, not an alert. Each contradiction becomes one ``high``-priority
    notification grounded in the reconciled edge's provenance (attributed to the later
    contributing fact's author, per reconcile). ``SUPERSEDES`` and any other edge are ignored.

    Deterministic; inputs never mutated. The edge's ``subject_id`` / ``object_id`` are the
    fact-identities of the two conflicting facts and are embedded inertly (SECURITY.md).
    """
    notifications: list[Notification] = []
    for edge in reconciled_edges:
        if edge.edge is not EdgeType.CONTRADICTS:
            continue
        notifications.append(
            Notification(
                user_id=edge.provenance.author,
                kind="contradiction",
                title="A decision was just contradicted",
                body=(
                    "Two facts on the same subject conflict. "
                    f"[{edge.subject_id}] contradicts [{edge.object_id}]"
                ),
                citations=(_cite(edge),),
                priority="high",
            )
        )
    return notifications


def digest(
    facts: Sequence[Fact], *, since: datetime, now: datetime, user_id: UserId
) -> Notification | None:
    """Roll facts from the window ``(since, now]`` into one low-priority digest, or ``None``.

    Selects facts whose ``provenance.timestamp`` falls in the half-open window ``(since, now]``,
    reports counts by edge type, and lists a few most-recent headline items. Returns ``None`` when
    nothing lands in the window (nothing to say). ``user_id`` is the recipient the caller has
    already scoped these facts to (a digest has no single author to derive from).

    Grounding: the digest cites its headline facts (hard rule 1 — a digest with content always
    carries citations). Deterministic (``now``/``since`` injected); inputs never mutated; all
    ``subject_id``/``object_id`` text is inert (SECURITY.md).
    """
    in_window = [f for f in facts if since < f.provenance.timestamp <= now]
    if not in_window:
        return None

    counts = Counter(f.edge.value for f in in_window)
    count_line = ", ".join(f"{n} {edge}" for edge, n in sorted(counts.items()))

    # Most-recent-first headlines; timestamp then identity keeps ordering deterministic.
    headlines = sorted(
        in_window,
        key=lambda f: (f.provenance.timestamp.isoformat(), fact_identity(f)),
        reverse=True,
    )[:_DIGEST_HEADLINES]
    headline_lines = "\n".join(
        f"- {f.edge.value}: {f.subject_id} -> {f.object_id}" for f in headlines
    )

    window_label = f"{since.date().isoformat()}..{now.date().isoformat()}"
    return Notification(
        user_id=user_id,
        kind="digest",
        title=f"Lab digest: {len(in_window)} updates ({window_label})",
        body=f"{count_line}\n{headline_lines}",
        citations=tuple(_cite(f) for f in headlines),
        priority="low",
    )


# --- notification budget ---


class NotificationBudget(BaseModel):
    """Per-user delivery policy: rate limit, quiet hours, and dedupe (CLAUDE.md §1.5).

    * ``max_per_window`` sends allowed within a trailing ``window``.
    * Quiet hours ``[quiet_start_hour, quiet_end_hour)`` (24h clock, wrapping past midnight is
      supported) let **only** ``high`` priority through; ``low``/``normal`` are held back to be
      batched into the next scheduled digest. ``start == end`` disables quiet hours.
    * Deduplication is content-based (see :func:`apply_budget`).
    """

    model_config = ConfigDict(frozen=True)

    max_per_window: int = Field(default=5, ge=0)
    window: timedelta = Field(default=timedelta(hours=24))
    quiet_start_hour: int = Field(default=22, ge=0, le=23)
    quiet_end_hour: int = Field(default=7, ge=0, le=23)

    @field_validator("window")
    @classmethod
    def _window_positive(cls, value: timedelta) -> timedelta:
        if value <= timedelta(0):
            raise ValueError("window must be positive")
        return value


class UserNotificationState(BaseModel):
    """What the caller remembers between budget checks so the policy stays deterministic.

    ``sent_at`` are timestamps of already-delivered notifications (used for the rate window);
    ``seen_signatures`` are content signatures already delivered (used for dedupe). The caller
    persists this and updates it after acting on :func:`apply_budget`'s result — this module never
    mutates it.
    """

    model_config = ConfigDict(frozen=True)

    sent_at: tuple[datetime, ...] = ()
    seen_signatures: frozenset[str] = frozenset()


def notification_signature(notification: Notification) -> str:
    """Content identity used for dedupe — two notifications with the same signature are identical.

    Combines recipient, kind, title, body, and the ordered cited fact ids. Pure string formatting
    over inert data.
    """
    cited = ",".join(c.fact_id for c in notification.citations)
    return "|".join(
        (notification.user_id, notification.kind, notification.title, notification.body, cited)
    )


def _in_quiet_hours(now: datetime, start: int, end: int) -> bool:
    """Whether ``now`` falls in the quiet window ``[start, end)`` (start inclusive, end exclusive).

    ``start == end`` means quiet hours are disabled. A window with ``start > end`` wraps midnight
    (e.g. 22->7). Boundary: exactly at ``start`` is quiet; exactly at ``end`` is not.
    """
    if start == end:
        return False
    hour = now.hour
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def apply_budget(
    notifications: Sequence[Notification],
    *,
    budget: NotificationBudget,
    user_state: UserNotificationState,
    now: datetime,
) -> list[Notification]:
    """Decide which notifications may send **now**; hold/suppress the rest (deterministic).

    Applied in order:

    1. **Dedupe** — drop anything whose :func:`notification_signature` was already delivered
       (``user_state.seen_signatures``) or already appeared earlier in this batch.
    2. **Quiet hours** — if ``now`` is within the budget's quiet window, keep only ``high``
       priority; ``low``/``normal`` are held back (to be batched into the next digest).
    3. **Rate limit** — count deliveries already inside the trailing ``window`` ending at ``now``,
       then admit remaining candidates up to ``max_per_window``, highest priority first
       (``_PRIORITY_RANK``), preserving input order within a priority for a stable result.

    Returns only the notifications cleared to send now. This function is pure — it reads
    ``user_state`` and ``now`` but never mutates them; the caller records what it sends.
    """
    # 1. Dedupe (against history + within the batch), preserving input order.
    seen: set[str] = set(user_state.seen_signatures)
    deduped: list[Notification] = []
    for notification in notifications:
        signature = notification_signature(notification)
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(notification)

    # 2. Quiet hours: only high-priority passes; low/normal deferred to the digest.
    quiet = _in_quiet_hours(now, budget.quiet_start_hour, budget.quiet_end_hour)
    candidates = [n for n in deduped if not quiet or n.priority == "high"]

    # 3. Rate limit within the trailing window, high-priority first, then stable input order.
    window_start = now - budget.window
    recent = sum(1 for sent in user_state.sent_at if window_start < sent <= now)
    remaining = max(0, budget.max_per_window - recent)

    ordered = sorted(
        enumerate(candidates), key=lambda pair: (_PRIORITY_RANK[pair[1].priority], pair[0])
    )
    return [notification for _, notification in ordered[:remaining]]

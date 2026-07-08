"""[Brain] Temporal-expression resolver (BUILD_PLAN.md §4.5).

Resolves fuzzy relative time in queries ("last week," "a couple months ago") to an explicit
bi-temporal ``(start, end)`` window that retrieval filters on, and echoes the resolved window's
``label`` in the answer so temporal ambiguity is visible, not silent. This is what makes
*"what did Lucas suggest last week?"* answerable with a *when* as well as a citation
(CLAUDE.md §2 hard-rule 1, §6 bi-temporal edges).

Design constraints (why it looks the way it does):

* **Deterministic + injectable clock.** ``now`` is passed in, never read from the wall clock, so
  the same query always resolves the same window and tests pin exact bounds. This is a pure
  function of ``(text, now)`` — the temporal-correctness edge cases in
  ENGINEERING_GUIDELINES.md §3 (timezones, boundaries) are testable precisely because of this.
* **Untrusted input.** Query text is treated as data: it is never ``eval``/``exec``'d, never
  used to build code, and matched only against a fixed table of regexes. Garbage, huge, or
  injection-shaped input must never raise — it degrades to "all time" (no constraint).
* **Stdlib only.** ``datetime`` / ``re`` / ``calendar``; no ``dateutil`` (not a declared dep).
* **UTC everywhere.** ``now`` is normalized to UTC first (naive ``now`` is assumed UTC), so a
  resolved window is always tz-aware UTC. Per-asker timezone is a future refinement; the
  window contract is UTC today.

Semantics: windows are half-open ``[start, end)``. ``start=None`` means unbounded-before and
``end=None`` unbounded-after; **both None = no temporal constraint** ("all time"). Calendar
phrases ("today", "this week", "in June") snap to day/week/month boundaries; rolling phrases
("last 5 days", "a couple months ago", "recently") are measured back from ``now`` and end at
``now``. Weeks start Monday. If two *different* time expressions appear in one query it is
treated as ambiguous and resolves to "all time" rather than guessing which the asker meant.

Directional qualifiers on an otherwise-resolvable anchor are honored, not ignored (getting this
wrong is the worst failure class here — a confidently *inverted* window, CLAUDE.md §2 rule 1):
``since``/``after <phrase>`` reopens the window to end at ``now`` (``[anchor.start, now]``);
``before``/``until <phrase>`` makes it unbounded-before the anchor (``[None, anchor.start]``).
Negation/exclusion qualifiers (``not``, ``except``, ``other than``, ``excluding``) describe a
*complement*, which a single contiguous window cannot express — so they degrade to "all time"
with a label that flags it was not pinned, rather than ever returning the excluded window itself.
Anything not confidently handled falls back to "all time"; the module never guesses a window.
"""

from __future__ import annotations

import calendar
import re
from collections.abc import Callable
from datetime import MAXYEAR, MINYEAR, UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict, field_validator

# --- tunable constants (no magic numbers scattered in logic, ENGINEERING_GUIDELINES §1) ---

ALL_TIME_LABEL = "all time"
"""Label for the unbounded window returned when nothing (or something ambiguous) is matched."""

ALL_TIME_EXCLUSION_LABEL = "all time (unparsed exclusion)"
"""Label for the unbounded window returned when a negation/exclusion qualifier ("not last week",
"everything except this week") is detected. A single contiguous window cannot express the
complement the asker meant, so we return "all time" and flag that it was *not* pinned — never the
excluded window itself, which would be a confidently wrong answer (CLAUDE.md §2 rule 1)."""

RECENT_DAYS = 14
"""How far back "recently" reaches, in days."""

MAX_TEXT_CHARS = 512
"""Query prefix actually scanned. A real time phrase sits at the front of a question; capping
keeps a pathological 100k-char input cheap without changing any real-world result."""

# Word-number vocabulary. Fuzzy quantifiers ("couple"/"few"/"several") are deliberately mapped
# to conservative small counts so recall stays wide rather than missing the target episode.
_FUZZY: dict[str, int] = {"couple": 2, "few": 3, "several": 3}
_NUMBER_WORDS: dict[str, int] = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    **_FUZZY,
}

_MONTH_INDEX: dict[str, int] = {
    name.lower(): i for i, name in enumerate(calendar.month_name) if name
}

# Out-of-range guards: clamp here instead of letting datetime arithmetic raise (adversarial
# "last 999999 months"). Both are tz-aware UTC so the window invariant always holds.
_DATETIME_MIN = datetime.min.replace(tzinfo=UTC)
_DATETIME_MAX = datetime.max.replace(tzinfo=UTC)


class TimeWindow(BaseModel):
    """A resolved bi-temporal window ``[start, end)`` retrieval filters on.

    Immutable. ``start``/``end`` are tz-aware UTC (coerced on construction); ``None`` on a side
    means unbounded there, and both ``None`` means "no temporal constraint". ``label`` is the
    human hint (the matched phrase, or ``"all time"``) echoed back so the asker sees which
    window the answer was scoped to.
    """

    model_config = ConfigDict(frozen=True)

    start: datetime | None
    """Inclusive lower bound (UTC), or ``None`` for unbounded-before."""

    end: datetime | None
    """Exclusive upper bound (UTC), or ``None`` for unbounded-after."""

    label: str
    """Human-readable hint for the answer, e.g. ``"last week"`` or ``"all time"``."""

    @field_validator("start", "end")
    @classmethod
    def _coerce_utc(cls, value: datetime | None) -> datetime | None:
        """Guarantee the UTC-aware invariant regardless of how the window is constructed."""
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


def resolve_window(text: str, *, now: datetime) -> TimeWindow:
    """Resolve a natural-language time expression in ``text`` to a :class:`TimeWindow`.

    ``now`` is the reference instant (injected for determinism, never the wall clock); a naive
    ``now`` is assumed to be UTC. Matching is case-insensitive. Unrecognized, empty, ambiguous,
    or malformed input returns the unbounded "all time" window — this function never raises on
    caller input (it is fed untrusted query text; see the module docstring).
    """
    now = _ensure_utc(now)
    normalized = text.strip().lower()[:MAX_TEXT_CHARS]
    if not normalized:
        return _all_time()

    try:
        # Collect every match from every rule, then collapse to non-overlapping regions. Zero
        # regions → unrecognized. Two+ regions → the query names two different times ("last
        # week last month", "in january in june") → ambiguous. Either way we decline to guess
        # and return the unbounded window (fail-open on scope, never on facts). Counting
        # *regions* (not rules) catches a repeated expression, which a per-rule search misses.
        spans = sorted(
            (
                (m.start(), m.end(), handler, m)
                for pattern, handler in _RULES
                for m in pattern.finditer(normalized)
            ),
            key=lambda s: (s[0], -s[1]),  # earliest start first, longest span wins ties
        )
        chosen: tuple[Callable[[datetime, re.Match[str]], TimeWindow], re.Match[str]] | None = None
        region_end = -1
        for start, end, handler, match in spans:
            if start >= region_end:  # opens a new, non-overlapping region
                if chosen is not None:
                    return _all_time()  # a second distinct time expression → ambiguous
                chosen = (handler, match)
            region_end = max(region_end, end)
        if chosen is None:
            return _all_time()
        handler, match = chosen
        return _apply_qualifier(normalized, match, handler(now, match), now)
    except (ValueError, OverflowError, KeyError):
        # Defensive: any arithmetic/lookup surprise on hostile input degrades to "all time"
        # rather than propagating. A crash on a user's question is never acceptable.
        return _all_time()


# --- window builders --------------------------------------------------------------------------


def _all_time() -> TimeWindow:
    return TimeWindow(start=None, end=None, label=ALL_TIME_LABEL)


def _win(start: datetime, end: datetime, label: str) -> TimeWindow:
    return TimeWindow(start=start, end=end, label=label)


# --- qualifier handling (directional / negation on a resolved anchor) --------------------------
# These act on the text *immediately before* the matched phrase. Directional qualifiers must be
# adjacent (grammar: "since yesterday", "before last week"); an exclusion word anywhere before the
# phrase forces "all time" because it names a complement no single window can hold.

_NEGATION_RE = re.compile(r"\b(?:not|except|excluding|other\s+than)\b")
_SINCE_RE = re.compile(r"\b(?:since|after)\s*$")
_BEFORE_RE = re.compile(r"\b(?:before|until)\s*$")


def _apply_qualifier(
    normalized: str, match: re.Match[str], anchor: TimeWindow, now: datetime
) -> TimeWindow:
    """Adjust ``anchor`` for a directional/negation qualifier preceding the matched phrase.

    Correctness-first: a qualifier we cannot faithfully represent (a negation/exclusion, or a
    directional word with no resolvable anchor start) degrades to "all time" rather than returning
    an inverted or shifted window. With no recognized qualifier, ``anchor`` is returned unchanged.
    """
    prefix = normalized[: match.start()]
    if _NEGATION_RE.search(prefix):
        return TimeWindow(start=None, end=None, label=ALL_TIME_EXCLUSION_LABEL)
    if anchor.start is None:
        # Nothing to anchor a directional window to (e.g. "since last 0 days"): stay unbounded.
        return anchor
    if (since := _SINCE_RE.search(prefix)) is not None:
        label = f"{since.group().strip()} {anchor.label}"
        return TimeWindow(start=anchor.start, end=now, label=label)
    if (before := _BEFORE_RE.search(prefix)) is not None:
        label = f"{before.group().strip()} {anchor.label}"
        return TimeWindow(start=None, end=anchor.start, label=label)
    return anchor


def _ensure_utc(dt: datetime) -> datetime:
    """Normalize any datetime to tz-aware UTC (naive is assumed already-UTC)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _start_of_day(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def _start_of_week(dt: datetime) -> datetime:
    """Midnight on the Monday of ``dt``'s week (weeks start Monday)."""
    return _start_of_day(dt) - timedelta(days=dt.weekday())


def _add_months(dt: datetime, months: int) -> datetime:
    """Shift ``dt`` by ``months`` (may be negative), clamping the day to the target month's
    length and clamping the whole result to the representable datetime range."""
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    if year < MINYEAR:
        return _DATETIME_MIN
    if year > MAXYEAR:
        return _DATETIME_MAX
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _safe_sub(dt: datetime, delta: timedelta) -> datetime:
    """``dt - delta``, clamped to the earliest representable instant on underflow."""
    try:
        return dt - delta
    except (OverflowError, ValueError):
        return _DATETIME_MIN


def _parse_number(token: str) -> int | None:
    """Parse a digit string or small English number word to a positive int, else ``None``."""
    if token.isdigit():
        return int(token)
    return _NUMBER_WORDS.get(token)


def _relative_past(now: datetime, n: int | None, unit: str, label: str) -> TimeWindow:
    """A rolling window from ``n`` ``unit``s before ``now`` up to ``now``.

    A non-positive or unparseable count is meaningless ("last 0 days") → "all time".
    """
    if n is None or n <= 0:
        return _all_time()
    if unit == "day":
        start = _safe_sub(now, timedelta(days=n))
    elif unit == "week":
        start = _safe_sub(now, timedelta(weeks=n))
    elif unit == "month":
        start = _add_months(now, -n)
    else:  # "year"
        start = _add_months(now, -12 * n)
    return _win(start, now, label)


def _month_window(now: datetime, month: int, label: str) -> TimeWindow:
    """The whole calendar month named by ``month`` — this year, or last year if that month is
    still in the future relative to ``now`` ("in June" asked in March means last June)."""
    year = now.year - 1 if month > now.month else now.year
    start = datetime(year, month, 1, tzinfo=UTC)
    return _win(start, _add_months(start, 1), label)


# --- per-phrase handlers ----------------------------------------------------------------------


def _h_today(now: datetime, _m: re.Match[str]) -> TimeWindow:
    start = _start_of_day(now)
    return _win(start, start + timedelta(days=1), "today")


def _h_yesterday(now: datetime, _m: re.Match[str]) -> TimeWindow:
    start = _start_of_day(now) - timedelta(days=1)
    return _win(start, start + timedelta(days=1), "yesterday")


def _h_before_yesterday(now: datetime, m: re.Match[str]) -> TimeWindow:
    """A single day "N days before yesterday" ("the day before yesterday" is the ``N=1`` case).

    "before yesterday" here shifts by whole days: N days before yesterday is ``now - (N+1) days``.
    Matched *before* the generic "before <phrase>" qualifier so it stays a day, not an
    unbounded-before window."""
    token = m.group(1)
    n = 1 if token is None else _parse_number(token)
    if n is None or n <= 0:
        return _all_time()
    start = _start_of_day(now) - timedelta(days=n + 1)
    return _win(start, start + timedelta(days=1), m.group(0).strip())


def _h_this_week(now: datetime, _m: re.Match[str]) -> TimeWindow:
    start = _start_of_week(now)
    return _win(start, start + timedelta(weeks=1), "this week")


def _h_last_week(now: datetime, _m: re.Match[str]) -> TimeWindow:
    this_week = _start_of_week(now)
    return _win(this_week - timedelta(weeks=1), this_week, "last week")


def _h_this_month(now: datetime, _m: re.Match[str]) -> TimeWindow:
    start = _start_of_day(now).replace(day=1)
    return _win(start, _add_months(start, 1), "this month")


def _h_last_month(now: datetime, _m: re.Match[str]) -> TimeWindow:
    this_month = _start_of_day(now).replace(day=1)
    return _win(_add_months(this_month, -1), this_month, "last month")


def _h_this_year(now: datetime, _m: re.Match[str]) -> TimeWindow:
    start = datetime(now.year, 1, 1, tzinfo=UTC)
    return _win(start, datetime(now.year + 1, 1, 1, tzinfo=UTC), "this year")


def _h_last_year(now: datetime, _m: re.Match[str]) -> TimeWindow:
    start = datetime(now.year - 1, 1, 1, tzinfo=UTC)
    return _win(start, datetime(now.year, 1, 1, tzinfo=UTC), "last year")


def _h_last_n(now: datetime, m: re.Match[str]) -> TimeWindow:
    return _relative_past(now, _parse_number(m.group(1)), m.group(2), m.group(0).strip())


def _h_ago(now: datetime, m: re.Match[str]) -> TimeWindow:
    return _relative_past(now, _FUZZY[m.group(1)], m.group(2), m.group(0).strip())


def _h_in_month(now: datetime, m: re.Match[str]) -> TimeWindow:
    return _month_window(now, _MONTH_INDEX[m.group(1)], m.group(0).strip())


def _h_recently(now: datetime, _m: re.Match[str]) -> TimeWindow:
    return _win(_safe_sub(now, timedelta(days=RECENT_DAYS)), now, "recently")


# --- rule table -------------------------------------------------------------------------------
# Ordered most-specific first. Every pattern is anchored on word boundaries and the canonical
# single-phrase inputs are mutually exclusive, so a well-formed query matches exactly one rule;
# resolve_window() treats 0 or 2+ matches as "no usable constraint".

_UNIT = r"(day|week|month|year)s?"
_NUM_ALT = "|".join(sorted(_NUMBER_WORDS, key=len, reverse=True))
_FUZZY_ALT = "|".join(sorted(_FUZZY, key=len, reverse=True))
_MONTH_ALT = "|".join(_MONTH_INDEX)

_RULES: list[tuple[re.Pattern[str], Callable[[datetime, re.Match[str]], TimeWindow]]] = [
    (re.compile(r"\btoday\b"), _h_today),
    (
        re.compile(rf"\b(?:the\s+day|(\d+|{_NUM_ALT})\s+days?)\s+before\s+yesterday\b"),
        _h_before_yesterday,
    ),
    (re.compile(r"\byesterday\b"), _h_yesterday),
    (re.compile(r"\bthis\s+week\b"), _h_this_week),
    (re.compile(r"\blast\s+week\b"), _h_last_week),
    (re.compile(r"\bthis\s+month\b"), _h_this_month),
    (re.compile(r"\blast\s+month\b"), _h_last_month),
    (re.compile(r"\bthis\s+year\b"), _h_this_year),
    (re.compile(r"\blast\s+year\b"), _h_last_year),
    (re.compile(rf"\blast\s+(\d+|{_NUM_ALT})\s+{_UNIT}\b"), _h_last_n),
    (re.compile(rf"\b(?:a\s+)?({_FUZZY_ALT})(?:\s+of)?\s+{_UNIT}\s+ago\b"), _h_ago),
    (re.compile(rf"\bin\s+({_MONTH_ALT})\b"), _h_in_month),
    (re.compile(r"\brecently\b"), _h_recently),
]

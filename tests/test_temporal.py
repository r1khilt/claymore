"""Unit tests for the temporal-expression resolver.

Every case is pinned against a fixed ``NOW`` so the exact ``(start, end)`` bounds are asserted,
not just "something reasonable" — temporal correctness is the whole value prop (CLAUDE.md §6,
ENGINEERING_GUIDELINES §3). ``NOW`` is Tuesday 2026-03-03 12:00 UTC.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from claymore.agent.temporal import ALL_TIME_LABEL, RECENT_DAYS, TimeWindow, resolve_window

NOW = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)  # a Tuesday


def w(text: str) -> TimeWindow:
    return resolve_window(text, now=NOW)


def d(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=UTC)


# --- calendar (boundary-snapped) phrases ---


def test_today() -> None:
    r = w("today")
    assert (r.start, r.end, r.label) == (d(2026, 3, 3), d(2026, 3, 4), "today")


def test_yesterday() -> None:
    r = w("what happened yesterday")
    assert (r.start, r.end) == (d(2026, 3, 2), d(2026, 3, 3))
    assert r.label == "yesterday"


def test_this_week_starts_monday() -> None:
    r = w("this week")
    assert (r.start, r.end) == (d(2026, 3, 2), d(2026, 3, 9))  # Mon..next Mon


def test_last_week() -> None:
    r = w("what came up last week")
    assert (r.start, r.end) == (d(2026, 2, 23), d(2026, 3, 2))


def test_this_month() -> None:
    r = w("this month")
    assert (r.start, r.end) == (d(2026, 3, 1), d(2026, 4, 1))


def test_last_month() -> None:
    r = w("last month")
    assert (r.start, r.end) == (d(2026, 2, 1), d(2026, 3, 1))


def test_this_year() -> None:
    r = w("this year")
    assert (r.start, r.end) == (d(2026, 1, 1), d(2027, 1, 1))


def test_last_year() -> None:
    r = w("last year")
    assert (r.start, r.end) == (d(2025, 1, 1), d(2026, 1, 1))


# --- rolling (measured back from now) phrases ---


def test_couple_months_ago() -> None:
    r = w("a couple months ago")
    assert r.start == datetime(2026, 1, 3, 12, 0, tzinfo=UTC)  # now - 2 months, time kept
    assert r.end == NOW
    assert r.label == "a couple months ago"


def test_few_weeks_ago() -> None:
    r = w("a few weeks ago")
    assert r.start == NOW - timedelta(weeks=3)
    assert r.end == NOW


def test_couple_of_months_ago_optional_of() -> None:
    r = w("couple of months ago")
    assert r.start == datetime(2026, 1, 3, 12, 0, tzinfo=UTC)


def test_last_n_days_digit() -> None:
    r = w("last 5 days")
    assert r.start == NOW - timedelta(days=5)
    assert r.end == NOW


def test_last_n_weeks_word() -> None:
    r = w("last two weeks")
    assert r.start == NOW - timedelta(weeks=2)
    assert r.end == NOW


def test_last_n_months_calendar_aware() -> None:
    r = w("last 3 months")
    assert r.start == datetime(2025, 12, 3, 12, 0, tzinfo=UTC)
    assert r.end == NOW


def test_last_n_years() -> None:
    r = w("last 2 years")
    assert r.start == datetime(2024, 3, 3, 12, 0, tzinfo=UTC)
    assert r.end == NOW


def test_recently_defaults_to_two_weeks() -> None:
    r = w("recently")
    assert r.start == NOW - timedelta(days=RECENT_DAYS)
    assert r.end == NOW


# --- "in <Month>" this-year-vs-last-year logic ---


def test_in_past_month_is_this_year() -> None:
    r = w("in january")
    assert (r.start, r.end) == (d(2026, 1, 1), d(2026, 2, 1))


def test_in_future_month_is_last_year() -> None:
    r = w("in june")  # June is after March -> last year
    assert (r.start, r.end) == (d(2025, 6, 1), d(2025, 7, 1))


def test_in_current_month_is_this_year() -> None:
    r = w("in march")  # equal to now.month, not future
    assert (r.start, r.end) == (d(2026, 3, 1), d(2026, 4, 1))


def test_in_december_wraps_end_into_next_january() -> None:
    r = w("in december")  # future -> last year
    assert (r.start, r.end) == (d(2025, 12, 1), d(2026, 1, 1))


# --- general behaviour ---


def test_case_insensitive() -> None:
    assert w("LAST WEEK").start == d(2026, 2, 23)


def test_phrase_embedded_in_question() -> None:
    r = w("what did Lucas suggest last week about the X protein?")
    assert r.label == "last week"
    assert r.start == d(2026, 2, 23)


def test_unrecognized_is_all_time() -> None:
    r = w("what is the latest on the docking pipeline")
    assert r.start is None
    assert r.end is None
    assert r.label == ALL_TIME_LABEL


def test_empty_is_all_time() -> None:
    r = w("")
    assert (r.start, r.end, r.label) == (None, None, ALL_TIME_LABEL)


def test_now_in_other_timezone_is_normalized_to_utc() -> None:
    # 02:00 at +05:00 is 21:00 the previous UTC day, so "today" (UTC) is 2026-03-02.
    east = timezone(timedelta(hours=5))
    r = resolve_window("today", now=datetime(2026, 3, 3, 2, 0, tzinfo=east))
    assert (r.start, r.end) == (d(2026, 3, 2), d(2026, 3, 3))


# --- TimeWindow model contract ---


def test_timewindow_is_frozen() -> None:
    r = w("today")
    with pytest.raises(ValidationError):
        r.start = None  # type: ignore[misc]


def test_timewindow_coerces_naive_bounds_to_utc() -> None:
    tw = TimeWindow(start=datetime(2026, 1, 1), end=None, label="x")  # naive input
    assert tw.start is not None
    assert tw.start.tzinfo is UTC


def test_all_time_window_has_no_bounds() -> None:
    tw = resolve_window("gibberish", now=NOW)
    assert tw.start is None and tw.end is None

"""Adversarial suite for the temporal resolver (CLAUDE.md §8: break it as it's built).

Query text is untrusted data. This suite hammers the resolver with empty/whitespace/garbage,
unicode, injection-shaped strings, huge input, contradictory phrases, degenerate counts, and a
naive clock. The invariant under test: **nothing raises**, and anything the resolver can't
confidently pin degrades to the unbounded "all time" window. A red test here is a real defect —
fix the root cause, never weaken the test.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from claymore.agent.temporal import ALL_TIME_LABEL, TimeWindow, resolve_window

NOW = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)


def w(text: str) -> TimeWindow:
    return resolve_window(text, now=NOW)


def assert_all_time(r: TimeWindow) -> None:
    assert r.start is None
    assert r.end is None
    assert r.label == ALL_TIME_LABEL


# --- empty / whitespace / garbage ---


def test_empty_string() -> None:
    assert_all_time(w(""))


def test_whitespace_only() -> None:
    assert_all_time(w("   \t\n  "))


def test_pure_garbage() -> None:
    assert_all_time(w("xyzzy qwop 42 !!!"))


# --- injection-shaped strings are inert data, never code ---


@pytest.mark.parametrize(
    "payload",
    [
        "'; DROP TABLE episodes; --",
        "{{now}}",
        "${now}",
        "__import__('os').system('rm -rf /')",
        "last week'); DROP GRAPH; --",  # a real phrase glued to an injection
    ],
)
def test_injection_shaped_input_never_executes_and_never_crashes(payload: str) -> None:
    r = w(payload)
    # Either it degrades to all-time, or it extracts the inert phrase — never evaluates anything.
    assert isinstance(r, TimeWindow)
    if r.label != ALL_TIME_LABEL:
        assert r.label == "last week"  # only the "last week" case carries a real phrase


# --- unicode ---


def test_emoji_and_control_chars() -> None:
    assert_all_time(w("\x00﻿🧬📅💥‮abc"))


def test_lookalike_cyrillic_does_not_match_last_week() -> None:
    # The first vowel is a Cyrillic lookalike, not ASCII, so it must NOT read as "last".
    assert_all_time(w("lаst week"))  # noqa: RUF001


# --- huge input ---


def test_huge_garbage_input_does_not_crash() -> None:
    r = w("z" * 100_000)
    assert_all_time(r)


def test_phrase_at_front_of_huge_input_still_resolves() -> None:
    r = w("today " + "z" * 100_000)
    assert r.label == "today"


# --- contradictory / ambiguous phrases -> all time (decline to guess) ---


@pytest.mark.parametrize(
    "text",
    [
        "today yesterday",
        "last week last month",
        "this week last year",
        "in january in june",
        "last 5 days and last 3 months",
    ],
)
def test_contradictory_phrases_resolve_to_all_time(text: str) -> None:
    assert_all_time(w(text))


# --- degenerate counts ---


def test_last_zero_days_is_all_time() -> None:
    assert_all_time(w("last 0 days"))


def test_last_zero_padded_is_all_time() -> None:
    assert_all_time(w("last 00 months"))


def test_absurdly_large_month_count_clamps_not_crashes() -> None:
    r = w("last 999999 months")
    assert r.end == NOW
    assert r.start is not None
    assert r.start.year == 1  # clamped to the earliest representable instant


def test_absurdly_large_day_count_clamps_not_crashes() -> None:
    r = w("last 999999 days")  # timedelta underflows datetime.min -> clamped, not raised
    assert r.end == NOW
    assert r.start is not None
    assert r.start.year == 1


def test_number_word_out_of_vocabulary_is_all_time() -> None:
    # "thirteen" is not in the small number-word table and isn't a digit.
    assert_all_time(w("last thirteen weeks"))


# --- naive clock handling ---


def test_naive_now_is_treated_as_utc() -> None:
    naive = datetime(2026, 3, 3, 12, 0)  # no tzinfo
    r = resolve_window("today", now=naive)
    assert r.start == datetime(2026, 3, 3, tzinfo=UTC)
    assert r.start is not None
    assert r.start.tzinfo is not None


# --- month-boundary edge cases (fuzz the clock, assert no crash + sane bounds) ---


@pytest.mark.parametrize("day", [1, 28, 29, 30, 31])
def test_month_end_reference_dates_never_crash(day: int) -> None:
    # e.g. "last month" evaluated on Jan 31 must not blow up on February's shorter length.
    for month in (1, 3, 12):
        try:
            now = datetime(2026, month, day, 12, 0, tzinfo=UTC)
        except ValueError:
            continue  # skip impossible calendar dates (e.g. Feb 30)
        r = resolve_window("last month", now=now)
        assert r.start is not None
        assert r.end is not None
        assert r.start < r.end


def test_never_raises_on_a_battery_of_hostile_inputs() -> None:
    hostile = [
        "",
        " ",
        "last",
        "last week",
        "in",
        "in smarch",
        "ago",
        "couple ago",
        "last -5 days",
        "last 1e9 months",
        "today" * 1000,
        "🧬" * 1000,
        "last 999999999999999999999999 months",
    ]
    for text in hostile:
        assert isinstance(resolve_window(text, now=NOW), TimeWindow)


def test_far_future_reference_now_does_not_crash() -> None:
    # A clock at datetime.max overflows when "today" adds a day; that must degrade to
    # all-time, not raise.
    r = resolve_window("today", now=datetime(9999, 12, 31, 12, 0, tzinfo=UTC))
    assert_all_time(r)

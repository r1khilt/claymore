"""GitHub commit-ingest slice — the chosen GitHub signal for lab memory (issues/PRs come later).

Exercises the commit → :class:`Episode` mapping, ACL → visibility (R13), private-repo owner
injection, identity resolution (R11), ``since`` filtering, and multi-page streaming — all through
:class:`FakeConnectorHub`, whose GitHub path runs the SAME :func:`github_episode` (parse + since +
owner-injection + identity) the live 2-level backfill uses. Green here means green for the real
hub's per-commit handling (only the repo-enumeration round-trips differ, which the fake skips).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from claymore.domain import UNKNOWN_AUTHOR, SourcePlatform
from claymore.ingest.composio.hub import FakeConnectorHub
from claymore.memory.identity import RAW_AUTHOR_KEY, IdentityResolver
from tests.fixtures import LAB, ROSTER


def _commit(
    sha: str,
    *,
    full_name: str = "lab/pipeline",
    private: bool = False,
    login: str | None = "lucas-dev",
    email: str = "lucas@lab.org",
    message: str = "docking pipeline: latest run green",
    date: str = "2026-03-03T12:00:00Z",
) -> dict[str, Any]:
    """An already-associated GitHub commit dict in the live ``GITHUB_LIST_COMMITS`` shape, plus
    the ``full_name``/``private`` the fake carries in place of a repo-enumeration round-trip."""
    return {
        "full_name": full_name,
        "private": private,
        "sha": sha,
        "html_url": f"https://github.com/{full_name}/commit/{sha}",
        "author": {"login": login} if login is not None else None,  # GitHub user object (nullable)
        "commit": {
            "author": {"name": "Lucas", "email": email, "date": date},  # git metadata (always)
            "message": message,
        },
    }


async def _collect(hub: FakeConnectorHub, **kw: Any) -> list[Any]:
    return [ep async for ep in hub.backfill(LAB, SourcePlatform.GITHUB, **kw)]


# --- public-repo commit → full provenance + lab-wide visibility ---


async def test_public_commit_maps_all_fields() -> None:
    hub = FakeConnectorHub({SourcePlatform.GITHUB: [_commit("abc123")]})
    [ep] = await _collect(hub)
    assert ep.lab_id == LAB
    assert ep.source_platform is SourcePlatform.GITHUB
    assert ep.source_id == "lab/pipeline@abc123"  # full_name@sha, stable + unique per commit
    assert ep.text == "docking pipeline: latest run green"  # text is the commit message
    assert ep.timestamp == datetime(2026, 3, 3, 12, 0, tzinfo=UTC)  # commit.author.date parsed
    # Author is NOT guessed at parse time — the raw login is stashed for the identity step.
    assert ep.author == UNKNOWN_AUTHOR
    assert ep.extra[RAW_AUTHOR_KEY] == "lucas-dev"  # author.login preferred
    assert ep.extra["repo"] == "lab/pipeline"
    assert ep.extra["sha"] == "abc123"
    assert ep.extra["private"] == "false"
    assert ep.is_untrusted is True
    assert ep.refs == ("lab/pipeline", "abc123", "https://github.com/lab/pipeline/commit/abc123")
    # A lab's public repo is lab-wide memory.
    assert ep.visibility.lab_wide is True
    assert ep.visibility.source_label == "lab/pipeline"


# --- identity resolution (R11): known login → canonical person only when a resolver is given ---


async def test_resolver_maps_known_login_to_person() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    hub = FakeConnectorHub({SourcePlatform.GITHUB: [_commit("abc123")]}, resolver=resolver)
    [ep] = await _collect(hub)
    assert ep.author == "p_lucas"  # "lucas-dev" → github login on the roster → p_lucas


async def test_unknown_login_stays_unknown_with_resolver() -> None:
    resolver = IdentityResolver(LAB, ROSTER)
    hub = FakeConnectorHub(
        {SourcePlatform.GITHUB: [_commit("abc123", login="stranger-99")]}, resolver=resolver
    )
    [ep] = await _collect(hub)
    assert ep.author == UNKNOWN_AUTHOR  # not on the roster → never guessed
    assert ep.extra[RAW_AUTHOR_KEY] == "stranger-99"  # raw handle kept for a later merge attempt


# --- private-repo visibility (R13) + owner injection ---


async def test_private_commit_restricted_but_owner_can_view() -> None:
    # The hub knows the connecting lab user (user_id); its commits (private repo) inject that owner.
    hub = FakeConnectorHub(
        {SourcePlatform.GITHUB: [_commit("s1", full_name="lab/secret", private=True)]},
        user_id="u_lucas",
    )
    [ep] = await _collect(hub)
    assert ep.visibility.lab_wide is False  # a private repo is never lab-wide
    assert ep.extra["private"] == "true"
    assert ep.visibility.source_label == "lab/secret"
    # The connecting owner (who demonstrably has repo access) may view their own private commit...
    assert ep.visibility.allowed_user_ids == frozenset({"u_lucas"})
    assert ep.visibility.can_view("u_lucas") is True
    # ...but a random lab member cannot.
    assert ep.visibility.can_view("u_philip") is False


# --- since filtering (inclusive lower bound) ---


async def test_since_filters_older_commits_inclusive() -> None:
    commits = [
        _commit("s1", date="2026-03-01T00:00:00Z"),
        _commit("s2", date="2026-03-02T00:00:00Z"),
        _commit("s3", date="2026-03-03T00:00:00Z"),
    ]
    hub = FakeConnectorHub({SourcePlatform.GITHUB: commits})
    cutoff = datetime(2026, 3, 2, tzinfo=UTC)  # exactly the middle commit's time
    eps = await _collect(hub, since=cutoff)
    # Older commit dropped; the boundary commit is kept (inclusive lower bound).
    assert [ep.source_id for ep in eps] == ["lab/pipeline@s2", "lab/pipeline@s3"]


# --- multi-page streaming: every commit across simulated pages is yielded ---


async def test_all_commits_across_pages_yield() -> None:
    commits = [_commit(f"s{i}", date=f"2026-03-0{i}T00:00:00Z") for i in range(1, 4)]
    hub = FakeConnectorHub({SourcePlatform.GITHUB: commits}, page_size=1)  # one commit per page
    eps = await _collect(hub)
    assert {ep.source_id for ep in eps} == {
        "lab/pipeline@s1",
        "lab/pipeline@s2",
        "lab/pipeline@s3",
    }


async def test_commits_from_multiple_repos_all_yield() -> None:
    commits = [
        _commit("a1", full_name="lab/repo-a"),
        _commit("b1", full_name="lab/repo-b"),
    ]
    hub = FakeConnectorHub({SourcePlatform.GITHUB: commits})
    eps = await _collect(hub)
    assert {ep.source_id for ep in eps} == {"lab/repo-a@a1", "lab/repo-b@b1"}

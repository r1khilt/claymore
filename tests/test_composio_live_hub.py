"""Current Composio direct-execution contract: pins, filters, envelopes, and enrichment."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from claymore.domain import SourcePlatform
from claymore.ingest.composio.hub import ComposioConnectorHub, ComposioExecutionError
from claymore.ingest.composio.sources import (
    GITHUB_COMMITS_SLUG,
    GITHUB_REPOS_SLUG,
    NOTION_BLOCKS_SLUG,
    SLACK_CHANNELS_SLUG,
    SLACK_HISTORY_SLUG,
    SLACK_THREAD_SLUG,
)
from tests.fixtures import LAB, make_settings

SINCE = datetime(2026, 7, 1, tzinfo=UTC)


class FakeTools:
    def __init__(self, responses: dict[str, list[Any]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def execute(self, slug: str, **kwargs: Any) -> Any:
        self.calls.append((slug, kwargs))
        values = self.responses[slug]
        if not values:
            raise AssertionError(f"unexpected extra call to {slug}")
        value = values.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


def ok(data: dict[str, Any]) -> dict[str, Any]:
    return {"successful": True, "error": None, "data": data}


def hub(tmp_path: Path, tools: FakeTools, *, owner: str = "web-user") -> ComposioConnectorHub:
    service = ComposioConnectorHub(
        make_settings(composio_api_key="cmp_test", composio_cache_dir=str(tmp_path / "cache")),
        user_id="composio-user",
        connected_account_id="ca_1",
        owner_user_id=owner,
        page_size=50,
    )
    service._client_obj = SimpleNamespace(tools=tools)
    return service


async def collect(
    service: ComposioConnectorHub, source: SourcePlatform, since: datetime | None = SINCE
) -> list[Any]:
    return [episode async for episode in service.backfill(LAB, source, since)]


async def test_gmail_uses_full_payload_query_and_provider_specific_pin(tmp_path: Path) -> None:
    tools = FakeTools({"GMAIL_FETCH_EMAILS": [ok({"messages": []})]})
    assert await collect(hub(tmp_path, tools), SourcePlatform.GMAIL) == []
    slug, call = tools.calls[0]
    assert slug == "GMAIL_FETCH_EMAILS"
    assert call["version"] == "20260702_01"
    assert call["user_id"] == "composio-user"
    assert call["connected_account_id"] == "ca_1"
    assert call["arguments"]["include_payload"] is True
    assert call["arguments"]["query"] == "after:2026/07/01"
    assert "dangerously_skip_version_check" not in call


async def test_github_passes_since_to_each_repo_commit_call(tmp_path: Path) -> None:
    commit = {
        "sha": "abc",
        "html_url": "https://github.com/lab/repo/commit/abc",
        "author": {"login": "lucas"},
        "commit": {
            "message": "Add assay",
            "author": {"date": "2026-07-03T12:00:00Z", "email": "l@lab.org"},
        },
    }
    tools = FakeTools(
        {
            GITHUB_REPOS_SLUG: [
                ok({"repositories": [{"full_name": "lab/repo", "private": True}]}),
                ok({"repositories": []}),
            ],
            GITHUB_COMMITS_SLUG: [ok({"commits": [commit]}), ok({"commits": []})],
        }
    )
    [episode] = await collect(hub(tmp_path, tools), SourcePlatform.GITHUB)
    assert episode.text == "Add assay"
    assert episode.visibility.allowed_user_ids == frozenset({"web-user"})
    commit_calls = [call for slug, call in tools.calls if slug == GITHUB_COMMITS_SLUG]
    assert commit_calls[0]["arguments"]["since"] == "2026-07-01T00:00:00Z"
    assert all(call["version"] == "20260702_00" for call in commit_calls)


async def test_github_skips_repo_whose_commit_read_fails(tmp_path: Path) -> None:
    """One unreadable repo (e.g. GitHub 409 "Git Repository is empty") never aborts the backfill."""
    commit = {
        "sha": "abc",
        "html_url": "https://github.com/lab/repo2/commit/abc",
        "author": {"login": "lucas"},
        "commit": {
            "message": "Add assay",
            "author": {"date": "2026-07-03T12:00:00Z", "email": "l@lab.org"},
        },
    }
    tools = FakeTools(
        {
            GITHUB_REPOS_SLUG: [
                ok(
                    {
                        "repositories": [
                            {"full_name": "lab/empty-repo", "private": False},
                            {"full_name": "lab/repo2", "private": False},
                        ]
                    }
                ),
                ok({"repositories": []}),
            ],
            GITHUB_COMMITS_SLUG: [
                {"successful": False, "error": "Git Repository is empty.", "data": {}},
                ok({"commits": [commit]}),
                ok({"commits": []}),
            ],
        }
    )
    [episode] = await collect(hub(tmp_path, tools), SourcePlatform.GITHUB)
    assert episode.text == "Add assay"


async def test_slack_imports_thread_replies_with_oldest_filter_and_slack_pin(
    tmp_path: Path,
) -> None:
    parent = {
        "ts": "1782921600.000100",
        "user": "U1",
        "text": "Parent",
        "reply_count": 1,
    }
    reply = {
        "ts": "1782921700.000200",
        "thread_ts": parent["ts"],
        "user": "U2",
        "text": "Reply",
    }
    tools = FakeTools(
        {
            SLACK_CHANNELS_SLUG: [
                ok(
                    {
                        "channels": [{"id": "C1", "name": "science", "is_private": False}],
                        "response_metadata": {"next_cursor": ""},
                    }
                )
            ],
            SLACK_HISTORY_SLUG: [
                ok({"messages": [parent], "response_metadata": {"next_cursor": ""}})
            ],
            SLACK_THREAD_SLUG: [
                ok(
                    {
                        "messages": [parent, reply],
                        "response_metadata": {"next_cursor": ""},
                    }
                )
            ],
        }
    )
    episodes = await collect(hub(tmp_path, tools), SourcePlatform.SLACK)
    assert [episode.text for episode in episodes] == ["Parent", "Reply"]
    history = next(call for slug, call in tools.calls if slug == SLACK_HISTORY_SLUG)
    assert history["arguments"]["oldest"] == int(SINCE.timestamp())
    assert history["arguments"]["inclusive"] is True
    assert all(call["version"] == "20260512_00" for _, call in tools.calls)


async def test_notion_enriches_recent_page_with_actual_block_content(tmp_path: Path) -> None:
    page = {
        "object": "page",
        "id": "page-1",
        "last_edited_time": "2026-07-03T12:00:00Z",
        "created_by": {"id": "notion-user"},
        "properties": {"Name": {"type": "title", "title": [{"plain_text": "Assay notes"}]}},
    }
    tools = FakeTools(
        {
            "NOTION_FETCH_DATA": [ok({"results": [page], "next_cursor": None})],
            NOTION_BLOCKS_SLUG: [
                ok(
                    {
                        "results": [
                            {
                                "type": "paragraph",
                                "paragraph": {"rich_text": [{"plain_text": "Use 50mM Tris"}]},
                            }
                        ]
                    }
                )
            ],
        }
    )
    [episode] = await collect(hub(tmp_path, tools), SourcePlatform.NOTION)
    assert episode.text == "Assay notes\n\nUse 50mM Tris"
    assert episode.visibility.allowed_user_ids == frozenset({"web-user"})
    assert [slug for slug, _ in tools.calls] == ["NOTION_FETCH_DATA", NOTION_BLOCKS_SLUG]
    assert all(call["version"] == "20260702_00" for _, call in tools.calls)


async def test_unsuccessful_envelope_surfaces_as_sync_failure(tmp_path: Path) -> None:
    tools = FakeTools(
        {"GMAIL_FETCH_EMAILS": [{"successful": False, "error": "invalid credentials", "data": {}}]}
    )
    with pytest.raises(ComposioExecutionError):
        await collect(hub(tmp_path, tools), SourcePlatform.GMAIL)

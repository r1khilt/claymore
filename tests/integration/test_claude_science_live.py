"""Live integration test — the Claude Science driver against the real local daemon.

Guarded like the other live tests: skips unless CLAYMORE_RUN_LIVE=1 *and* a Claude Science daemon is
actually reachable on the configured loopback URL. Proves the headless HTTP drive works end to end:
sign in via a one-time nonce, create a run, poll the frame to completion, and return a grounded
result labelled ``completed`` (never a preview).

    claude-science serve                       # start the daemon in another terminal
    CLAYMORE_RUN_LIVE=1 .venv/bin/pytest tests/integration/test_claude_science_live.py -v -s
"""

from __future__ import annotations

import os

import pytest

from claymore.config import get_settings
from claymore.execute import claude_science
from claymore.execute.claude_science import ScienceSession, ScienceStep, run_science_session

pytestmark = pytest.mark.integration


@pytest.mark.skipif(
    os.getenv("CLAYMORE_RUN_LIVE") != "1",
    reason="live test — set CLAYMORE_RUN_LIVE=1 with a running Claude Science daemon to run",
)
async def test_drives_real_daemon_end_to_end() -> None:
    settings = get_settings()
    url = settings.claude_science_url.rstrip("/")
    if not claude_science._is_loopback(url):
        pytest.skip(f"claude_science_url {url} is not loopback")
    if not await claude_science._healthy(url):
        pytest.skip(f"no Claude Science daemon reachable at {url}")

    # Keep the live run cheap and unambiguous.
    object.__setattr__(settings, "claude_science_effort", "low")
    token = "claymore-live-ok"

    steps: list[ScienceStep] = []
    session: ScienceSession | None = None
    async for item in run_science_session(f"Reply with exactly: {token}", settings, step_delay=0):
        if isinstance(item, ScienceSession):
            session = item
        else:
            steps.append(item)

    assert session is not None
    assert session.status == "completed", (
        f"expected a real run, got {session.status}: {session.note}"
    )
    assert token in session.result_summary
    assert steps  # streamed at least the connect/submit steps
    assert session.metrics  # real run stats (model, tokens, cost)

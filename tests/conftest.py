"""Session-wide hermeticity for the unit suite (skipped when ``CLAYMORE_RUN_LIVE=1``).

Two leaks make unit tests read the developer's real ``.env`` unless blocked here:

1. ``get_settings()`` loads ``.env`` from the CWD — so any code path that touches settings
   (e.g. the FastAPI lifespan run by ``TestClient(app)``) would configure REAL keys, install
   the real Graphiti/Anthropic runtime, and make "unit" tests depend on live services.
2. ``graphiti_core`` calls ``load_dotenv()`` at import time, dumping the whole ``.env`` into
   ``os.environ`` mid-run — from where ``Settings`` (which always reads the process env) would
   absorb it, making tests order-dependent on whichever test imported graphiti first.

Fix: trigger the graphiti pollution deterministically up front, scrub every ``.env`` key from
the process env, disable the ``.env`` file source on ``Settings``, and pin the cached
``get_settings()`` to pure defaults. Individual tests build their exact config with
``tests.fixtures.make_settings``. Live integration tests (``CLAYMORE_RUN_LIVE=1``) need the
real environment, so the fixture is a no-op there.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest


@pytest.fixture(scope="session", autouse=True)
def _hermetic_env() -> Iterator[None]:
    if os.environ.get("CLAYMORE_RUN_LIVE") == "1":
        yield
        return

    try:  # force graphiti's import-time load_dotenv() NOW, so the scrub below is final
        import graphiti_core  # noqa: F401
    except ImportError:
        pass

    try:
        from dotenv import dotenv_values

        for key in dotenv_values(".env"):
            os.environ.pop(key, None)
    except ImportError:  # no python-dotenv ⇒ nothing loaded .env into the env either
        pass

    from claymore import config

    config.Settings.model_config["env_file"] = None
    config.get_settings.cache_clear()
    config.get_settings()  # pin the cached instance to pure defaults
    yield

"""Local, single-user, on-disk store for the web dashboard (chats, settings, profile, metrics).

This is intentionally **not** the Postgres app-state store (CLAUDE.md §3). It is a small JSON
document in the *user's own folder* — ``~/.claymore/local.json`` by default, overridable with the
``CLAYMORE_LOCAL_DIR`` env var — that backs the web UI's "keep it local" surfaces:

* **Recent chats** — the Composer persists each conversation here so the sidebar's Recent list and
  restore-on-click actually work across refreshes.
* **Settings & profile** — display name / lab / avatar, the Anthropic + Voyage keys the live
  Composer uses, the reasoning level, and a debug flag.
* **Metrics** — real token usage, tool-call counts, run/error tallies recorded by the agent loop.
* **Error log** — a rolling tail of agent/client errors for the Settings → Debug panel.

It is deliberately outside git (the default lives in ``$HOME``; the repo ``.gitignore`` also covers
the ``.claymore-local/`` fallback and ``*.local.json``), so a user's keys and chat history never get
pushed. There is no schema migration story and no multi-tenant scoping here — it is a local dev/demo
convenience, single user, single machine. Do not put another lab's IP through it.

Writes are atomic (temp file + ``os.replace``) and guarded by a process lock so concurrent requests
never tear the file. The document is small; sync IO from the async routes is fine at this scale.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from claymore.logging import get_logger

_log = get_logger("local_store")

_SCHEMA_VERSION = 1
_MAX_ERRORS = 200  # rolling tail kept in the debug log
_MAX_CHATS = 200  # cap history so the file stays small

# Reasoning level -> (max tool-loop iterations, max output tokens per turn). These mirror the
# defaults in agent_loop.py (medium) and give the setting a real, bounded effect on a live run.
_REASONING: dict[str, tuple[int, int]] = {
    "low": (3, 1024),
    "medium": (6, 2048),
    "high": (8, 3072),
}

_lock = threading.Lock()


def local_dir() -> Path:
    """The directory holding the local document (``$CLAYMORE_LOCAL_DIR`` or ``~/.claymore``)."""
    raw = os.environ.get("CLAYMORE_LOCAL_DIR")
    return Path(raw).expanduser() if raw else Path.home() / ".claymore"


def local_path() -> Path:
    """Absolute path to the JSON document."""
    return local_dir() / "local.json"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _default_doc() -> dict[str, Any]:
    return {
        "version": _SCHEMA_VERSION,
        "profile": {
            "name": "Rikhil T",
            "lab": "Claymore Lab",
            "email": "",
            "avatarColor": "#3f7d5c",
            "avatarDataUrl": None,
        },
        "settings": {
            "anthropicApiKey": "",
            "voyageApiKey": "",
            "reasoningLevel": "medium",
            "debug": False,
            "liveMode": False,
        },
        "chats": [],
        "metrics": _default_metrics(),
        "errorLog": [],
    }


def _default_metrics() -> dict[str, Any]:
    return {
        "totalRuns": 0,
        "totalErrors": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "toolCalls": 0,
        "toolCounts": {},
        "models": {},
        "byDay": {},
        "lastRunAt": None,
    }


def _merge_defaults(doc: dict[str, Any]) -> dict[str, Any]:
    """Fill any missing top-level/nested keys from the defaults (forward-compatible reads)."""
    base = _default_doc()
    for key, default in base.items():
        if key not in doc:
            doc[key] = default
        elif isinstance(default, dict) and isinstance(doc[key], dict):
            for sub, sub_default in default.items():
                doc[key].setdefault(sub, sub_default)
    return doc


def _read() -> dict[str, Any]:
    path = local_path()
    if not path.exists():
        return _default_doc()
    try:
        with path.open("r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if not isinstance(doc, dict):
            raise ValueError("local store is not a JSON object")
        return _merge_defaults(doc)
    except (json.JSONDecodeError, ValueError, OSError) as exc:
        # A corrupt/partial file must never take the app down — start clean and note it.
        _log.warning("local_store.read_failed", error=str(exc))
        return _default_doc()


def _write(doc: dict[str, Any]) -> None:
    directory = local_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # Atomic replace: write a sibling temp file, fsync, then rename over the target.
    fd, tmp = tempfile.mkstemp(dir=str(directory), prefix=".local.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, str(local_path()))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _mutate(fn: Any) -> dict[str, Any]:
    """Read-modify-write under the lock; ``fn(doc)`` mutates in place and returns nothing."""
    with _lock:
        doc = _read()
        fn(doc)
        _write(doc)
        return doc


# --- reads --------------------------------------------------------------------------------------


def get_state() -> dict[str, Any]:
    """The whole document (profile, settings, metrics, errorLog, and chat summaries).

    Chats are returned as lightweight summaries (no ``turns``) so the sidebar/list stay cheap;
    fetch a single chat with :func:`get_chat` to restore its full turns.
    """
    with _lock:
        doc = _read()
    doc = dict(doc)
    doc["chats"] = [_chat_summary(c) for c in doc.get("chats", [])]
    return doc


def _chat_summary(chat: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": chat.get("id", ""),
        "title": chat.get("title", "Untitled"),
        "createdAt": chat.get("createdAt"),
        "updatedAt": chat.get("updatedAt"),
        "turnCount": len(chat.get("turns", [])),
    }


def list_chats() -> list[dict[str, Any]]:
    """Chat summaries, most-recently-updated first."""
    with _lock:
        chats = _read().get("chats", [])
    summaries = [_chat_summary(c) for c in chats]
    summaries.sort(key=lambda c: c.get("updatedAt") or "", reverse=True)
    return summaries


def get_chat(chat_id: str) -> dict[str, Any] | None:
    """One full chat (with ``turns``) by id, or ``None``."""
    with _lock:
        for chat in _read().get("chats", []):
            if chat.get("id") == chat_id:
                return cast(dict[str, Any], chat)
    return None


def get_settings_doc() -> dict[str, Any]:
    with _lock:
        return cast(dict[str, Any], _read()["settings"])


# --- writes -------------------------------------------------------------------------------------


def update_profile(patch: dict[str, Any]) -> dict[str, Any]:
    allowed = {"name", "lab", "email", "avatarColor", "avatarDataUrl"}

    def apply(doc: dict[str, Any]) -> None:
        for key, value in patch.items():
            if key in allowed:
                doc["profile"][key] = value

    return cast(dict[str, Any], _mutate(apply)["profile"])


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    allowed = {"anthropicApiKey", "voyageApiKey", "reasoningLevel", "debug", "liveMode"}

    def apply(doc: dict[str, Any]) -> None:
        for key, value in patch.items():
            if key not in allowed:
                continue
            if key == "reasoningLevel" and value not in _REASONING:
                continue
            doc["settings"][key] = value

    return cast(dict[str, Any], _mutate(apply)["settings"])


def upsert_chat(chat: dict[str, Any]) -> dict[str, Any]:
    """Insert or replace a chat by ``id``. Missing ids/timestamps are filled in."""
    chat_id = str(chat.get("id") or "").strip()
    if not chat_id:
        raise ValueError("chat.id is required")
    now = _now()
    turns = chat.get("turns", [])
    title = str(chat.get("title") or "").strip() or _title_from_turns(turns)

    def apply(doc: dict[str, Any]) -> None:
        chats: list[dict[str, Any]] = doc["chats"]
        existing = next((c for c in chats if c.get("id") == chat_id), None)
        record = {
            "id": chat_id,
            "title": title,
            "createdAt": (existing or chat).get("createdAt") or now,
            "updatedAt": now,
            "turns": turns,
        }
        if existing is not None:
            chats[chats.index(existing)] = record
        else:
            chats.append(record)
        # Keep only the most-recent _MAX_CHATS by updatedAt.
        chats.sort(key=lambda c: c.get("updatedAt") or "", reverse=True)
        del chats[_MAX_CHATS:]

    _mutate(apply)
    return get_chat(chat_id) or {}


def _title_from_turns(turns: list[dict[str, Any]]) -> str:
    for turn in turns:
        q = str(turn.get("q") or "").strip()
        if q:
            return q[:80]
    return "New chat"


def delete_chat(chat_id: str) -> None:
    def apply(doc: dict[str, Any]) -> None:
        doc["chats"] = [c for c in doc["chats"] if c.get("id") != chat_id]

    _mutate(apply)


def clear_chats() -> None:
    _mutate(lambda doc: doc.__setitem__("chats", []))


# --- metrics & errors ---------------------------------------------------------------------------


def record_run(
    *,
    input_tokens: int,
    output_tokens: int,
    tool_calls: int,
    tool_counts: dict[str, int] | None = None,
    model: str = "",
) -> None:
    """Fold one completed agent run into the cumulative metrics (called by the SSE route)."""
    day = _now()[:10]
    counts = tool_counts or {}

    def apply(doc: dict[str, Any]) -> None:
        m = doc["metrics"]
        m["totalRuns"] += 1
        m["inputTokens"] += max(0, input_tokens)
        m["outputTokens"] += max(0, output_tokens)
        m["toolCalls"] += max(0, tool_calls)
        m["lastRunAt"] = _now()
        for name, n in counts.items():
            m["toolCounts"][name] = m["toolCounts"].get(name, 0) + n
        if model:
            m["models"][model] = m["models"].get(model, 0) + 1
        bucket = m["byDay"].setdefault(
            day, {"runs": 0, "inputTokens": 0, "outputTokens": 0, "toolCalls": 0}
        )
        bucket["runs"] += 1
        bucket["inputTokens"] += max(0, input_tokens)
        bucket["outputTokens"] += max(0, output_tokens)
        bucket["toolCalls"] += max(0, tool_calls)

    _mutate(apply)


def record_error(message: str, *, level: str = "error", context: str = "") -> None:
    """Append an entry to the rolling error log (capped at ``_MAX_ERRORS``)."""
    entry = {
        "id": os.urandom(6).hex(),
        "ts": _now(),
        "level": level,
        "message": message[:1000],
        "context": context[:200],
    }

    def apply(doc: dict[str, Any]) -> None:
        doc["metrics"]["totalErrors"] += 1
        log: list[dict[str, Any]] = doc["errorLog"]
        log.append(entry)
        del log[:-_MAX_ERRORS]

    _mutate(apply)


def clear_errors() -> None:
    _mutate(lambda doc: doc.__setitem__("errorLog", []))


def reset_metrics() -> None:
    _mutate(lambda doc: doc.__setitem__("metrics", _default_metrics()))


# --- effective config the live agent path reads -------------------------------------------------


def reasoning_budget(level: str | None = None) -> tuple[int, int]:
    """``(max_iterations, max_tokens)`` for the given/stored reasoning level (default: medium)."""
    if level is None:
        level = str(get_settings_doc().get("reasoningLevel", "medium"))
    return _REASONING.get(level, _REASONING["medium"])


def stored_anthropic_key() -> str:
    """The Anthropic key saved in Settings (empty string if unset). Never logged."""
    return str(get_settings_doc().get("anthropicApiKey", "")).strip()

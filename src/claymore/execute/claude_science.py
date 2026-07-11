"""[Bio, Phase 3] Drive Anthropic's **Claude Science** workbench via its local HTTP API.

Claude Science ships as a supervised app with **no headless SDK**, but its daemon (default
``http://localhost:8765``) exposes an authenticated HTTP API: create a run inside a project, then
poll the resulting **frame** for status + result. Claymore drives it over that API — no browser and
no computer-use vision loop. This is faster, deterministic, and needs no display.

**Containment — "the agent never escapes the local host" (CLAUDE.md rule 7 + standing constraint).**
The client is HARD-PINNED to a loopback origin: a non-loopback ``claude_science_url`` is refused
outright, and a request event-hook re-checks *every* request (including redirects) and aborts any
that would leave loopback. So Claymore's blast radius is exactly one local daemon — it cannot reach
another host. Claude Science runs its own science agents (which may execute code) inside **its own**
sandbox; that is CS's concern, out of scope here — Claymore only submits a task and reads results.

**Auth.** The daemon logs a browser tab in with a one-time nonce (``claude-science url``). Claymore
mints one via the CLI, exchanges it for a session cookie, and reuses that cookie for the run.
State-changing POSTs also carry the daemon's ``Origin`` + ``x-operon-csrf`` anti-CSRF headers.

**Two modes, chosen automatically, behind one async generator** (:func:`run_science_session`):

* **live** — daemon reachable on loopback *and* sign-in succeeds: a real run; Claymore streams each
  status change as a :class:`ScienceStep` and returns the grounded result.
* **preview** — daemon down / non-loopback / sign-in fails: the deterministic simulated fallback,
  clearly labelled so a preview is never dressed up as a real result (CLAUDE.md hard rule 1).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import ipaddress
import json
import math
import os
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from claymore.config import Settings
from claymore.logging import get_logger

_log = get_logger("execute.claude_science")

# Paces the simulated stream so the chat panel animates like a live run (overridable in tests).
_STEP_DELAY = 0.5
_HEALTH_TIMEOUT = 2.0
# Fallbacks if the (settings-driven) knobs are ever unset.
_POLL_INTERVAL = 2.0
_RUN_TIMEOUT = 900.0
# The coordinating ("generalist") agent Claude Science dispatches a fresh task to.
_ROOT_AGENT = "OPERON"
_DEFAULT_CLI = "~/.claude-science/bin/claude-science"
# Frame lifecycle: terminal-good vs terminal-bad; anything else means "still running, keep polling".
_TERMINAL_OK = {"completed"}
_TERMINAL_BAD = {"error", "failed", "cancelled", "canceled", "aborted"}

# Real-figure extraction (live path only). We don't know Claude Science's exact frame schema for
# artifacts, so extraction is *shape*-based (detect image-shaped values wherever they sit) rather
# than keyed to one guessed field — robust to schema drift, and it surfaces nothing when the frame
# genuinely has no images (no fabrication). Bounds keep a hostile/huge frame from exhausting memory.
_ALLOWED_IMAGE_MEDIA = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "image/bmp",
    "image/avif",
}
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif")
# Keys whose string value we treat as a possible image reference (a data: URL or an image file).
_IMAGE_REF_KEYS = (
    "image",
    "image_url",
    "screenshot",
    "thumbnail",
    "preview",
    "url",
    "uri",
    "src",
    "href",
    "path",
    "file_path",
    "download_url",
)
_MAX_FIGURES = 12  # cap the gallery; a run rarely produces more real figures than this
_MAX_FILES = 12  # cap the non-image download list
_MAX_FIGURE_BYTES = 4_000_000  # ~4 MB decoded per figure — skip anything larger
_MAX_FILE_BYTES = 2_000_000  # inline a non-image artifact as a download up to ~2 MB; else name-only
_MAX_LIST_BYTES = 8_000_000  # cap the artifacts-list response body (metadata is small; bound it)
_MAX_ARTIFACT_RECORDS = 500  # process at most this many artifact records per frame
_WALK_MAX_DEPTH = 14  # frames nest (output_data → messages → content → source); bound recursion
_WALK_MAX_NODES = 40_000  # hard ceiling on nodes visited so a pathological frame can't hang us
_MAX_CHILD_FRAMES = 8  # sub-agent frames we'll fetch to find figures they produced

# Real Claude Science artifact API (verified against the live daemon): every figure/dataset a run
# saves is a downloadable artifact. List a frame's artifacts, then GET the bytes by id. This is the
# authoritative source of a run's visual output — figures live here, NOT inline in the frame JSON.
_FRAME_ARTIFACTS_EP = "/api/frames/{frame_id}/artifacts"
_ARTIFACT_EP = "/api/artifacts/{artifact_id}"
# The daemon's persistent user allowlist (verified against the live app). A network request to a
# host that isn't on this list (nor the daemon's built-in pkg/git allowlist) is blocked; a single
# per-call approval is refused ("approve with the 'Always' scope"). Claymore adds an our-allowlisted
# host here so the run can fetch it. The daemon keeps a ``deniedDomains`` blocklist as a backstop.
_ALLOWED_DOMAINS_EP = "/api/preferences/allowed-domains"


class _ScienceUnavailable(Exception):
    """The local daemon is reachable but we couldn't sign in / start / read a run — degrade to a
    labelled preview rather than raise into the caller."""


class ScienceMetric(BaseModel):
    """One labelled figure in the session result (e.g. ``cost -> $0.42``)."""

    label: str
    value: str


class ScienceStep(BaseModel):
    """One observed step of Claude Science working — an action + a rendered frame of the result.

    ``screenshot`` is a self-contained ``data:`` URL so the web client can render it with no extra
    fetch or asset host. In a **live** run it is a *real* figure Claude Science produced at that
    step (or ``None`` when the step had no visual output — we never draw a fake window over a real
    run); in the **simulated** preview it is an inline SVG frame, clearly labelled as a preview.
    """

    index: int
    action: str
    detail: str
    screenshot: str | None = None


class ScienceFigure(BaseModel):
    """One real visual artifact a Claude Science run produced — a plot, chart, structure render, or
    image, downloaded from the run's saved artifacts (or extracted inline as a fallback).

    ``image`` is a self-contained ``data:`` URL so the web client renders it inline with no asset
    host (and it survives being persisted in the local chat store). Figures are populated on a
    **live** run only; the simulated preview never fabricates them (CLAUDE.md hard rule 1 — no
    invented grounding).
    """

    title: str
    image: str
    caption: str | None = None


class ScienceFile(BaseModel):
    """A non-image artifact a run produced (e.g. a dataset CSV), surfaced as a download.

    ``download`` is a self-contained ``data:`` URL for files small enough to inline; ``None`` for
    ones too large to embed (the UI then just names the file). Populated on a live run only.
    """

    name: str
    content_type: str
    size_bytes: int
    download: str | None = None


class ScienceSession(BaseModel):
    """The whole recorded run: what was asked, how it ran, the ordered steps, and the result.

    ``status`` tells the UI (and the human) whether this was a real drive of Claude Science
    (``completed``) or a preview (``simulated`` / ``unreachable`` / ``error``) — we never dress a
    simulation, or an incomplete run, up as a real result (CLAUDE.md hard rule 1: no fabricated
    grounding).

    ``figures`` are the run's real visual output (graphs/charts/structures) and ``files`` its other
    saved artifacts (datasets, etc.), downloaded from the run on a live drive and rendered as a
    gallery + download list; both empty on a preview.
    """

    task: str
    status: Literal["completed", "simulated", "unreachable", "error"]
    url: str
    model: str | None = None
    steps: list[ScienceStep]
    result_title: str
    result_summary: str
    metrics: list[ScienceMetric] = []
    figures: list[ScienceFigure] = []
    files: list[ScienceFile] = []
    note: str | None = None


async def run_science_session(
    task: str,
    settings: Settings,
    *,
    step_delay: float = _STEP_DELAY,
) -> AsyncIterator[ScienceStep | ScienceSession]:
    """Run one Claude Science session, yielding each :class:`ScienceStep` live, then a terminal
    :class:`ScienceSession`.

    The final item is always a :class:`ScienceSession` (consumers detect it by type). The live drive
    is attempted only when the configured URL is loopback and the daemon is reachable; any failure
    falls back to the simulated session so the caller always gets a clean, complete run.
    """
    task = (task or "").strip()
    url = settings.claude_science_url.rstrip("/")

    if not _is_loopback(url):
        # Containment: Claymore only ever drives a *local* Claude Science. Refuse anything else.
        note = (
            f"Claude Science is configured at {url}, which isn't a loopback address. Claymore only "
            "drives a local Claude Science (localhost) — showing a simulated preview."
        )
        async for item in _run_simulated(task, url, "simulated", note, step_delay):
            yield item
        return

    if await _healthy(url):
        try:
            async for item in _run_api(task, url, settings, step_delay):
                yield item
            return
        except _ScienceUnavailable as exc:
            _log.warning("claude_science.unavailable", error=str(exc)[:200])
            note = (
                f"Claude Science is running but Claymore couldn't drive it ({exc}). Showing a "
                "preview. Make sure the daemon is signed in (`claude-science serve`)."
            )
            async for item in _run_simulated(task, url, "error", note, step_delay):
                yield item
            return
        except Exception as exc:  # never let a client/HTTP hiccup break the turn — degrade
            _log.warning("claude_science.live_failed", error=str(exc)[:200])
            note = (
                "Claude Science was reachable but the live drive failed; showing a preview instead."
            )
            async for item in _run_simulated(task, url, "error", note, step_delay):
                yield item
            return

    note = (
        f"Claude Science isn't running at {url} — showing a simulated preview of the run. "
        "Start it with `claude-science serve` and Claymore will drive it for real."
    )
    async for item in _run_simulated(task, url, "unreachable", note, step_delay):
        yield item


# --- live: headless HTTP API drive of the local Claude Science daemon --------------------------


def _is_loopback(url: str) -> bool:
    """True only for a genuine loopback origin (localhost / 127.0.0.0-8 / ::1). This is the
    containment gate — anything else is treated as 'not local' and never driven."""
    try:
        host = (httpx.URL(url).host or "").strip("[]").lower()
    except Exception:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


async def _healthy(url: str) -> bool:
    """True if the daemon answers 200 at ``/health`` (its unauthenticated liveness endpoint)."""
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            resp = await client.get(f"{url}/health")
        return resp.status_code == 200
    except Exception:
        return False


async def _guard_loopback(request: httpx.Request) -> None:
    """Event hook: abort any request — including a redirect the daemon might emit — that would
    leave loopback. Belt-and-suspenders enforcement of the containment gate."""
    if not _is_loopback(str(request.url)):
        raise _ScienceUnavailable(f"refused a non-loopback request to {request.url.host!r}")


async def _run_api(
    task: str, url: str, settings: Settings, step_delay: float
) -> AsyncIterator[ScienceStep | ScienceSession]:
    """Drive Claude Science for real: sign in, create a run in a project, poll the frame to a
    terminal state (streaming each status change), then yield the grounded result."""
    poll = settings.claude_science_poll_interval_s or _POLL_INTERVAL
    timeout_s = settings.claude_science_run_timeout_s or _RUN_TIMEOUT

    async with httpx.AsyncClient(
        base_url=url,
        timeout=30.0,
        follow_redirects=True,
        event_hooks={"request": [_guard_loopback]},
    ) as client:
        await _authenticate(client, settings)
        steps: list[ScienceStep] = []
        # Artifact ids already streamed as 'render' steps, so a figure the run saves is previewed
        # once even though it persists on every subsequent poll.
        seen_art_ids: set[str] = set()
        seen_inline: set[str] = set()

        def step(action: str, detail: str, *, screenshot: str | None = None) -> ScienceStep:
            # Live steps carry NO synthetic frame — a real run gets a real figure (streamed below as
            # its own "render" step) or nothing at all. We never draw a fake window over a real run.
            s = ScienceStep(
                index=len(steps) + 1, action=action, detail=detail, screenshot=screenshot
            )
            steps.append(s)
            return s

        yield step("connect", "Signed in to the local Claude Science daemon")

        project_id = await _pick_project(client, settings)
        frame_id = await _create_run(client, url, project_id, task, settings)
        yield step("submit", "Dispatched the task to the coordinating agent")

        last_desc: str | None = None
        resolved: set[str] = set()
        allowed_domains = _parse_allowed_domains(settings.claude_science_allowed_domains)
        elapsed = 0.0
        frame: dict[str, Any] = {}
        while True:
            frame = await _get_frame(client, frame_id)
            status = str(frame.get("status") or "").lower()

            # Answer any gate the run parks on so it proceeds unattended (see _resolve_pending):
            # a question -> let Claude Science's agent decide; on-host code execution -> allow;
            # external network -> allow only to an allowlisted data/reference domain, else deny.
            pending = _pending_requests(frame)
            fresh = [p for p in pending if _stable_key(p) and _stable_key(p) not in resolved]
            if fresh:
                res = await _resolve_pending(client, url, frame_id, fresh, allowed_domains)
                resolved.update(res.keys)
                if res.answered:
                    yield step(
                        "gate",
                        "Claude Science asked how to proceed — letting it continue with its "
                        "recommended approach",
                    )
                if res.allowed:
                    yield step("gate", f"Approved {res.allowed} on-host code-execution step(s)")
                if res.net_allowed:
                    yield step(
                        "gate", f"Allowed network access to {_clip(', '.join(res.net_allowed), 60)}"
                    )
                if res.net_denied:
                    yield step(
                        "gate",
                        f"Declined network access to {_clip(', '.join(res.net_denied), 50)} "
                        "(not on the allowlist)",
                    )
                if res.denied:
                    yield step(
                        "gate",
                        f"Declined {res.denied} external request(s) — kept the run on localhost",
                    )

            desc = str(frame.get("status_description") or "").strip()
            if desc and desc != last_desc:
                last_desc = desc
                yield step("work", desc)

            # Preview each real figure the moment the run saves it (the daemon's artifact API), so
            # the panel shows genuine output — the actual visual output from Claude Science. Falls
            # back to any image inlined in the frame (older daemons).
            for fig in await _new_artifact_figures(client, frame_id, seen_art_ids):
                yield step("render", f"Rendered {fig.title}", screenshot=fig.image)
            for fig in _new_inline_figures(frame, seen_inline):
                yield step("render", f"Rendered {fig.title}", screenshot=fig.image)

            if status in _TERMINAL_OK or status in _TERMINAL_BAD:
                break
            if elapsed >= timeout_s:
                figures, files = await _collect_artifacts(client, frame)
                yield _timeout_session(task, url, settings, frame, steps, figures, files)
                return

            await asyncio.sleep(poll)
            elapsed += poll

        figures, files = await _collect_artifacts(client, frame)
        yield _api_session(task, url, settings, frame, steps, figures, files)


async def _authenticate(client: httpx.AsyncClient, settings: Settings) -> None:
    """Establish a daemon session: mint a one-time nonce via the CLI, exchange it for the
    ``operon_auth`` cookie (kept in the client's jar), and confirm it took."""
    nonce = await _mint_nonce(settings)
    # GET /?nonce seeds the CSRF cookie; POST /api/auth/nonce sets the session cookie.
    await client.get("/", params={"nonce": nonce})
    resp = await client.post("/api/auth/nonce", data={"nonce": nonce, "dest": "/"})
    if resp.status_code != 200:
        raise _ScienceUnavailable(f"login failed (HTTP {resp.status_code})")
    me = await client.get("/api/me")
    if me.status_code != 200:
        raise _ScienceUnavailable(f"session check failed (HTTP {me.status_code})")


def _cli_path(settings: Settings) -> str:
    return os.path.expanduser(settings.claude_science_cli or _DEFAULT_CLI)


async def _mint_nonce(settings: Settings) -> str:
    """Run ``claude-science url`` and parse the single-use login nonce out of its output."""
    cli = _cli_path(settings)
    try:
        proc = await asyncio.create_subprocess_exec(
            cli,
            "url",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise _ScienceUnavailable(f"claude-science CLI not found at {cli}") from None
    try:
        out, _err = await asyncio.wait_for(proc.communicate(), timeout=15.0)
    except TimeoutError:
        proc.kill()
        raise _ScienceUnavailable("timed out minting a login nonce") from None
    match = re.search(r"nonce=([a-f0-9]+)", (out or b"").decode("utf-8", "replace"))
    if not match:
        raise _ScienceUnavailable("couldn't mint a login nonce via the CLI")
    return match.group(1)


async def _pick_project(client: httpx.AsyncClient, settings: Settings) -> str:
    """The configured project, else the first non-example project the daemon knows about."""
    if settings.claude_science_project_id:
        return settings.claude_science_project_id
    resp = await client.get("/api/projects")
    if resp.status_code != 200:
        raise _ScienceUnavailable(f"couldn't list projects (HTTP {resp.status_code})")
    projects = (resp.json() or {}).get("projects") or []
    real = [p for p in projects if not str(p.get("project_id", "")).startswith("proj_example")]
    chosen = real or projects
    if not chosen:
        raise _ScienceUnavailable("no Claude Science project to run in")
    return str(chosen[0]["project_id"])


async def _create_run(
    client: httpx.AsyncClient, url: str, project_id: str, task: str, settings: Settings
) -> str:
    """Start the run in ``project_id``; return its root frame id."""
    body = {
        "input_data": {"request": task},
        "model": settings.claude_science_model,
        "effort": settings.claude_science_effort,
        "thinking": True,
        "target_agent": _ROOT_AGENT,
        "ultra_mode": True,
        "intent_id": str(uuid.uuid4()),
    }
    resp = await client.post(
        f"/api/projects/{project_id}/request", json=body, headers=_write_headers(client, url)
    )
    if resp.status_code != 200:
        raise _ScienceUnavailable(
            f"couldn't start the run (HTTP {resp.status_code}: {resp.text[:120]})"
        )
    data = resp.json() or {}
    frame_id = data.get("root_frame_id") or data.get("frame_id") or data.get("id")
    if not frame_id:
        raise _ScienceUnavailable("run started but returned no frame id")
    return str(frame_id)


async def _get_frame(client: httpx.AsyncClient, frame_id: str) -> dict[str, Any]:
    resp = await client.get(f"/api/frames/{frame_id}")
    if resp.status_code != 200:
        raise _ScienceUnavailable(f"couldn't read run status (HTTP {resp.status_code})")
    return resp.json() or {}


class _Resolution(BaseModel):
    """What :func:`_resolve_pending` did this pass — drives honest progress steps."""

    keys: list[str] = []
    answered: int = 0
    allowed: int = 0  # on-host code-execution steps approved
    denied: int = 0  # non-network egress refused (installs off-host, contact-email, etc.)
    net_allowed: list[str] = []  # external domains granted (on the allowlist)
    net_denied: list[str] = []  # external domains refused (off the allowlist)


async def _add_allowed_domain(client: httpx.AsyncClient, url: str, domain: str) -> bool:
    """Add ``domain`` to the daemon's persistent user allowlist so the run may fetch it. This is the
    'Always'-scope grant the daemon requires for network access (a single-call approval is refused).
    Only hosts that already passed Claymore's own allowlist reach here. Best-effort: returns whether
    the daemon accepted it; failure just leaves that fetch blocked, never a crash."""
    if not domain:
        return False
    try:
        resp = await client.post(
            _ALLOWED_DOMAINS_EP, json={"domain": domain}, headers=_write_headers(client, url)
        )
    except Exception as exc:
        _log.warning("claude_science.add_domain_failed", domain=domain, error=str(exc)[:120])
        return False
    return resp.status_code == 200


async def _resolve_pending(
    client: httpx.AsyncClient,
    url: str,
    frame_id: str,
    pending: list[dict[str, Any]],
    allowed_domains: frozenset[str],
) -> _Resolution:
    """Answer each pending gate so the run proceeds unattended, per Claymore's policy:

    * ``kind == "ask"`` (an interactive question) → ``decide_for_me``: hand the choice back to
      Claude Science's own agent (its recommended path). We never guess a scientific choice.
    * ``kind`` starting ``local_`` (on-host sandbox code execution, e.g. ``local_exec``) →
      ``allow``: this IS "let it execute code", and it never leaves the machine.
    * ``kind == "network"`` (external egress to a ``target`` host) → when the host is on
      ``allowed_domains`` (reputable public data/reference sources), Claymore **adds it to the
      daemon's persistent allowlist** (:func:`_add_allowed_domain`) — a per-call resolve is refused
      for network ("cannot be granted for a single call; approve with the 'Always' scope"), so the
      grant must be the persistent kind. Off-allowlist → ``deny``. Deny-by-default holds (rule 7),
      and the daemon keeps its own ``deniedDomains`` blocklist (paste/exfil hosts) as a backstop.
    * anything else (off-host package install, contact-email egress, ...) → ``deny``.

    Parked requests are addressed by ``tool_id`` (``requestId`` is rejected once a request parks);
    live ones by ``requestId``.
    """
    responses: list[dict[str, Any]] = []
    out = _Resolution()
    for req in pending:
        response, category = _pending_response(req, allowed_domains)
        if response is None:
            continue
        out.keys.append(_stable_key(req))
        if category == "ask":
            out.answered += 1
            responses.append(response)
        elif category == "allow":
            out.allowed += 1
            responses.append(response)
        elif category == "allow_net":
            # Grant persistently by adding the host to the daemon's allowlist (the "Always" scope);
            # the run's fetch then succeeds. Also answer the parked request so the current call
            # unblocks. Only hosts that passed our own allowlist reach here.
            domain = _host_of(str(req.get("target") or ""))
            granted = await _add_allowed_domain(client, url, domain)
            (out.net_allowed if granted else out.net_denied).append(domain or "?")
            _log.info("claude_science.network_grant", domain=domain, granted=granted)
            responses.append(response)
        elif category == "deny_net":
            out.net_denied.append(_host_of(str(req.get("target") or "")) or "?")
            _log.info("claude_science.network_denied", domain=req.get("target"))
            responses.append(response)
        else:
            out.denied += 1
            responses.append(response)
    if not responses:
        return out
    body = {"responses": responses, "ultra_mode": True, "target_agent": _ROOT_AGENT}
    try:
        await client.post(
            f"/api/frames/{frame_id}/resolve-input", json=body, headers=_write_headers(client, url)
        )
    except Exception as exc:  # a failed resolve shouldn't abort the whole run — log + move on
        _log.warning("claude_science.resolve_failed", error=str(exc)[:120])
        return _Resolution()
    return out


def _parse_allowed_domains(raw: str) -> frozenset[str]:
    """Parse the comma-separated ``claude_science_allowed_domains`` setting into a normalized set of
    base domains (lowercased, ``www.`` stripped, blanks dropped). A bare single label (a TLD like
    ``com``, or ``localhost``) is rejected — it would wildcard-match every host under it, so every
    allowlist entry must have a dot."""
    out: set[str] = set()
    for part in (raw or "").split(","):
        host = part.strip().lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        # Require a dot AND that the host is a clean domain (no scheme/path/space slipped in).
        if host and "." in host and re.fullmatch(r"[a-z0-9.-]+", host):
            out.add(host)
    return frozenset(out)


def _host_of(target: str) -> str:
    """Reduce a network ``target`` to a bare lowercased host, parsed with a real RFC-3986 URL parser
    so it matches what the fetching client resolves — closing the parser-differential bypass where
    ``evil.com#@figshare.com`` (fragment/query/userinfo tricks) would otherwise reduce to an
    allowlisted label. Returns "" for anything that isn't a plain domain (an IP, an injection
    artifact, unicode), which the caller then treats as not-allowed."""
    t = target.strip().lower()
    if not t:
        return ""
    # Parse the authority as a URL; prefix "//" for a bare "host[:port][/path]" so urlsplit reads
    # the authority (not a path). .hostname applies RFC-3986 rules (fragment/query/userinfo/port).
    try:
        host = urlsplit(t if "://" in t else "//" + t).hostname or ""
    except ValueError:
        return ""
    host = host.rstrip(".")
    # A legitimate allowlistable host is only letters/digits/dots/hyphens with a dot. Anything else
    # (an IP, a bracketed IPv6, a unicode/IDN homograph, a stray parse artifact) -> reject.
    if not host or "." not in host or not re.fullmatch(r"[a-z0-9.-]+", host):
        return ""
    return host


def _domain_allowed(target: str, allowed_domains: frozenset[str]) -> bool:
    """True iff the ``target`` host is an allowlisted domain or a dot-boundary subdomain of one.
    ``api.figshare.com`` matches ``figshare.com``; ``figshare.com.evil.com`` does not."""
    host = _host_of(target)
    if not host or not allowed_domains:
        return False
    return any(host == d or host.endswith("." + d) for d in allowed_domains)


def _pending_response(
    req: dict[str, Any], allowed_domains: frozenset[str]
) -> tuple[dict[str, Any] | None, str]:
    """The resolve-input response for one pending request, plus a category label
    (``ask`` | ``allow`` | ``allow_net`` | ``deny_net`` | ``deny`` | ``skip``). Pure (no I/O) so the
    policy is unit-testable.

    Policy: a question -> ``decide_for_me``; on-host code execution (``local_*``) -> ``allow``;
    external network to an allowlisted domain -> ``allow`` (``allow_net``), off-allowlist ->
    ``deny`` (``deny_net``); everything else -> ``deny``. No addressable id -> skipped."""
    ref_key, ref_val = _pending_ref(req)
    if not ref_val:
        return None, "skip"
    kind = str(req.get("kind") or "").lower()
    if kind == "ask":
        return {ref_key: ref_val, "answers": {}, "action": "decide_for_me"}, "ask"
    if kind.startswith("local_"):
        return {ref_key: ref_val, "approved": True, "action": "allow"}, "allow"
    if kind == "network":
        if _domain_allowed(str(req.get("target") or ""), allowed_domains):
            return {ref_key: ref_val, "approved": True, "action": "allow"}, "allow_net"
        return {ref_key: ref_val, "approved": False, "action": "deny"}, "deny_net"
    return {ref_key: ref_val, "approved": False, "action": "deny"}, "deny"


def _pending_ref(req: dict[str, Any]) -> tuple[str, str]:
    """The identifier the daemon wants in a resolve-input response: ``tool_id`` once a request has
    parked (``requestId`` is live-only and rejected then), otherwise ``requestId``."""
    tool_id = req.get("tool_id") or req.get("toolId")
    request_id = req.get("requestId") or req.get("id") or req.get("request_id")
    parked = str(req.get("mode") or "").lower() == "parked"
    if parked and tool_id:
        return "tool_id", str(tool_id)
    if request_id:
        return "requestId", str(request_id)
    if tool_id:
        return "tool_id", str(tool_id)
    return "requestId", ""


def _write_headers(client: httpx.AsyncClient, url: str) -> dict[str, str]:
    """Headers the daemon requires on state-changing writes: same-origin + CSRF echo."""
    return {
        "Origin": url,
        "x-operon-csrf": client.cookies.get("operon_csrf") or "",
        "content-type": "application/json",
    }


def _pending_requests(frame: dict[str, Any]) -> list[dict[str, Any]]:
    out = frame.get("output_data")
    if isinstance(out, dict):
        reqs = out.get("pending_input_requests")
        if isinstance(reqs, list):
            return [r for r in reqs if isinstance(r, dict)]
    return []


def _stable_key(req: dict[str, Any]) -> str:
    """A dedup key stable across a request's live→parked transition — ``tool_id`` stays constant
    while ``requestId`` may not be present on the parked copy."""
    return str(
        req.get("tool_id")
        or req.get("toolId")
        or req.get("requestId")
        or req.get("id")
        or req.get("request_id")
        or ""
    )


def _badge(desc: str) -> str:
    """A short chip label for a status line (first clause, clipped)."""
    head = re.split(r"[—:.\-]| for | of ", desc, maxsplit=1)[0]
    return _clip(head.strip() or "Working", 22)


_MAX_ANSWER_CHARS = 16_000  # cap the result summary; a real answer + tables fits well under this


def _message_text(msg: dict[str, Any]) -> str:
    """The prose of one conversation message — its ``text`` content blocks joined."""
    blocks = msg.get("content")
    if not isinstance(blocks, list):
        return ""
    parts = [
        b["text"]
        for b in blocks
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)
    ]
    return "\n".join(parts).strip()


def _final_answer(frame: dict[str, Any]) -> str:
    """The run's full analytical answer. ``output_data.response`` is only the LAST assistant
    utterance — after a review/audit cycle that's a short *correction*, not the comprehensive result
    (the numbers/tables/conclusion). So rebuild the answer from the conversation: the substantive
    assistant message (the longest prose the coordinator wrote), plus any assistant messages that
    follow it (e.g. a reviewer correction) and the daemon's own ``response`` — so nothing is dropped
    and the numbers always survive. Falls back to ``response`` / ``status_description`` when there
    are no messages (older daemons)."""
    ctx = frame.get("context_data")
    msgs = ctx.get("_messages") if isinstance(ctx, dict) else None
    out = frame.get("output_data")
    response = (out.get("response") or "").strip() if isinstance(out, dict) else ""

    texts: list[str] = []
    if isinstance(msgs, list):
        for m in msgs:
            if isinstance(m, dict) and str(m.get("role")) == "assistant":
                text = _message_text(m)
                if text:
                    texts.append(text)
    if not texts:
        return response or str(frame.get("status_description") or "").strip()

    primary_idx = max(range(len(texts)), key=lambda i: len(texts[i]))  # the comprehensive answer
    parts = [texts[primary_idx]]
    for extra in texts[primary_idx + 1 :]:  # corrections/addenda that came after it
        if extra and extra not in parts[0]:
            parts.append(extra)
    if response and all(response not in p for p in parts):  # belt: keep the daemon's own response
        parts.append(response)
    return "\n\n".join(parts)[:_MAX_ANSWER_CHARS]


def _api_session(
    task: str,
    url: str,
    settings: Settings,
    frame: dict[str, Any],
    steps: list[ScienceStep],
    figures: list[ScienceFigure],
    files: list[ScienceFile],
) -> ScienceSession:
    """Build the terminal session from a finished frame — completed only if the run actually
    completed; otherwise a labelled error (never a fabricated success)."""
    ok = str(frame.get("status") or "").lower() in _TERMINAL_OK
    response = _final_answer(frame)
    summary = response or str(frame.get("status_description") or "").strip()
    if not summary:
        summary = (
            "Claude Science finished the run." if ok else "Claude Science did not finish the run."
        )
    note = None
    if not ok:
        desc = str(frame.get("status_description") or "").strip()
        note = f"Claude Science ended in state '{frame.get('status')}'." + (
            f" {desc}" if desc else ""
        )
    return ScienceSession(
        task=task,
        status="completed" if ok else "error",
        url=url,
        model=str(frame.get("model") or settings.claude_science_model),
        steps=steps,
        result_title=_result_title(str(frame.get("name") or "").strip() or task),
        result_summary=summary,
        metrics=_api_metrics(frame),
        figures=figures,
        files=files,
        note=note,
    )


def _timeout_session(
    task: str,
    url: str,
    settings: Settings,
    frame: dict[str, Any],
    steps: list[ScienceStep],
    figures: list[ScienceFigure],
    files: list[ScienceFile],
) -> ScienceSession:
    """We stopped waiting but the run continues server-side — say so honestly, not 'completed'."""
    desc = str(frame.get("status_description") or "").strip()
    return ScienceSession(
        task=task,
        status="error",
        url=url,
        model=str(frame.get("model") or settings.claude_science_model),
        steps=steps,
        result_title=_result_title(task),
        result_summary=(desc or "Claude Science is still working on the run."),
        metrics=_api_metrics(frame),
        figures=figures,
        files=files,
        note=(
            "Claymore stopped waiting before Claude Science finished — the run is still going in "
            "the app. Open Claude Science to see the final result."
        ),
    )


def _api_metrics(frame: dict[str, Any]) -> list[ScienceMetric]:
    """Real, grounded run stats — model, token spend, cost, sub-agents, agent steps."""
    metrics: list[ScienceMetric] = []
    if frame.get("model"):
        metrics.append(ScienceMetric(label="model", value=_pretty_model(str(frame["model"]))))
    tin, tout = frame.get("input_tokens"), frame.get("output_tokens")
    if tin is not None or tout is not None:
        metrics.append(ScienceMetric(label="tokens", value=f"{_ktok(tin)} in · {_ktok(tout)} out"))
    cost = frame.get("total_cost")
    if isinstance(cost, (int, float)) and cost > 0:
        metrics.append(ScienceMetric(label="cost", value=f"${cost:.2f}"))
    specialists = frame.get("specialists_used") or []
    children = frame.get("children") or []
    if specialists:
        metrics.append(
            ScienceMetric(label="specialists", value=_clip(", ".join(map(str, specialists)), 40))
        )
    elif children:
        metrics.append(ScienceMetric(label="sub-agents", value=str(len(children))))
    if frame.get("message_count"):
        metrics.append(ScienceMetric(label="agent steps", value=str(frame["message_count"])))
    return metrics


def _pretty_model(model: str) -> str:
    """``claude-opus-4-8`` -> ``Opus 4.8`` (best-effort; falls back to the raw id)."""
    m = re.match(r"claude-(opus|sonnet|haiku)-(\d+)-(\d+)", model)
    if not m:
        return model
    return f"{m.group(1).title()} {m.group(2)}.{m.group(3)}"


def _ktok(n: Any) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "0"
    if n >= 1000:
        return f"{n / 1000:.1f}k"
    return str(n)


# --- real figures: extract genuine visual output from a live run frame -------------------------
#
# Claude Science produces plots / charts / structure renders during a run. Its frame JSON carries
# them, but we don't know the exact schema, so we detect image-shaped values wherever they sit
# (Anthropic image content blocks, raw data: URLs, image-mimed artifact dicts, image-file refs) and
# normalize each to a self-contained data: URL. Anything referenced by a loopback URL is fetched
# through the same containment-locked client; a non-loopback ref is never fetched. If a frame has no
# images we surface none — we never fabricate a figure (CLAUDE.md hard rule 1).


class _RawFigure(BaseModel):
    """A figure candidate found while walking a frame: either a ready ``data_url`` or a ``fetch``
    reference (a loopback URL/path) to resolve, plus any title/caption from nearby keys."""

    data_url: str | None = None
    fetch: str | None = None
    title: str | None = None
    caption: str | None = None


def _first_str(obj: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    """First non-empty string value among ``keys`` (used to lift a figure's title/caption)."""
    for key in keys:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _looks_like_image_ref(value: str) -> bool:
    """True for a string that references an image: a ``data:image/`` URL or a path/URL whose (query-
    stripped) name ends in an image extension."""
    v = value.strip()
    if v.startswith("data:image/"):
        return True
    stem = v.split("?", 1)[0].split("#", 1)[0].lower()
    return stem.endswith(_IMAGE_EXTS)


def _image_block_figure(block: dict[str, Any], title: str | None) -> _RawFigure | None:
    """An Anthropic-style image content block: ``{"type":"image","source":{...}}``. base64 source →
    inline data URL; url source → a fetch ref (resolved later, loopback-gated). Other sources (e.g.
    a Files-API ``file_id`` whose endpoint we can't assume) are skipped rather than guessed at."""
    source = block.get("source")
    if not isinstance(source, dict):
        return None
    stype = str(source.get("type") or "").lower()
    caption = _first_str(block, ("caption", "alt", "description"))
    if stype == "base64":
        media = str(source.get("media_type") or "").lower()
        data = source.get("data")
        if media.startswith("image/") and isinstance(data, str) and data:
            return _RawFigure(data_url=f"data:{media};base64,{data}", title=title, caption=caption)
        return None
    if stype in ("url", "uri"):
        ref = source.get("url") or source.get("uri")
        if isinstance(ref, str) and ref:
            return _RawFigure(fetch=ref, title=title, caption=caption)
    return None


def _artifact_figure(obj: dict[str, Any], media: str, title: str | None) -> _RawFigure | None:
    """An artifact/file dict whose media type is an image: take an inline base64 payload if present,
    else a loopback URL/path to fetch."""
    caption = _first_str(obj, ("caption", "alt", "description"))
    for key in ("data", "base64", "b64", "b64_json", "content"):
        payload = obj.get(key)
        if not isinstance(payload, str) or not payload:
            continue
        if payload.startswith("data:"):
            return _RawFigure(data_url=payload, title=title, caption=caption)
        # A raw base64 blob paired with an image media type -> a data URL.
        return _RawFigure(data_url=f"data:{media};base64,{payload}", title=title, caption=caption)
    ref = _first_str(obj, ("url", "uri", "src", "href", "path", "file_path", "download_url"))
    if ref:
        return _RawFigure(fetch=ref, title=title, caption=caption)
    return None


def _walk_figures(
    obj: Any, out: list[_RawFigure], budget: list[int], depth: int, title: str | None
) -> None:
    """Recursively collect figure candidates from a frame (its messages, content blocks, children,
    output_data — wherever they nest). Bounded in depth, node count, AND output size so a huge or
    hostile frame (e.g. one wide dict of a million image strings) can't exhaust memory or hang: the
    budget is spent per node visited and every append site checks the caps. Pure I/O-free: refs
    resolve later."""
    if depth > _WALK_MAX_DEPTH or _walk_exhausted(out, budget):
        return
    budget[0] -= 1
    if isinstance(obj, str):
        if obj.startswith("data:image/"):
            out.append(_RawFigure(data_url=obj, title=title))
        return
    if isinstance(obj, list):
        for item in obj:
            if _walk_exhausted(out, budget):
                return
            budget[0] -= 1
            _walk_figures(item, out, budget, depth + 1, title)
        return
    if not isinstance(obj, dict):
        return

    local_title = _first_str(obj, ("title", "name", "label", "filename", "caption", "alt")) or title

    # (1) An explicit image content block.
    if str(obj.get("type") or "").lower() == "image":
        fig = _image_block_figure(obj, local_title)
        if fig is not None:
            out.append(fig)
            return  # don't also recurse into its source and double-count

    # (2) An artifact/file dict with an image media type.
    media = _first_str(obj, ("media_type", "mime", "mime_type", "content_type", "contentType"))
    if media and media.lower().startswith("image/"):
        fig = _artifact_figure(obj, media.lower(), local_title)
        if fig is not None:
            out.append(fig)
            return

    # (3) A string value under an image-ish key (a data: URL or an image file ref).
    for key in _IMAGE_REF_KEYS:
        if _walk_exhausted(out, budget):
            return
        val = obj.get(key)
        if isinstance(val, str) and _looks_like_image_ref(val):
            if val.startswith("data:image/"):
                out.append(_RawFigure(data_url=val, title=local_title))
            else:
                out.append(_RawFigure(fetch=val, title=local_title))

    # (4) Recurse into nested structure. A bare ``data:image/`` string is unambiguously an image,
    # so capture it under any key (a plain filename under a non-image key stays ambiguous → skip).
    # The budget is spent per key so a single very wide dict can't append past the caps.
    for key, value in obj.items():
        if _walk_exhausted(out, budget):
            return
        budget[0] -= 1
        if isinstance(value, str):
            if value.startswith("data:image/") and key not in _IMAGE_REF_KEYS:
                out.append(_RawFigure(data_url=value, title=local_title))
        elif isinstance(value, (dict, list)):
            _walk_figures(value, out, budget, depth + 1, local_title)


def _walk_exhausted(out: list[_RawFigure], budget: list[int]) -> bool:
    """True once the walk has spent its node budget or collected enough raw candidates — the single
    place both hard bounds are enforced, checked at every append/recurse site."""
    return budget[0] <= 0 or len(out) >= _MAX_FIGURES * 4


def _valid_image_data_url(data_url: str) -> str | None:
    """Return ``data_url`` if it is a well-formed image data URL of an allowed type and within the
    size cap; else ``None``. This is the last gate before a figure reaches the client."""
    if not data_url.startswith("data:"):
        return None
    try:
        header, payload = data_url[5:].split(",", 1)
    except ValueError:
        return None
    media = header.split(";", 1)[0].strip().lower()
    if media not in _ALLOWED_IMAGE_MEDIA:
        return None
    is_b64 = ";base64" in header.lower()
    if is_b64:
        # Decoded size ≈ 3/4 of the base64 length; validate it actually decodes.
        if (len(payload) * 3) // 4 > _MAX_FIGURE_BYTES:
            return None
        try:
            base64.b64decode(payload, validate=True)
        except (ValueError, binascii.Error):
            return None
    elif len(payload) > _MAX_FIGURE_BYTES:
        return None
    return data_url


def _fig_key(data_url: str) -> str:
    """A dedup key for a figure — a content hash of the whole data URL. A prefix would false-merge
    two distinct images that share a header (same dimensions/top rows); a full digest won't, and it
    stays stable across polls."""
    return hashlib.sha256(data_url.encode("utf-8", "ignore")).hexdigest()


def _inline_figures(frame: dict[str, Any]) -> list[ScienceFigure]:
    """The frame's figures that are already inline data URLs — no I/O, so it's safe to call on every
    poll to animate real output as it lands."""
    raws: list[_RawFigure] = []
    _walk_figures(frame, raws, [_WALK_MAX_NODES], 0, None)
    figures: list[ScienceFigure] = []
    seen: set[str] = set()
    for raw in raws:
        if raw.data_url is None:
            continue
        valid = _valid_image_data_url(raw.data_url)
        if not valid:
            continue
        key = _fig_key(valid)
        if key in seen:
            continue
        seen.add(key)
        figures.append(_science_figure(valid, raw, len(figures)))
        if len(figures) >= _MAX_FIGURES:
            break
    return figures


def _new_inline_figures(frame: dict[str, Any], seen: set[str]) -> list[ScienceFigure]:
    """Inline figures in ``frame`` not yet streamed (mutates ``seen``). Powers the live 'render'
    steps so the panel shows real figures the moment they appear."""
    fresh: list[ScienceFigure] = []
    for fig in _inline_figures(frame):
        key = _fig_key(fig.image)
        if key in seen:
            continue
        seen.add(key)
        fresh.append(fig)
    return fresh


def _science_figure(image: str, raw: _RawFigure, index: int) -> ScienceFigure:
    """Normalize a validated data URL + its raw metadata into a titled figure."""
    title = _clip(raw.title, 80) if raw.title else f"Figure {index + 1}"
    caption = _clip(raw.caption, 160) if raw.caption else None
    return ScienceFigure(title=title, image=image, caption=caption)


# --- real figures/files: the daemon's artifact API (authoritative) -----------------------------


def _artifact_frame_ids(frame: dict[str, Any]) -> list[str]:
    """The frame ids to enumerate artifacts from: the root frame plus its child (sub-agent) frames —
    a figure may be saved by any agent in the run tree."""
    ids: list[str] = []
    root = frame.get("id")
    if isinstance(root, str) and root:
        ids.append(root)
    for child in frame.get("children") or []:
        if isinstance(child, dict) and isinstance(child.get("id"), str) and child["id"]:
            ids.append(child["id"])
        elif isinstance(child, str) and child:
            ids.append(child)
    seen: set[str] = set()
    out: list[str] = []
    for fid in ids:
        if fid not in seen:
            seen.add(fid)
            out.append(fid)
    return out[: 1 + _MAX_CHILD_FRAMES]


async def _get_capped(
    client: httpx.AsyncClient, path: str, max_bytes: int
) -> tuple[bytes, str] | None:
    """GET ``path`` on the containment-locked client, streaming the body and ABORTING once it
    exceeds ``max_bytes`` — so a daemon that under-reports a size (or serves a multi-GB body) can't
    exhaust memory. Enforces the cap *during* the download, not after. Any failure returns ``None``.
    The ``_guard_loopback`` request hook still fires, so this can only ever hit the local daemon."""
    try:
        async with client.stream("GET", path) as resp:
            if resp.status_code != 200:
                return None
            content_type = (resp.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > max_bytes:
                    return None  # over the cap — stop reading, discard
            return bytes(buf), content_type
    except Exception:
        return None


async def _list_frame_artifacts(client: httpx.AsyncClient, frame_id: str) -> list[dict[str, Any]]:
    """The artifacts a frame produced: ``[{id, filename, content_type, size_bytes, ...}]``. The body
    is size-capped and the record count is bounded. Best-effort — any failure yields an empty list
    rather than raising into the run."""
    got = await _get_capped(client, _FRAME_ARTIFACTS_EP.format(frame_id=frame_id), _MAX_LIST_BYTES)
    if got is None:
        return []
    body, _content_type = got
    try:
        data = json.loads(body)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [a for a in data if isinstance(a, dict)][:_MAX_ARTIFACT_RECORDS]


async def _fetch_artifact(client: httpx.AsyncClient, artifact_id: str) -> tuple[bytes, str] | None:
    """Download one artifact's bytes + its content-type, capped at ``_MAX_FIGURE_BYTES`` (the larger
    of the figure/file caps) and enforced during the stream so an oversized body can't OOM us."""
    return await _get_capped(
        client, _ARTIFACT_EP.format(artifact_id=artifact_id), _MAX_FIGURE_BYTES
    )


async def _figure_from_artifact(
    client: httpx.AsyncClient, artifact_id: str, name: str
) -> ScienceFigure | None:
    """Download an image artifact and turn it into a rendered figure (data URL, size-capped)."""
    got = await _fetch_artifact(client, artifact_id)
    if got is None:
        return None
    content, content_type = got
    if not content_type.startswith("image/") or not content or len(content) > _MAX_FIGURE_BYTES:
        return None
    b64 = base64.b64encode(content).decode("ascii")
    data_url = _valid_image_data_url(f"data:{content_type};base64,{b64}")
    if data_url is None:
        return None
    return ScienceFigure(title=_clip(name, 80) or "Figure", image=data_url, caption=None)


async def _file_from_artifact(
    client: httpx.AsyncClient, artifact_id: str, name: str, content_type: str, size: int
) -> ScienceFile:
    """A non-image artifact as a downloadable file: inline it as a data URL when small enough, else
    surface just its name/size (the UI shows it without an embedded payload)."""
    download: str | None = None
    if 0 < size <= _MAX_FILE_BYTES:
        got = await _fetch_artifact(client, artifact_id)
        if got is not None:
            content, _real_ct = got
            if content and len(content) <= _MAX_FILE_BYTES:
                # The artifact bytes are untrusted (agent-generated). Label the download
                # ``octet-stream`` so a browser always SAVES it and never renders it inline — a
                # ``text/html`` / ``image/svg+xml`` artifact can't execute from an <a download>.
                b64 = base64.b64encode(content).decode("ascii")
                download = f"data:application/octet-stream;base64,{b64}"
    return ScienceFile(
        name=_clip(name, 80) or "artifact",
        content_type=content_type or "application/octet-stream",
        size_bytes=size,
        download=download,
    )


def _int_size(raw: Any) -> int:
    """A safe non-negative int for a daemon-reported ``size_bytes``. JSON permits ``NaN`` /
    ``Infinity`` (``json.loads`` parses them) and ``int(nan)`` raises — so admit only finite, real
    numbers; the ``bool`` special-case avoids ``True``→1. Anything else → 0."""
    if isinstance(raw, bool):
        return 0
    if isinstance(raw, int):
        return max(0, raw)
    if isinstance(raw, float) and math.isfinite(raw):
        return max(0, int(raw))
    return 0


async def _new_artifact_figures(
    client: httpx.AsyncClient, frame_id: str, seen: set[str]
) -> list[ScienceFigure]:
    """Image artifacts on ``frame_id`` not yet streamed (mutates ``seen`` by artifact id). Powers
    the live 'render' steps so a figure previews the moment the run saves it. Bounded by
    ``_MAX_FIGURES`` total streamed so a frame reporting many artifacts can't flood the stream."""
    fresh: list[ScienceFigure] = []
    for art in await _list_frame_artifacts(client, frame_id):
        if len(seen) >= _MAX_FIGURES:
            break
        aid = str(art.get("id") or "")
        content_type = str(art.get("content_type") or "").lower()
        if not aid or aid in seen or not content_type.startswith("image/"):
            continue
        fig = await _figure_from_artifact(client, aid, str(art.get("filename") or "figure"))
        if fig is not None:
            seen.add(aid)
            fresh.append(fig)
    return fresh


async def _collect_artifacts(
    client: httpx.AsyncClient, frame: dict[str, Any]
) -> tuple[list[ScienceFigure], list[ScienceFile]]:
    """The authoritative figures + files for the terminal session, from the daemon's artifact API
    (root frame + sub-agent frames). Falls back to the inline-frame walker for any image the API
    didn't surface (older daemons / inline shapes). Best-effort: failures just yield fewer items."""
    figures: list[ScienceFigure] = []
    files: list[ScienceFile] = []
    fig_ids: set[str] = set()
    file_ids: set[str] = set()
    for fid in _artifact_frame_ids(frame):
        for art in await _list_frame_artifacts(client, fid):
            aid = str(art.get("id") or "")
            if not aid:
                continue
            content_type = str(art.get("content_type") or "").lower()
            name = str(art.get("filename") or "artifact")
            size = _int_size(art.get("size_bytes"))
            if content_type.startswith("image/"):
                if aid in fig_ids or len(figures) >= _MAX_FIGURES:
                    continue
                fig = await _figure_from_artifact(client, aid, name)
                if fig is not None:
                    fig_ids.add(aid)
                    figures.append(fig)
            elif aid not in file_ids and len(files) < _MAX_FILES:
                file_ids.add(aid)
                files.append(await _file_from_artifact(client, aid, name, content_type, size))

    # Fallback: any image inlined in the frame that the artifact API didn't surface.
    if len(figures) < _MAX_FIGURES:
        have = {_fig_key(f.image) for f in figures}
        for fig in _inline_figures(frame):
            if len(figures) >= _MAX_FIGURES:
                break
            key = _fig_key(fig.image)
            if key not in have:
                have.add(key)
                figures.append(fig)
    return figures, files


# --- simulated: a deterministic, self-contained preview of a Claude Science run ----------------


async def _run_simulated(
    task: str,
    url: str,
    status: Literal["simulated", "unreachable", "error"],
    note: str,
    step_delay: float,
) -> AsyncIterator[ScienceStep | ScienceSession]:
    """A staged, deterministic run — same task always yields the same steps + result, so demos are
    stable but varied by task. Each step carries an inline SVG frame, so the panel looks real with
    no daemon at all. The numbers are illustrative, never presented as measured science."""
    flavor = _flavor(task)
    plan = [
        ("navigate", f"Opened the Claude Science workbench ({url})", "Workbench"),
        ("type", "Typed the task into the coordinating agent's composer", "Compose"),
        ("submit", "Sent the task to the generalist coordinating agent", "Dispatch"),
        ("plan", "Coordinating agent decomposed the task and spawned sub-agents", "Plan"),
        ("connect", f"Sub-agent queried {flavor['db']}", flavor["db"]),
        ("compute", f"Dispatched {flavor['method']} on Modal (GPU)", flavor["method"]),
        ("review", "Reviewer agent verified citations and figures against the code", "Review"),
        ("render", f"Rendered {flavor['artifact']}", "Result"),
    ]
    steps: list[ScienceStep] = []
    for i, (action, detail, badge) in enumerate(plan, start=1):
        step = ScienceStep(
            index=i,
            action=action,
            detail=detail,
            screenshot=_frame_svg(badge, detail, subtle=(action in ("plan", "review"))),
        )
        steps.append(step)
        yield step
        if step_delay > 0:
            await asyncio.sleep(step_delay)

    yield ScienceSession(
        task=task,
        status=status,
        url=url,
        model=None,
        steps=steps,
        result_title=_result_title(task),
        result_summary=flavor["summary"],
        metrics=_result_metrics(task),
        note=note,
    )


def _flavor(task: str) -> dict[str, str]:
    """Pick a plausible database / method / artifact / summary from the task's keywords."""
    q = task.lower()
    if any(k in q for k in ("fold", "structure", "alphafold", "openfold", "plddt")):
        return {
            "db": "UniProt + PDB",
            "method": "OpenFold3",
            "artifact": "the predicted 3D structure (interactive viewer)",
            "summary": "Predicted the fold; high confidence across the core and the target pocket.",
        }
    if any(k in q for k in ("dock", "bind", "compound", "ligand", "inhibitor", "chembl")):
        return {
            "db": "ChEMBL + PDB",
            "method": "Boltz-2 docking",
            "artifact": "the top poses in the binding pocket",
            "summary": "Docked the fragment library; several candidates clear the ΔG threshold.",
        }
    if any(k in q for k in ("blast", "homolog", "sequence", "align", "evolution")):
        return {
            "db": "UniProt (MMseqs2)",
            "method": "Evo 2",
            "artifact": "the homolog alignment and conservation track",
            "summary": "Found structural homologs sharing the functional groove (>40% identity).",
        }
    if any(k in q for k in ("variant", "pathogen", "mutation", "clinvar", "snp")):
        return {
            "db": "ClinVar + gnomAD",
            "method": "Evo 2 variant effect",
            "artifact": "the variant effect table",
            "summary": "Scored the variants; a subset is predicted likely-pathogenic.",
        }
    if any(k in q for k in ("express", "rna-seq", "rna seq", "geo", "differential", "transcript")):
        return {
            "db": "GEO + Reactome",
            "method": "a differential-expression pipeline",
            "artifact": "the DE volcano plot and pathway enrichment",
            "summary": "Ran DE analysis; several pathways are significantly enriched.",
        }
    return {
        "db": "UniProt + Reactome",
        "method": "the analysis pipeline",
        "artifact": "the result figures and a reproducibility report",
        "summary": "Ran the analysis end-to-end and traced every figure back to its source code.",
    }


def _result_title(task: str) -> str:
    return f"Claude Science · {_clip(task, 48) or 'analysis'}"


def _result_metrics(task: str) -> list[ScienceMetric]:
    """Deterministic, illustrative metrics seeded by the task (stable across repeat demos). Used by
    the *simulated* path only — the live path reports real run stats (see :func:`_api_metrics`)."""
    seed = sum(ord(c) for c in task) or 1
    q = task.lower()
    if any(k in q for k in ("fold", "structure", "plddt", "openfold")):
        return [
            ScienceMetric(label="mean pLDDT", value=f"{78 + seed % 18}.4"),
            ScienceMetric(label="pocket pLDDT", value=f"{80 + seed % 16}.1"),
            ScienceMetric(label="runtime", value="2m 10s · Modal A100"),
        ]
    if any(k in q for k in ("dock", "bind", "compound", "ligand", "chembl")):
        return [
            ScienceMetric(label="best ΔG", value=f"-{6 + seed % 4}.{seed % 10} kcal/mol"),
            ScienceMetric(label="hits (ΔG < -7)", value=f"{4 + seed % 16} / 240"),
            ScienceMetric(label="runtime", value="3m 41s · Modal A100"),
        ]
    if any(k in q for k in ("variant", "pathogen", "clinvar", "mutation")):
        return [
            ScienceMetric(label="likely-pathogenic", value=str(seed % 6)),
            ScienceMetric(label="variants scored", value=str(120 + seed % 80)),
            ScienceMetric(label="databases", value="ClinVar · gnomAD"),
        ]
    return [
        ScienceMetric(label="sub-agents", value=str(2 + seed % 4)),
        ScienceMetric(label="databases", value=str(2 + seed % 3)),
        ScienceMetric(label="citations checked", value=str(6 + seed % 20)),
    ]


def _clip(text: str, n: int = 60) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _frame_svg(badge: str, caption: str, *, subtle: bool) -> str:
    """A small self-contained SVG 'screenshot' of the Claude Science window at one step.

    Warm palette to match the Claymore UI. Returned as a base64 ``data:`` URL so it embeds inline in
    the chat with no asset host (and survives being persisted in the local chat store)."""
    accent = "#6f7268" if subtle else "#3f7d5c"
    badge_e = _xml_escape(_clip(badge, 22))
    cap_e = _xml_escape(_clip(caption, 66))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" '
        f'viewBox="0 0 640 400" font-family="Inter, system-ui, sans-serif">'
        f'<rect width="640" height="400" rx="14" fill="#f4f2ec"/>'
        f'<rect x="0" y="0" width="640" height="46" rx="14" fill="#e9e6dd"/>'
        f'<rect x="0" y="32" width="640" height="14" fill="#e9e6dd"/>'
        f'<circle cx="24" cy="23" r="6" fill="#dcae9a"/>'
        f'<circle cx="44" cy="23" r="6" fill="#e6d3a3"/>'
        f'<circle cx="64" cy="23" r="6" fill="#b6cbb2"/>'
        f'<text x="96" y="28" font-size="14" fill="#6f7268">Claude Science — localhost:8765</text>'
        f'<rect x="20" y="66" width="600" height="66" rx="12" fill="#ffffff" stroke="#e4e1d7"/>'
        f'<circle cx="52" cy="99" r="16" fill="{accent}"/>'
        f'<text x="52" y="104" font-size="15" fill="#ffffff" text-anchor="middle">CS</text>'
        f'<text x="82" y="94" font-size="15" fill="#1c1d18" font-weight="600">{badge_e}</text>'
        f'<text x="82" y="116" font-size="13" fill="#6f7268">{cap_e}</text>'
        f'<rect x="20" y="150" width="380" height="230" rx="12" fill="#ffffff" stroke="#e4e1d7"/>'
        f'<rect x="40" y="176" width="150" height="12" rx="6" fill="{accent}" opacity="0.85"/>'
        f'<rect x="40" y="202" width="330" height="9" rx="4" fill="#d8d5cb"/>'
        f'<rect x="40" y="222" width="300" height="9" rx="4" fill="#d8d5cb"/>'
        f'<rect x="40" y="242" width="322" height="9" rx="4" fill="#d8d5cb"/>'
        f'<rect x="40" y="272" width="120" height="34" rx="8" fill="{accent}"/>'
        f'<text x="100" y="294" font-size="13" fill="#ffffff" text-anchor="middle">Running…</text>'
        f'<rect x="416" y="150" width="204" height="230" rx="12" fill="#ffffff" stroke="#e4e1d7"/>'
        f'<text x="436" y="180" font-size="12" fill="#6f7268">AGENTS</text>'
        f'<circle cx="442" cy="208" r="5" fill="{accent}"/>'
        f'<text x="456" y="213" font-size="12" fill="#1c1d18">coordinator</text>'
        f'<circle cx="442" cy="236" r="5" fill="#9cc0a4"/>'
        f'<text x="456" y="241" font-size="12" fill="#1c1d18">sub-agent</text>'
        f'<circle cx="442" cy="264" r="5" fill="#dca059"/>'
        f'<text x="456" y="269" font-size="12" fill="#1c1d18">reviewer</text>'
        f'<rect x="436" y="300" width="164" height="56" rx="8" fill="#f4f2ec"/>'
        f'<text x="448" y="324" font-size="11" fill="#6f7268">60+ databases · Modal GPU</text>'
        f'<text x="448" y="342" font-size="11" fill="#6f7268">BioNeMo · reproducible</text>'
        f"</svg>"
    )
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")

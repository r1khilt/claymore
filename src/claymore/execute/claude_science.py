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
import ipaddress
import os
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal

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


class _ScienceUnavailable(Exception):
    """The local daemon is reachable but we couldn't sign in / start / read a run — degrade to a
    labelled preview rather than raise into the caller."""


class ScienceMetric(BaseModel):
    """One labelled figure in the session result (e.g. ``cost -> $0.42``)."""

    label: str
    value: str


class ScienceStep(BaseModel):
    """One observed step of Claude Science working — an action + a rendered frame of the result.

    ``screenshot`` is a self-contained ``data:`` URL (an inline SVG frame) so the web client can
    render it with no extra fetch or asset host — same contract in live and simulated modes.
    """

    index: int
    action: str
    detail: str
    screenshot: str | None = None


class ScienceSession(BaseModel):
    """The whole recorded run: what was asked, how it ran, the ordered steps, and the result.

    ``status`` tells the UI (and the human) whether this was a real drive of Claude Science
    (``completed``) or a preview (``simulated`` / ``unreachable`` / ``error``) — we never dress a
    simulation, or an incomplete run, up as a real result (CLAUDE.md hard rule 1: no fabricated
    grounding).
    """

    task: str
    status: Literal["completed", "simulated", "unreachable", "error"]
    url: str
    model: str | None = None
    steps: list[ScienceStep]
    result_title: str
    result_summary: str
    metrics: list[ScienceMetric] = []
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

        def step(action: str, detail: str, badge: str, *, subtle: bool = False) -> ScienceStep:
            s = ScienceStep(
                index=len(steps) + 1,
                action=action,
                detail=detail,
                screenshot=_frame_svg(badge, detail, subtle=subtle),
            )
            steps.append(s)
            return s

        yield step("connect", "Signed in to the local Claude Science daemon", "Sign in")

        project_id = await _pick_project(client, settings)
        frame_id = await _create_run(client, url, project_id, task, settings)
        yield step("submit", "Dispatched the task to the coordinating agent", "Dispatch")

        last_desc: str | None = None
        resolved: set[str] = set()
        elapsed = 0.0
        frame: dict[str, Any] = {}
        while True:
            frame = await _get_frame(client, frame_id)
            status = str(frame.get("status") or "").lower()

            # Answer any gate the run parks on so it proceeds unattended (see _resolve_pending):
            # a question -> let Claude Science's agent decide; on-host code execution -> allow;
            # an external install/data/egress gate -> deny, keeping the whole run on localhost.
            pending = _pending_requests(frame)
            fresh = [p for p in pending if _stable_key(p) and _stable_key(p) not in resolved]
            if fresh:
                res = await _resolve_pending(client, url, frame_id, fresh)
                resolved.update(res.keys)
                if res.answered:
                    yield step(
                        "gate",
                        "Claude Science asked how to proceed — letting it continue with its "
                        "recommended approach",
                        "Question",
                        subtle=True,
                    )
                if res.allowed:
                    yield step(
                        "gate",
                        f"Approved {res.allowed} on-host code-execution step(s)",
                        "Execute",
                        subtle=True,
                    )
                if res.denied:
                    yield step(
                        "gate",
                        f"Declined {res.denied} external request(s) — kept the run on localhost",
                        "Gate",
                        subtle=True,
                    )

            desc = str(frame.get("status_description") or "").strip()
            if desc and desc != last_desc:
                last_desc = desc
                yield step("work", desc, _badge(desc))

            if status in _TERMINAL_OK or status in _TERMINAL_BAD:
                break
            if elapsed >= timeout_s:
                yield _timeout_session(task, url, settings, frame, steps)
                return

            await asyncio.sleep(poll)
            elapsed += poll

        yield _api_session(task, url, settings, frame, steps)


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
    allowed: int = 0
    denied: int = 0


async def _resolve_pending(
    client: httpx.AsyncClient, url: str, frame_id: str, pending: list[dict[str, Any]]
) -> _Resolution:
    """Answer each pending gate so the run proceeds unattended, per Claymore's policy (which encodes
    the user's two standing rules — "let Claude Science execute code" and "don't escape localhost"):

    * ``kind == "ask"`` (an interactive question) → ``decide_for_me``: hand the choice back to
      Claude Science's own agent (its recommended path). We never guess a scientific choice.
    * ``kind`` starting ``local_`` (on-host sandbox code execution, e.g. ``local_exec``) →
      ``allow``: this IS "let it execute code", and it never leaves the machine.
    * anything else (external package install / data download / contact-email egress) → ``deny``:
      keep the whole run on localhost.

    Parked requests are addressed by ``tool_id`` (``requestId`` is rejected once a request parks);
    live ones by ``requestId``.
    """
    responses: list[dict[str, Any]] = []
    out = _Resolution()
    for req in pending:
        response, category = _pending_response(req)
        if response is None:
            continue
        responses.append(response)
        out.keys.append(_stable_key(req))
        if category == "ask":
            out.answered += 1
        elif category == "allow":
            out.allowed += 1
        else:
            out.denied += 1
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


def _pending_response(req: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """The resolve-input response for one pending request, plus a category label
    (``ask`` | ``allow`` | ``deny`` | ``skip``). Pure (no I/O) so the policy is unit-testable.

    Policy: a question -> ``decide_for_me``; on-host code execution (``local_*``) -> ``allow``;
    everything else (external install/data/egress) -> ``deny``. A request with no addressable id is
    skipped (``None``)."""
    ref_key, ref_val = _pending_ref(req)
    if not ref_val:
        return None, "skip"
    kind = str(req.get("kind") or "").lower()
    if kind == "ask":
        return {ref_key: ref_val, "answers": {}, "action": "decide_for_me"}, "ask"
    if kind.startswith("local_"):
        return {ref_key: ref_val, "approved": True, "action": "allow"}, "allow"
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


def _api_session(
    task: str, url: str, settings: Settings, frame: dict[str, Any], steps: list[ScienceStep]
) -> ScienceSession:
    """Build the terminal session from a finished frame — completed only if the run actually
    completed; otherwise a labelled error (never a fabricated success)."""
    ok = str(frame.get("status") or "").lower() in _TERMINAL_OK
    out = frame.get("output_data")
    response = (out.get("response") or "").strip() if isinstance(out, dict) else ""
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
        note=note,
    )


def _timeout_session(
    task: str, url: str, settings: Settings, frame: dict[str, Any], steps: list[ScienceStep]
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

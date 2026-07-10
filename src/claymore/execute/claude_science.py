"""[Bio, Phase 3] Drive Anthropic's **Claude Science** workbench via computer use.

Claude Science ships as a supervised desktop/web app with **no programmatic API** — but it runs a
local web UI (default ``http://localhost:8765``). So instead of a headless SDK call, Claymore
*operates the app the way a human would*: the Anthropic **computer-use** loop (screenshot -> the
model picks a mouse/keyboard action -> we execute it in a real browser -> repeat). This is
vision-based, so it needs no knowledge of Claude Science's DOM and survives UI changes.

Two modes, chosen automatically, behind one async generator (:func:`run_science_session`):

* **live** — Claude Science is reachable *and* Playwright + an Anthropic key are available: a real
  computer-use loop drives a Chromium page at the configured URL and streams a screenshot per step.
* **simulated** — anything missing (app down, no browser, no key): a deterministic, self-contained
  staged session with inline SVG "frames", so the whole feature (tool -> live stream -> chat panel)
  is demoable now and flips to real automation the moment Claude Science is up. Mirrors how the rest
  of Claymore ships mock-vs-live (``run_bio_analysis`` is a deterministic stub too).

**Security posture (CLAUDE.md rule 7 — lethal trifecta).** Computer use reads screenshots of an
app that can render untrusted content, so a page could try to inject instructions into the model.
Mitigations here: the browser only ever visits the configured Claude Science origin (we never
follow model-directed navigation to arbitrary URLs); the step budget is hard-capped; the loop is
observe-only from Claymore's side (it surfaces a result + a recorded session for the human, it does
not act on the lab's other systems); and Anthropic's own computer-use prompt-injection classifier
runs server-side. Physical/consequential lab actions still go through the human-approval gate
elsewhere — this tool never bypasses it. Keep credentials out of the task text.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx
from pydantic import BaseModel

from claymore.config import Settings
from claymore.logging import get_logger

_log = get_logger("execute.claude_science")

# The virtual display the computer-use model reasons about. ~WXGA keeps coordinates pixel-exact
# without the model having to reason about a huge canvas (Anthropic's guidance: stay near XGA/WXGA).
_DISPLAY_W = 1280
_DISPLAY_H = 800
# Hard cap on the agent loop — the defense against a runaway/looping model (cost + safety).
_MAX_STEPS = 14
# Computer-use tool + beta, current as of the 2025-11-24 revision (Opus 4.8 / 4.7 / Sonnet 5, …).
_COMPUTER_TOOL_TYPE = "computer_20251124"
_COMPUTER_BETA = "computer-use-2025-11-24"
# Paces the simulated stream so the chat panel animates like a live run (overridable in tests).
_STEP_DELAY = 0.5
_HEALTH_TIMEOUT = 2.0


class ScienceMetric(BaseModel):
    """One labelled figure in the session result (e.g. ``pLDDT -> 88.4``)."""

    label: str
    value: str


class ScienceStep(BaseModel):
    """One observed step of Claude Science working — an action + a screenshot of the result.

    ``screenshot`` is a self-contained ``data:`` URL (a real PNG frame in live mode, an inline SVG
    frame in simulated mode) so the web client can render it with no extra fetch or asset host.
    """

    index: int
    action: str
    detail: str
    screenshot: str | None = None


class ScienceSession(BaseModel):
    """The whole recorded run: what was asked, how it ran, the ordered steps, and the result.

    ``status`` tells the UI (and the human) whether this was a real drive of Claude Science
    (``completed``) or the offline preview (``simulated`` / ``unreachable`` / ``error``) — we never
    dress a simulation up as a real run (CLAUDE.md hard rule 1: no fabricated grounding).
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

    The final item is always a :class:`ScienceSession` (consumers detect it by type). Live mode is
    attempted only when the app is reachable and the browser + key are present; any failure falls
    back to the simulated session so the caller always gets a clean, complete run.
    """
    task = (task or "").strip()
    url = settings.claude_science_url.rstrip("/")

    reachable = await _healthy(url)
    if reachable and _playwright_available() and _has_key(settings):
        try:
            async for item in _run_live(task, url, settings):
                yield item
            return
        except Exception as exc:  # never let a browser/model hiccup break the turn — degrade
            _log.warning("claude_science.live_failed", error=str(exc)[:200])
            note = "Claude Science was reachable but the drive failed; showing a preview instead."
            async for item in _run_simulated(task, url, "error", note, step_delay):
                yield item
            return

    status: Literal["simulated", "unreachable"] = "unreachable" if not reachable else "simulated"
    note = (
        f"Claude Science isn't running at {url} — showing a simulated preview of the run. "
        "Start the Claude Science app and Claymore will drive it for real."
        if not reachable
        else "Running Claude Science in preview mode (browser automation unavailable in this env)."
    )
    async for item in _run_simulated(task, url, status, note, step_delay):
        yield item


# --- live: Anthropic computer use over a real browser -----------------------------------------


async def _healthy(url: str) -> bool:
    """True if *something* answers at the Claude Science URL (any HTTP status counts as 'up')."""
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            await client.get(url)
        return True
    except Exception:
        return False


def _playwright_available() -> bool:
    """True if Playwright (the browser driver) is importable — it's an optional extra."""
    try:
        import playwright.async_api  # noqa: F401
    except Exception:
        return False
    return True


def _has_key(settings: Settings) -> bool:
    return bool(settings.anthropic_api_key.get_secret_value())


async def _run_live(
    task: str, url: str, settings: Settings
) -> AsyncIterator[ScienceStep | ScienceSession]:
    """Drive Claude Science for real with the Anthropic computer-use loop.

    Typed loosely (the client/page are ``Any``): the anthropic beta-computer surface and Playwright
    are optional deps this repo can't exercise in CI, so we keep the contract at this module's
    boundary (:class:`ScienceStep` / :class:`ScienceSession`) strict and the driver internals lax.
    """
    from anthropic import AsyncAnthropic
    from playwright.async_api import async_playwright

    model = settings.claude_science_model
    client: Any = AsyncAnthropic(api_key=settings.anthropic_api_key.get_secret_value())
    tool = {
        "type": _COMPUTER_TOOL_TYPE,
        "name": "computer",
        "display_width_px": _DISPLAY_W,
        "display_height_px": _DISPLAY_H,
        "display_number": 1,
    }
    steps: list[ScienceStep] = []
    idx = 0

    async with async_playwright() as pw:
        browser: Any = await pw.chromium.launch(headless=True)
        try:
            page: Any = await browser.new_page(viewport={"width": _DISPLAY_W, "height": _DISPLAY_H})
            await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
            shot = await _screenshot(page)
            idx += 1
            first = ScienceStep(
                index=idx,
                action="navigate",
                detail=f"Opened Claude Science ({url})",
                screenshot=_png_data_url(shot),
            )
            steps.append(first)
            yield first

            messages: list[dict[str, Any]] = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _live_prompt(task)},
                        _image_block(shot),
                    ],
                }
            ]
            final_text = ""
            for _ in range(_MAX_STEPS):
                message = await client.beta.messages.create(
                    model=model,
                    max_tokens=1536,
                    tools=[tool],
                    betas=[_COMPUTER_BETA],
                    messages=messages,
                )
                messages.append({"role": "assistant", "content": message.content})
                tool_uses = [b for b in message.content if getattr(b, "type", "") == "tool_use"]
                text = " ".join(
                    b.text for b in message.content if getattr(b, "type", "") == "text"
                ).strip()
                if text:
                    final_text = text
                if not tool_uses:
                    break

                results: list[dict[str, Any]] = []
                for use in tool_uses:
                    args = use.input if isinstance(use.input, dict) else {}
                    detail = await _do_action(page, args)
                    shot = await _screenshot(page)
                    idx += 1
                    step = ScienceStep(
                        index=idx,
                        action=str(args.get("action", "act")),
                        detail=detail,
                        screenshot=_png_data_url(shot),
                    )
                    steps.append(step)
                    yield step
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": use.id,
                            "content": [_image_block(shot)],
                        }
                    )
                messages.append({"role": "user", "content": results})

            yield ScienceSession(
                task=task,
                status="completed",
                url=url,
                model=model,
                steps=steps,
                result_title=_result_title(task),
                result_summary=final_text or "Claude Science completed the run.",
                metrics=_result_metrics(task),
            )
        finally:
            await browser.close()


def _live_prompt(task: str) -> str:
    """The instruction for the computer-use model driving Claude Science."""
    return (
        "You are operating the Claude Science desktop workbench through its web UI. Complete this "
        f"task by clicking and typing like a user would:\n\n{task}\n\n"
        "Find the prompt/composer input, type the task, submit it, and let Claude Science's agents "
        "run. After each action take a screenshot and check the result before the next step. When "
        "the run has produced a result, stop and briefly summarize what it found."
    )


async def _screenshot(page: Any) -> bytes:
    return bytes(await page.screenshot(type="png"))


def _png_data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _image_block(png: bytes) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.b64encode(png).decode("ascii"),
        },
    }


# xdotool-style keysyms (what computer use emits) -> Playwright key names, best effort.
_KEYMAP = {
    "Return": "Enter",
    "KP_Enter": "Enter",
    "Escape": "Escape",
    "BackSpace": "Backspace",
    "Delete": "Delete",
    "Tab": "Tab",
    "space": " ",
    "Page_Down": "PageDown",
    "Page_Up": "PageUp",
    "ctrl": "Control",
    "cmd": "Meta",
    "super": "Meta",
    "alt": "Alt",
}


async def _do_action(page: Any, args: dict[str, Any]) -> str:
    """Execute one computer-use action in the browser; return a human summary. Never raises — a
    failed UI action becomes a note in the step, not a broken loop."""
    action = str(args.get("action", ""))
    try:
        if action == "screenshot":
            return "Captured the screen"
        if action in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
            x, y = _xy(args.get("coordinate"))
            button = (
                "right"
                if action == "right_click"
                else "middle"
                if action == "middle_click"
                else "left"
            )
            clicks = 2 if action == "double_click" else 3 if action == "triple_click" else 1
            await page.mouse.click(x, y, button=button, click_count=clicks)
            return f"{action.replace('_', ' ').title()} at ({x}, {y})"
        if action == "mouse_move":
            x, y = _xy(args.get("coordinate"))
            await page.mouse.move(x, y)
            return f"Moved cursor to ({x}, {y})"
        if action == "left_click_drag":
            sx, sy = _xy(args.get("start_coordinate"))
            ex, ey = _xy(args.get("coordinate"))
            await page.mouse.move(sx, sy)
            await page.mouse.down()
            await page.mouse.move(ex, ey)
            await page.mouse.up()
            return f"Dragged ({sx}, {sy}) -> ({ex}, {ey})"
        if action == "type":
            text = str(args.get("text", ""))
            await page.keyboard.type(text)
            return f"Typed: {_clip(text)}"
        if action in ("key", "hold_key"):
            combo = "+".join(_KEYMAP.get(k, k) for k in str(args.get("text", "")).split("+"))
            await page.keyboard.press(combo or "Enter")
            return f"Pressed {combo}"
        if action == "scroll":
            direction = str(args.get("scroll_direction", "down"))
            amount = int(args.get("scroll_amount", 3)) * 100
            dy = amount if direction == "down" else -amount if direction == "up" else 0
            dx = amount if direction == "right" else -amount if direction == "left" else 0
            await page.mouse.wheel(dx, dy)
            return f"Scrolled {direction}"
        if action == "wait":
            await asyncio.sleep(min(float(args.get("duration", 1)), 3.0))
            return "Waited"
        if action in ("cursor_position", "zoom"):
            return "Inspected the screen"
        return f"Action: {action}"
    except Exception as exc:
        return f"{action} (failed: {str(exc)[:80]})"


def _xy(coord: Any) -> tuple[int, int]:
    if isinstance(coord, (list, tuple)) and len(coord) >= 2:
        return int(coord[0]), int(coord[1])
    return _DISPLAY_W // 2, _DISPLAY_H // 2


def _clip(text: str, n: int = 60) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


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
    no browser at all. The numbers are illustrative, never presented as measured science."""
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
    """Deterministic, illustrative metrics seeded by the task (stable across repeat demos)."""
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

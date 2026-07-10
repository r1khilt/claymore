# Claymore — web UI

An airy, glassy dashboard whose Composer is a **Claude agent**: it streams its thoughts and
tool calls — search lab memory, ingest sources, run a bio-analysis, or generate an Opentrons
run — and returns **cited** answers, analysis cards, or a live robot scene. Over a subtle nature
backdrop and an animated [paper-shaders](https://github.com/paper-design/shaders) mesh gradient,
built to look like a clean YC product.

## Run it

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

Requires Node ≥ 20 (built on Node 26). Nothing else — it ships with realistic **demo data**, so
it looks alive with zero backend.

## What's here

| Zone | What it is |
|---|---|
| **Left rail** | Quiet nav — Ask · Memory · Approvals · Connectors · Proactive — plus a **Recent chats** list and a **profile notch** at the bottom that opens the **account popover**. Collapsible (both rails are), with the state remembered across sessions |
| **Composer** | The main chat is an agent. It streams a **thought + tool-call trace** (search memory → decide → ingest / analyze / compose a run) and returns cited answers, **bio-analysis** metric cards, or a **bespoke robot scene** composed from the full Opentrons catalog. If a step needs an instrument off the deck (centrifuge, microscope, sequencer), it still builds a **general lab-robot** scene + a **PyLabRobot** movement script rather than refusing. Every conversation is **saved locally** and restorable from Recent. |
| **Bench** | A deck workspace that renders **any** scene the agent authors: a detailed **2D deck** (moving gantry, per-reagent liquids with volume menisci, depleting tip racks, gripper labware moves, and live modules — thermocycler lid, heater-shaker, temperature, magnetic block, absorbance reader) with a **2D / 3D toggle** (react-three-fiber), the generated **Python** (Opentrons Protocol API *or* PyLabRobot), a step log, and a human-gated physical run. Airy, subtle, floating controls. |
| **Right rail** | Recreated **Slack · iMessage · Notion · Gmail · GitHub** feeds showing the key messages the agent reasons on, each with an *in-memory* cue |
| **Account popover** | Click your name (bottom of the left rail) for a small popover — **Usage** (real token counts + per-tool call counts recorded from live runs), **Customize** (name / lab / avatar upload / accent), **API keys** (Anthropic + Voyage, used to run the live Composer), **Preferences** (reasoning level + live/debug toggles), and **Data** (where the local file lives, export JSON, clear). Each opens as a compact modal, not a page. |
| **Memory / Approvals / Connectors / Proactive** | Full mocked views for the rest of the product surface |

## Local store — "keep it all local"

Recent chats, Settings, profile, usage metrics and the error log persist to a **single JSON file in
your own folder** — `~/.claymore/local.json` (override with `CLAYMORE_LOCAL_DIR`), git-ignored, never
pushed. It is written by the backend `src/claymore/local_store.py` behind the ungated `/api/local/*`
routes; the browser client is `src/lib/local.ts`, which **falls back to `localStorage`** when no
backend is running so the mock demo still remembers everything across refreshes. Token/tool-call
**metrics are real** — recorded server-side when a live agent run finishes — so they read as zero
until you actually run the Composer live. This is a local dev/demo convenience, **not** the Postgres
app-state store, and holds no multi-tenant scoping — one user, one machine.

## Mock vs. live

- **Default (mock):** the Composer runs `src/lib/agent.ts` — a stand-in that emits the *same
  event stream* the backend produces (thoughts, tool calls, answers, protocols, analyses), so the
  whole agent experience is alive with **zero backend or keys**. Answers come from the coherent
  `src/lib/mockData.ts` corpus (the CBX2 allosteric thread), matching the real `Reply`/`Citation`
  shapes. Robot scenes come from `generateScene()` (`src/lib/protocol.ts`), composed from the full
  supported-hardware catalog in `src/lib/hardware.ts`; the backend mirrors both field-for-field so
  live and mock render identical scenes.
- **Live:** the backend exposes a streaming **`POST /api/agent`** (SSE) running the real Claude
  tool-loop (`src/claymore/agent/agent_loop.py`), plus the single-shot `POST /api/ask`. The client
  is already wired: `AskView` calls `agentStream()` (`src/lib/agent.ts`), which reads the live SSE
  when `VITE_CLAYMORE_LIVE=1` and the mock otherwise — same event contract either way. Enable with
  `WEB_API_ENABLED=true` and an Anthropic key from **either** `ANTHROPIC_API_KEY` **or** the one you
  paste into **Settings → API keys** (stored in the local file, never logged). The live loop honors
  the Settings **reasoning level** (loop/token budget) and, on finish, records this turn's real
  token usage + tool-call counts into the local metrics store.

## Stack

Vite · React 19 · TypeScript (strict) · Tailwind v4 · `@paper-design/shaders-react` ·
Framer Motion · `three` / `@react-three/fiber` (Bench 3D, lazy-loaded) · Instrument Serif + Inter ·
shadcn-style primitives. Path alias `@/*` → `src/*`.

```
src/
├── App.tsx                 # shell: background + sidebar + view + source rail
├── lib/{types,api,mockData,sources,utils}.ts
├── lib/local.ts            # local store client (/api/local/* + localStorage fallback): chats, settings, metrics
├── lib/agent.ts            # mock agent engine + live SSE reader; agentStream() picks by VITE_CLAYMORE_LIVE
├── lib/hardware.ts         # full Opentrons catalog (pipettes/labware/modules/accessories/liquids) + capabilityGap
├── lib/deck.ts             # OT-2 / Flex / Generic deck geometry + well coordinates
├── lib/protocol.ts         # scene model + run derivation + generateScene() (Opentrons + PyLabRobot fallback)
├── components/
│   ├── Background.tsx       # nature horizon + paper-shaders mesh + cream wash
│   ├── Sidebar.tsx
│   ├── ask/                 # AskView (Composer), AgentTurn (trace), AskBox, AnswerView, ProtocolCard…
│   ├── bench/              # Opentrons: Deck2D, Deck3D (r3f), useRunPlayer, RunLog, CodePanel
│   ├── sources/            # SourceRail + per-platform SourcePanel
│   └── views/              # Memory, Approvals, Connectors, Proactive, Settings
└── components/brand/logos.tsx  # inline Slack/Gmail/GitHub/Notion/iMessage marks
```

Swap the backdrop photo via `HORIZON` in `Background.tsx` (options in `public/backgrounds/`).

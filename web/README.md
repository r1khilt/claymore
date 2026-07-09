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
| **Left rail** | Quiet nav — Ask · Memory · Approvals · Connectors · Proactive |
| **Composer** | The main chat is an agent. It streams a **thought + tool-call trace** (search memory → decide → ingest / analyze / generate a run) and returns cited answers, **bio-analysis** metric cards, or a generated Opentrons scene. Refuses anything Opentrons can't do (see the hardware catalog). |
| **Bench** | An Opentrons workspace that renders **any** generated protocol dynamically: an animated **2D deck** (moving pipette, filling wells, modules like thermocycler / heater-shaker / magnetic) with a **2D / 3D toggle** (react-three-fiber), the generated **Python Protocol API**, a live run log, and a human-gated physical run |
| **Right rail** | Recreated **Slack · iMessage · Notion · Gmail · GitHub** feeds showing the key messages the agent reasons on, each with an *in-memory* cue |
| **Memory / Approvals / Connectors / Proactive** | Full mocked views for the rest of the product surface |

## Mock vs. live

- **Default (mock):** the Composer runs `src/lib/agent.ts` — a stand-in that emits the *same
  event stream* the backend produces (thoughts, tool calls, answers, protocols, analyses), so the
  whole agent experience is alive with **zero backend or keys**. Answers come from the coherent
  `src/lib/mockData.ts` corpus (the CBX2 allosteric thread), matching the real `Reply`/`Citation`
  shapes. Robot scenes come from `generateScene()` (`src/lib/protocol.ts`), validated against the
  supported-hardware catalog in `src/lib/hardware.ts`.
- **Live:** the backend exposes a streaming **`POST /api/agent`** (SSE) running the real Claude
  tool-loop (`src/claymore/agent/agent_loop.py`), plus the single-shot `POST /api/ask`. Enable
  with `WEB_API_ENABLED=true` + an `ANTHROPIC_API_KEY`. Point the client at it by switching the
  event source in `AskView` from `runAgent` to the SSE stream (same event contract).

## Stack

Vite · React 19 · TypeScript (strict) · Tailwind v4 · `@paper-design/shaders-react` ·
Framer Motion · `three` / `@react-three/fiber` (Bench 3D, lazy-loaded) · Instrument Serif + Inter ·
shadcn-style primitives. Path alias `@/*` → `src/*`.

```
src/
├── App.tsx                 # shell: background + sidebar + view + source rail
├── lib/{types,api,mockData,sources,utils}.ts
├── lib/agent.ts            # mock agent engine (event stream = /api/agent contract)
├── lib/hardware.ts         # Opentrons supported-hardware catalog (pipettes/labware/modules)
├── lib/protocol.ts         # deck model + geometry + generateScene() (catalog-validated)
├── components/
│   ├── Background.tsx       # nature horizon + paper-shaders mesh + cream wash
│   ├── Sidebar.tsx
│   ├── ask/                 # AskView (Composer), AgentTurn (trace), AskBox, AnswerView, ProtocolCard…
│   ├── bench/              # Opentrons: Deck2D, Deck3D (r3f), useRunPlayer, RunLog, CodePanel
│   ├── sources/            # SourceRail + per-platform SourcePanel
│   └── views/              # Memory, Approvals, Connectors, Proactive
└── components/brand/logos.tsx  # inline Slack/Gmail/GitHub/Notion/iMessage marks
```

Swap the backdrop photo via `HORIZON` in `Background.tsx` (options in `public/backgrounds/`).

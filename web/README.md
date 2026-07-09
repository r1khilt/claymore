# Claymore — web UI

An airy, glassy dashboard for Claymore's **Ask** experience: text a question, get a
**cited, attributed** answer with source provenance — over a subtle nature backdrop and an
animated [paper-shaders](https://github.com/paper-design/shaders) mesh gradient. Built to look
like a clean YC product.

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
| **Center (Ask)** | The hero: `claymore` wordmark + one glass ask-box → a cited answer thread with **provenance cards** and a **"you just approve"** action card |
| **Bench** | An Opentrons OT-2 workspace: ask for a protocol and watch it run — an animated **2D deck** (moving pipette, wells filling) with a **2D / 3D toggle** (react-three-fiber), the generated **Python Protocol API**, a live run log, and a human-gated physical run |
| **Right rail** | Recreated **Slack · iMessage · Notion · Gmail · GitHub** feeds showing the key messages the agent reasons on, each with an *in-memory* cue |
| **Memory / Approvals / Connectors / Proactive** | Full mocked views for the rest of the product surface |

## Mock vs. live (the real Ask loop)

Data flows through one swap-point, `src/lib/api.ts`:

- **Default (mock):** answers come from `src/lib/mockData.ts` — a coherent lab corpus (the CBX2
  allosteric thread) matching the backend's real `Reply` / `Citation` shapes.
- **Live:** set `VITE_CLAYMORE_LIVE=1` and the UI POSTs to `/api/ask`, proxied to the FastAPI
  backend on `:8000` (see `vite.config.ts`). That endpoint (`src/claymore/api/routes/ask.py`)
  runs the **actual** attributed retrieval + grounded-answer loop.

  Enable it on the backend with `WEB_API_ENABLED=true` (off by default — it has no per-message
  auth), then ingest some memory (`POST /admin/ingest`) so there's something to answer from.

  ```bash
  VITE_CLAYMORE_LIVE=1 npm run dev
  ```

## Stack

Vite · React 19 · TypeScript (strict) · Tailwind v4 · `@paper-design/shaders-react` ·
Framer Motion · `three` / `@react-three/fiber` (Bench 3D, lazy-loaded) · Instrument Serif + Inter ·
shadcn-style primitives. Path alias `@/*` → `src/*`.

```
src/
├── App.tsx                 # shell: background + sidebar + view + source rail
├── lib/{types,api,mockData,sources,utils}.ts
├── lib/protocol.ts          # Opentrons deck model + geometry + canned protocols
├── components/
│   ├── Background.tsx       # nature horizon + paper-shaders mesh + cream wash
│   ├── Sidebar.tsx
│   ├── ask/                 # AskView, AskBox, AnswerView, CitationCard, PendingActionCard, ProtocolCard
│   ├── bench/              # Opentrons: Deck2D, Deck3D (r3f), useRunPlayer, RunLog, CodePanel
│   ├── sources/            # SourceRail + per-platform SourcePanel
│   └── views/              # Memory, Approvals, Connectors, Proactive
└── components/brand/logos.tsx  # inline Slack/Gmail/GitHub/Notion/iMessage marks
```

Swap the backdrop photo via `HORIZON` in `Background.tsx` (options in `public/backgrounds/`).

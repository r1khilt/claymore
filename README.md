# Claymore

A lab-memory agent for research labs, plus a **bio layer**:
ingest a lab's scattered memory → **ask** and get an *attributed* answer → **act**
(you just approve) → serve the lab's coding agents over **MCP** → **reach out** proactively
→ and **run the experiment** (compute first, wet-lab later, gated).

> Read [`CLAUDE.md`](./CLAUDE.md) first — it's the source of truth (what we're building, the
> hard rules, the decided stack). Then [`WORKPLAN.md`](./WORKPLAN.md) for the two-person split,
> [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the roadmap + risk register, and
> [`SECURITY.md`](./SECURITY.md) / [`ENGINEERING_GUIDELINES.md`](./ENGINEERING_GUIDELINES.md)
> before touching anything that ingests, acts, runs code, or holds a secret.

## What works today (2026-07-09)

The end-to-end **ask** path is **live**: Slack/Gmail/Notion/GitHub ingest through Composio into a
Graphiti/FalkorDB temporal graph (identity-resolved, provenance-tagged, Haiku extraction),
answered with cited, attributed facts — or an honest no-answer when the graph can't ground
one — over both a Telegram bot (@ClaymoreLabs_bot) and a **web dashboard** (`web/`): a
Composer chat, a Bench workspace, and live source panels (Slack/Gmail/Notion/iMessage).
Write-backs, MCP-out, and proactive triggers are built and tested behind flags.

The **bio execute layer** has landed its first agent-run work, streamed live into the
Composer (each degrades to a self-contained demo when its backend isn't configured, so the
whole path is usable without keys and flips to real when they're present):

- **Bench** — the agent authors an Opentrons scene from the full OT-2/Flex catalog (deck +
  choreography + generated Protocol-API / PyLabRobot code), rendered in 2D/3D and dry-run
  simulated. Nothing runs on a robot.
- **ML analysis** (`execute/ml_analysis.py`) — trains a model on a dataset the lab *actually
  referenced in memory* (resolved + attributed, never fabricated) and returns a grounded
  verdict (supported / refuted / inconclusive) with inline charts.
- **Claude Science** (`execute/claude_science.py`) — drives Anthropic's Claude Science
  workbench at `localhost:8765` via **computer use** (screenshot → action → repeat), streaming
  each step into a collapsible "watch Claymore work" panel; previews a simulated run when the
  app isn't up.

Compute-sandbox and wet-lab execution remain gated and later-phase.

## Quickstart

```bash
git clone https://github.com/r1khilt/claymore.git && cd claymore
cp .env.example .env            # fill ANTHROPIC_API_KEY, VOYAGE_API_KEY, COMPOSIO_API_KEY
python -m venv .venv && source .venv/bin/activate
make install                    # pip install -e ".[dev,...]"
make up                         # falkordb + postgres + redis
make check                      # ruff + mypy --strict + pytest  (green = safe to merge)
make run                        # FastAPI on :8000  (GET /healthz)
```

In a second terminal, start the live dashboard:

```bash
cd web
npm install
VITE_CLAYMORE_LIVE=1 npm run dev   # http://localhost:5173
```

Open **Connectors**, choose **Connect** on Slack, Gmail, Notion, or GitHub, and approve that
provider in the Composio popup. The card changes to **Connected** when OAuth returns; choose
**Sync now** to import the bounded initial window into attributed lab memory. Later syncs are
incremental, and connection/sync state survives an API restart. Composio manages the provider
OAuth apps, so the local setup needs only `COMPOSIO_API_KEY`—`COMPOSIO_USER_ID` is optional and
defaults to `WEB_USER_ID`. OAuth consent itself cannot be replaced by an environment key.

To wire the optional Telegram bot, expose :8000 (ngrok), set `PUBLIC_BASE_URL`, register the
Telegram webhook with `setWebhook(url=.../webhooks/telegram,
secret_token=$TELEGRAM_WEBHOOK_SECRET)`, and enroll users via
`TELEGRAM_ENROLLMENTS=<telegram_id>:<lab>:<user>`.

Normalized episodes, connector checkpoints, and the Graphiti provenance/visibility sidecar are
kept in the private local SQLite state file under `CLAYMORE_LOCAL_DIR` (default `~/.claymore`), so
connections, deduplication, attributed retrieval, and incremental sync survive API restarts.

## Layout (see `CLAUDE.md §4`)

```
src/claymore/
├── config.py        # env-driven settings + feature flags
├── ports.py         # the 7 vendor-swap interfaces (hexagonal seams)
├── api/             # FastAPI: webhooks (Telegram/WhatsApp), admin ingest, runtime wiring
├── ingest/          # [Pipes]  sources -> Episode -> durable log
├── memory/          # [Brain]  Graphiti graph, identity, reconcile, retrieval
├── agent/           # [Brain]  Claude tool-loop, conversation, temporal
├── actions/         # [Pipes]  Composio write-backs behind the approval gate
├── messaging/       # [Pipes]  Telegram (live) / WhatsApp via Twilio (paid-Twilio labs)
├── mcp_server/      # [Brain]  expose lab memory over MCP
├── proactive/       # briefs, never-tested-idea nudges, digests
├── execute/         # [Brain]  ml_analysis + claude_science (live); compute/wet-lab (gated, later)
├── auth/            # per-user/per-lab scoping, RBAC
└── audit.py         # immutable audit trail

web/                 # Vite/React dashboard: Composer chat, Bench (2D/3D deck), source panels
```

## The frozen contracts

Two people build in parallel by depending only on stable *shapes*, not each other's code
(`WORKPLAN.md §2`). The contracts, defined here in the foundation:

| Contract | File |
|---|---|
| `Episode` (ingest → memory) | `ingest/normalize.py` |
| Scientific ontology (entities + fact edges) | `memory/ontology.py` |
| The 7 vendor ports | `ports.py` |
| Agent entrypoint (`handle`) | `agent/__init__.py` |
| Approval gate (`PendingAction`) | `actions/approvals.py` |
| User / lab / scope model | `auth/models.py` |

Changing a contract is a two-person decision — announce it.

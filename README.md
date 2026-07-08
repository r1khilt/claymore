# Claymore

A **Shepherd-equivalent lab-memory agent** for research labs, plus a **bio layer**:
ingest a lab's scattered memory → **ask** and get an *attributed* answer → **act**
(you just approve) → serve the lab's coding agents over **MCP** → **reach out** proactively
→ and **run the experiment** (compute first, wet-lab later, gated).

> Read [`CLAUDE.md`](./CLAUDE.md) first — it's the source of truth (what we're building, the
> hard rules, the decided stack). Then [`WORKPLAN.md`](./WORKPLAN.md) for the two-person split,
> [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the roadmap + risk register, and
> [`SECURITY.md`](./SECURITY.md) / [`ENGINEERING_GUIDELINES.md`](./ENGINEERING_GUIDELINES.md)
> before touching anything that ingests, acts, runs code, or holds a secret.

## Quickstart

```bash
git clone https://github.com/r1khilt/claymore.git && cd claymore
cp .env.example .env            # fill in Phase-0 keys: ANTHROPIC, VOYAGE, TELEGRAM
python -m venv .venv && source .venv/bin/activate
make install                    # pip install -e ".[dev,...]"
make up                         # falkordb + postgres + redis
make check                      # ruff + mypy --strict + pytest  (green = safe to merge)
make run                        # FastAPI on :8000  (GET /healthz)
```

## Layout (see `CLAUDE.md §4`)

```
src/claymore/
├── config.py        # env-driven settings + feature flags
├── ports.py         # the 7 vendor-swap interfaces (hexagonal seams)
├── ingest/          # [Pipes]  sources -> Episode -> durable log
├── memory/          # [Brain]  Graphiti graph, identity, reconcile, retrieval
├── agent/           # [Brain]  Claude tool-loop, conversation, temporal
├── actions/         # [Pipes]  Composio write-backs behind the approval gate
├── messaging/       # [Pipes]  Telegram (dev) / Twilio SMS (prod)
├── mcp_server/      # [Brain]  expose lab memory over MCP
├── proactive/       # briefs, never-tested-idea nudges, digests
├── execute/         # [Brain]  science agent, compute, wet-lab (later, gated)
├── auth/            # per-user/per-lab scoping, RBAC
└── audit.py         # immutable audit trail
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

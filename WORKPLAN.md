# Claymore — Work Plan & Two-Person Split

> How two people build Claymore concurrently without colliding on files, duplicating features, or building things out of order. Grounded in `CLAUDE.md §4` (repo layout), `BUILD_PLAN.md §6/§9` (roadmap + kickoff), `ENGINEERING_GUIDELINES.md §1` (hexagonal seams), and the R1–R14 register. Read `CLAUDE.md` first; this is the "who does what, in what order" layer on top.

**Owners are locked:**
- **P1 = Rikhil — the *Pipes*:** ingestion, connectors, messaging, infra (`ingest/` + `messaging/` + `api/` + `actions/`).
- **P2 = Rikhin — the *Brain*:** memory, agent, eval (the attribution/eval work the docs call "in your wheelhouse") + the bio differentiator (`memory/` + `agent/` + `evals/` + `mcp_server/` + `execute/`).

`P1`/`P2` are used as shorthand in the tables and diagram below; read P1 = Rikhil, P2 = Rikhin throughout.

> **Note on "step one":** the design docs (`CLAUDE.md`, `BUILD_PLAN.md`, this file, …) already exist — that phase is done. They are the *input* to the build, not a build task. **Step 0 (done):** the docs now live at the repo root (moved out of `files/`) so every coding session reads `./CLAUDE.md`; a `.gitignore` is in place. Remaining setup: commit + push the docs so both collaborators share them (the GitHub repo `r1khilt/claymore` started with only LICENSE + README). Then Step 1 (§1 below) is the first code.

---

## 0. The one rule that prevents 90% of collisions

**Own modules, not features.** Every collision ("we both edited that file", "you rewrote my function") comes from two people touching the same file. Claymore's module layout (`CLAUDE.md §4`) and its ports-and-adapters seams (`ENGINEERING_GUIDELINES.md §1`) are *designed* so each vendor/concern lives behind one narrow interface in one directory. If P1 lives in `ingest/` + `messaging/` and P2 lives in `memory/` + `agent/`, you almost never touch the same file.

The only files you both depend on are the **contracts** (§2). Those get built **first, together, and frozen.** After that, changing a contract is a deliberate, announced act — not a casual edit.

---

## 1. STEP ONE (do this before anything is split)

**Step one is NOT "P1 builds ingestion while P2 builds memory."** That collides immediately, because both need the Episode schema, the config, the ports, and the DB stack to exist first. Step one is:

**Stand up the Phase 0 scaffold as a single "foundation" PR, and freeze the shared contracts in it — before any parallel feature work.** In parallel (non-code), kick off the START-NOW human track.

Concretely:

- **Step 0 (done):** the design docs now sit at the **build repo root** (moved out of `files/`) so every session reads `./CLAUDE.md`; a `.gitignore` excludes `graphify-out/`, `.env`, and OS junk. You did not *write* CLAUDE.md — it already existed; this was placement. What's left is to **commit + push** the docs so both of you share them.
- **P1 → the foundation PR** (`BUILD_PLAN.md §9`, steps 1–2). One branch, merged fast, everything blocks on it:
  - `pyproject.toml` (Python 3.12, deps), `docker-compose.yml` (falkordb + postgres + redis), `.env.example` (from `CREDENTIALS.md`), `README.md` quickstart (`git clone → cp .env.example .env → docker compose up`).
  - `src/claymore/config.py` (Pydantic `BaseSettings`, env-driven).
  - **The frozen contracts** (§2 below): the `Episode` schema, the ontology entity/edge types, the port interfaces (ABCs), the user/auth model, the agent entrypoint, and the approval-gate interface. Empty implementations are fine — the *shapes* are what must be stable.
  - FastAPI app skeleton + `audit.py` skeleton.
- **P2 (or a non-technical helper) → START-NOW human track in parallel** (`CREDENTIALS.md` top): apply for the **EIN**, stand up public **privacy-policy + ToS** HTTPS pages, start **Twilio A2P 10DLC** brand+campaign, upgrade **Granola to Business**, and grab the Phase-0 keys (Anthropic, Voyage, a Telegram bot token via @BotFather, local Docker DBs). None of this blocks code, but the 10DLC review is 10–15 days — start the clock.
- **Also P2 (while foundation is in flight):** pair-review the contracts (P2 depends on them most), and do a throwaway spike to de-risk Graphiti → FalkorDB locally.

**Once the foundation PR is merged, and only then, split into the two tracks.** This is the single most important sequencing decision — resist the urge to start features on day 1.

---

## 2. The frozen contracts (the only shared-edit files)

These are the single-source-of-truth shapes both tracks import. Build them in the foundation PR, then treat any change as a two-person decision (announce, both re-sync). `ENGINEERING_GUIDELINES.md §1`: "the `Episode` schema and the scientific ontology are defined once and imported everywhere."

| Contract | File | Why it decouples the tracks |
|---|---|---|
| **`Episode` schema** | `ingest/normalize.py` | The handoff from Pipes → Brain. P1 *emits* Episodes, P2 *consumes* them. Fields: `{source_platform, source_id, author, timestamp, text, refs[], visibility, is_untrusted}`. `author` is the canonical person (post-identity) or `unknown`; `visibility` comes from the source ACL (R13). Freeze this and both can work against fixtures without waiting on each other. |
| **Ontology types** | `memory/ontology.py` | Entity + fact-edge Pydantic types (`Person, Protein, …`; `SUGGESTED, SUPERSEDES, …` with `valid_from/valid_to, extraction_confidence, visibility`). P2 owns after freeze. |
| **Port interfaces (ABCs)** | `ports.py` (or per-module `interfaces.py`) | `MemoryStore, ConnectorHub, ComputeBackend, LLM, Embedder, MessagingChannel, SecretsProvider`. Domain code imports the interface, never the SDK — so an adapter can be built/tested in isolation. |
| **Agent entrypoint** | `agent/__init__.py` (e.g. `handle(user, text) -> Reply`) | The handoff from Pipes → Brain on the query side. P1's messaging calls it; P2 implements it. P1 ships a stub (echo) so messaging works before the agent exists. |
| **Approval gate** | `actions/approvals.py` (`PendingAction`, `request(action)`) | The handoff for write-backs. P2's agent *proposes* a `PendingAction`; P1's messaging renders it and captures ✅/❌; `actions/` executes on approve. Contract = the `PendingAction` shape + the request/resolve calls. |
| **User / auth model** | `auth/` (user, `group_id`, phone→user map) | P1's messaging authenticates the human (enrolled allowlist, `SECURITY.md §8`); P2's retrieval enforces scope (`group_id` + `visibility`, R13). Shared shape, enforced in two places. |

If you change a contract, both people stop, agree, and re-sync — a contract change is the one thing that ripples across both trees.

---

## 3. File-level ownership map (after the foundation is merged)

`[F]` = foundation/shared (frozen in step one). `[P1]` = Pipes owner. `[P2]` = Brain owner. This is your anti-collision artifact — stay in your lane.

```
src/claymore/
├── config.py                 [F]
├── audit.py                  [F skeleton → each track writes records from its own calls]
├── ports.py                  [F]  (all 7 port ABCs)
├── api/                      [P1] webhook receivers, SMS inbound (dashboard later)
├── ingest/
│   ├── normalize.py          [F contract] → [P1] impl   (Episode schema)
│   ├── episodes.py           [P1] durable append-only Episode log, Postgres (R14)
│   ├── composio/             [P1] Slack, Gmail, GitHub, Notion, Drive, Docs
│   ├── granola.py            [P1]
│   └── codelogs.py           [P1]
├── memory/
│   ├── ontology.py           [F contract] → [P2] impl
│   ├── graph.py              [P2] Graphiti wrapper (MemoryStore adapter)
│   ├── identity.py           [P2] cross-source identity resolution (R11)
│   ├── reconcile.py          [P2] cross-episode SUPERSEDES/CONTRADICTS + extraction-quality (R12)
│   └── retrieval.py          [P2] attributed, visibility-scoped hybrid search (R13)
├── agent/
│   ├── tools.py              [P2]
│   ├── router.py             [P2] model routing + tool loop
│   ├── conversation.py       [P2] session state + follow-up coreference
│   ├── temporal.py           [P2] "last week" → bi-temporal window
│   └── prompts/              [P2]
├── actions/                  [P1] Composio write-backs (reply/issue/page/link)
│   └── approvals.py          [F contract → P1 impl; P2 agent calls it]
├── mcp_server/               [P2] expose lab memory (FastMCP)  — Phase 2.5
├── proactive/                [P2 logic + P1 delivery]          — Phase 2.5
├── execute/                  [P2, Phase 3+]  science agent, compute, workflows, opentrons
├── messaging/                [P1] telegram.py, twilio_sms.py (MessagingChannel adapter)
├── auth/                     [F model → P2 retrieval-enforce + P1 message-authenticate]
└── evals/                    [P2] attribution eval harness (build EARLY, Phase 1)
```

Adapter ownership: `MemoryStore`/`Embedder`/`LLM` → P2 · `ConnectorHub`/`MessagingChannel` → P1 · `SecretsProvider` → F · `ComputeBackend` → P2 (Phase 3).

**The two tracks touch at exactly three seams:** the Episode (ingest→memory), the agent entrypoint (messaging→agent), and the approval gate (agent→actions→messaging). All three are frozen contracts. Everywhere else you're in separate files.

---

## 4. Dependency order — what must be done before what

Parallel ≠ unordered. This is the DAG. Respect the gates; don't start a downstream node before its upstream is done.

```
G0  Foundation PR (contracts + scaffold + docker stack)      ← blocks EVERYTHING
      │
      ├──────────────► TRACK P1 (Pipes)          ├──────────────► TRACK P2 (Brain)
      │                                          │
      │  episodes.py (durable log, R14)          │  ontology impl
      │        │                                 │        │
      │  ConnectorHub + Slack backfill           │  identity.py (R11)  ← BEFORE graph-write
      │        │                                 │        │              (facts must store
      │  populate Episode.visibility (ACL)       │  graph.py extraction   canonical persons
      │        │                                 │        │              from day 1 — retrofit
      │  more connectors (Gmail/GitHub/…)        │  reconcile.py (R12) ← AFTER graph-write
      │        │                                 │        │              (needs facts to compare)
      │  messaging (Telegram) → agent stub       │  retrieval.py (R13, visibility filter)
      │                                          │        │
      │                                          │  evals/ harness ← AFTER retrieval works
      └───────────────────┬──────────────────────┘
                          ▼
             G1  Phase 0 EXIT: hand-made Episode → attributed facts in graph;
                 Telegram message round-trips through the (stub) agent
                          ▼
             Phase 2: wire real agent ↔ real messaging; hybrid retrieval cited answers
                          ▼
             G2  Retrieval grounded + eval'd (faithfulness ≥0.85, hallucinated-source ≈0)
                          │   ← DO NOT build write-backs before this gate (R1, R2)
                          ▼
             Phase 2.5: Act (P1 + approval) ‖ MCP-out (P2) ‖ Proactive (P2 logic + P1 delivery)
                          ▼
             Phase 3: compute execution (P2)  →  Phase 4: wet-lab, opt-in + gated (P2)
```

**Hard ordering rules (the "don't start X before Y" cheatsheet):**

| Don't start… | …until… | Why (source) |
|---|---|---|
| Any feature branch | the foundation PR is merged | shared contracts must exist first (§1) |
| Storing facts in the graph | `identity.py` resolves authors | facts must store canonical persons; retrofitting identity onto a populated graph is a rewrite (R11) |
| `reconcile.py` (SUPERSEDES/CONTRADICTS) | basic extraction writes facts | it compares a new fact against existing ones (R12) |
| Retrieval visibility filter being meaningful | connectors populate `Episode.visibility` | policy needs the source ACL (R13) — build to the frozen field, integrate when a real connector lands |
| Filling eval ground truth | retrieval returns cited answers | you eval what retrieval produces (R2) |
| **Act / write-backs** | **retrieval is grounded + eval'd (G2)** | attributed retrieval before actions on top of it — the whole ordering thesis (R1, `CLAUDE.md §7`) |
| MCP-out, Proactive | the base ask-loop works | they read the same memory (Phase 2.5) |
| Compute execution (Phase 3) | the base is demoed to a real lab | lead with retrieval, not execution (R1) |
| Any Opentrons / wet-lab code | Phase 4, opt-in lab, `simulate`+approval gate exists | safety/liability (hard rule 2, R3) — `BUILD_PLAN §9`: don't touch it yet |

---

## 5. How the two tracks work in parallel without waiting on each other

The contracts let each side develop against a stand-in for the other:

- **P2 (Brain) doesn't wait for P1's connectors.** Phase 0 already ingests *one hand-made Episode*. P2 builds identity → graph → reconcile → retrieval against a **fixture corpus of Episodes** (JSON files matching the frozen schema). This fixture doubles as the eval seed corpus (`evals/`, R2). P2 is fully productive before a single real connector exists.
- **P1 (Pipes) doesn't wait for P2's agent.** Messaging calls the agent entrypoint, which P1 stubs as an echo until P2's `agent/` lands. P1 builds connectors → Episode log → messaging end-to-end against the stub.
- **They meet at integration points**, not continuously: when a real connector lands, P2 points retrieval at real Episodes; when the real agent lands, P1 swaps the stub. Each meet is a small, planned integration PR with an integration test.

**Shared fixture corpus = the integration contract made concrete.** Seed a small synthetic lab corpus (known ground truth: who said what, when, what was superseded, mixed visibility). P2 uses it for evals; P1 uses it to validate a connector's output matches the Episode shape. One artifact, both sides.

---

## 6. Collaboration hygiene (keep CI green, keep the demo alive)

- **Feature flags default-off** (`INGEST_*`, `ACT_ENABLED`, `MCP_OUT_ENABLED`, `EXEC_COMPUTE_ENABLED`, `EXEC_WETLAB_ENABLED`, from `.env.example` / R1). A half-built layer behind a flag can't break the other person's demo.
- **Small PRs, one concern each, reviewed by the other** (`ENGINEERING_GUIDELINES.md §5` DoD). Every PR: `ruff` + `mypy --strict` + tests + eval floor green before merge.
- **Branch per feature; never commit to `main` directly.** Rebase often so the trees don't drift.
- **Contract changes are announced.** A PR that edits a `[F]` file (Episode, ontology, a port, the agent entrypoint, approval shape) gets a heads-up + both review — it's the only thing that ripples across both trees.
- **Daily 10-minute sync:** only two questions — "did any contract change?" and "are we blocked on the other's seam?" Everything else you can do heads-down.
- **`docker compose up` is the shared truth:** identical local stack (falkordb + postgres + redis) for both, so "works on my machine" divergence can't happen.
- **Audit + provenance from day 0** (`ENGINEERING_GUIDELINES.md §3`): both tracks write audit records and thread correlation IDs — it's how you debug the async pipeline across the seam later.

---

## 7. Concrete first week (day-by-day)

**Day 1**
- P1: foundation PR — scaffold + docker-compose + config + the frozen contracts (empty impls OK). Aim to merge EOD or Day-2 AM.
- P2: pair-review the contracts; spike Graphiti→FalkorDB locally; kick off the START-NOW human track (EIN, privacy/ToS pages, Twilio brand+campaign, Granola Business, Telegram bot token).

**Day 2 (foundation merged → split)**
- P1: Telegram echo bot + FastAPI `/webhook` + SMS-inbound skeleton (verify a message round-trips → half of Phase-0 exit); start `episodes.py` durable log on Postgres.
- P2: `memory/graph.py` Graphiti wrapper on FalkorDB; ingest one hand-made Episode → attributed facts → query back with provenance (other half of Phase-0 exit); start `identity.py`.

**Day 3–5**
- P1: first Composio connector (Slack) backfill → incremental → correct provenance; populate `Episode.visibility` from the source ACL; wire messaging → agent-stub.
- P2: finish `identity.py` (roster seed + merge-behind-confidence-gate); extraction into Graphiti storing canonical persons; `reconcile.py` for SUPERSEDES/CONTRADICTS; `retrieval.py` hybrid + visibility filter; stand up `evals/` skeleton + seed a tiny ground-truth corpus.

**End of week 1 gate (Phase 0 exit, both):** a hand-made Episode shows up as attributed facts in the graph, and a Telegram message round-trips through the agent. Then you're into Phase 1 proper (fan out connectors on P1, harden memory + eval on P2).

---

## 8. TL;DR

1. **Step one = one foundation PR** (scaffold + frozen contracts) before any split; START-NOW human track in parallel. Don't start features on day 1.
2. **Own modules, not features:** P1 (Rikhil) = `ingest/` + `messaging/` + `api/` + `actions/`; P2 (Rikhin) = `memory/` + `agent/` + `evals/` + `mcp_server/` + `execute/`. You touch the same file only at three frozen seams (Episode, agent entrypoint, approval gate).
3. **Respect the DAG:** identity before graph-write; reconcile after; retrieval grounded + eval'd **before** any write-backs; base demoed before compute; wet-lab last and gated.
4. **Decouple with stand-ins** (fixture Episodes for P2, agent stub for P1) so neither waits on the other; integrate at planned seams.
5. **Flags off, small reviewed PRs, green CI, daily contract check.** Contract edits are a two-person decision.

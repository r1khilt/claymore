# Claymore — Complete Documentation Bundle

*Single-file bundle of the Claymore design docs, in reading order. Each is also available as its own file at the repo root. `CREDENTIALS.md` is intentionally kept OUT of this public bundle (and gitignored) — it's the accounts/keys checklist; ask a maintainer for it.*

**Contents**
1. `CLAUDE.md` — entry point: what Claymore is, hard rules, stack, repo layout, current phase, doc index
2. `BUILD_PLAN.md` — full validated build plan, architecture, component decisions, roadmap, risk register (R1–R14), open decisions
3. `ENGINEERING_GUIDELINES.md` — how to build it: modularity, DRY, performance/memory/scalability, debugging, definition of done
4. `SECURITY.md` — threat model + hardening: lethal-trifecta architecture, prompt injection, MCP, sandboxes, secrets, infra
5. `RISKS_AND_MITIGATIONS.md` — concrete current playbook per risk (R1–R14)

*(`CREDENTIALS.md` — every account/key needed — is kept local-only; not in this public repo.)*



<!-- ============================================================ -->
<!-- FILE: CLAUDE.md -->
<!-- ============================================================ -->

# CLAUDE.md — Claymore

> Read this first, every session. It is the source of truth for what Claymore is, how it's built, and what the current guardrails are. If something here conflicts with older code comments, this file wins. Keep it updated as decisions change.

---

## 1. What Claymore is (two layers)

Claymore = a **full Shepherd-equivalent base layer** for research labs **+ a bio layer on top.** Build both. The base layer is intentionally a faithful reimplementation of askshepherd.ai's plumbing (this is a hackathon build and that's the point — replicate the base, then go beyond it). The bio layer is what makes it Claymore.

**Base layer (Shepherd-equivalent — build it fully, don't skimp):**
1. **Ingest** a lab's scattered memory — Slack, Gmail, GitHub, Notion, Google Docs/Drive, Granola meeting notes, Claude Code / Codex session logs — into a **temporal knowledge graph with full provenance.** No tagging required; everything said/committed/written becomes memory.
2. **Ask** (pull-based, on demand — this is the primary mode): text a question and get an **attributed** answer pulled from wherever it's buried, no matter how old or which source. This spans, at least:
   - **Person/idea recall:** *"what did Lucas suggest last week about the X protein?"*
   - **Meeting recall:** *"what came up in last week's roundup?"* / *"what did we decide in the Tuesday sync?"* (Granola transcripts)
   - **Doc recall:** *"there was a random doc a couple months ago about the assay buffer — what did it say?"* (Notion/Drive/Docs, semantic + temporal search)
   - **Status/history:** *"did we ever test the Y hypothesis?"* / *"what's the latest on the docking pipeline?"*
   - **Follow-ups on any of the above:** *"expand on that idea"* / *"who else touched this?"* / *"what changed since?"*
   Retrieval is hybrid (graph traversal + vector + BM25 + temporal), so it finds things by meaning and by when, not just keyword. Every answer is cited.
3. **Act** ("you just approve"): the agent turns what was said into work — **drafts the Slack/email reply, files the GitHub issue, creates the Notion page, makes the calendar link** — and executes the write-back through Composio after a one-tap human approval.
4. **Serve agents (MCP out):** Claymore exposes its lab memory as an **MCP server** so the lab's own Codex / Claude Code / Cursor sessions can pull lab context ("what did Philip build," "what did we decide about the assay") directly.
5. **Reach out first (proactive):** surfaces things unprompted — briefs before a meeting, "this idea from last week was never tested," standup-style digests.

**Bio layer (the part that's ours):**
6. **Science-native ontology + provenance:** proteins, assays, protocols, hypotheses, experiments, results, instruments are first-class graph entities with reproducibility-grade provenance.
7. **Execute science:** the agent can **expand a retrieved idea into a runnable task and run it.** Computational first: Claymore runs its **own science agent** (Claude Agent SDK + Anthropic's science Agent Skills + MCP connectors, compute on Modal / E2B / lab HPC over SSH; can call BioNeMo workflows, Nextflow pipelines, bioRxiv/Exa). Heavy human-supervised runs escalate into a **Claude Science** session (which also consumes Claymore's memory over MCP). Physical (Opentrons) later, behind a hard human-approval gate. Every result is texted back as a summary and ingested back into memory.

The wedge: *golden ideas die in meetings and docs; Claymore remembers them, acts on them, and can run the experiment.*

Reference product: **askshepherd.ai** ("know everything happening at your company" — ingest → ask → act → MCP → proactive). We replicate that base wholesale and add the bio layer (6–7).

---

## 2. Hard rules (non-negotiable)

1. **Never fabricate attribution.** If the graph doesn't ground "who said X," the agent says it can't find it. A wrong attribution in science is worse than no answer. Every claim the agent returns MUST carry a source (platform + id + timestamp + author). No source → don't assert it. This extends to **identity**: if an episode's author can't be resolved to a known lab person (an unlabeled Granola speaker, an unknown email sender), ingest it as `author=unknown` and surface that — never guess a name. Cross-source identity resolution (Slack handle ↔ email ↔ GitHub login ↔ meeting-speaker label) is a first-class ingest step, not an afterthought (see `memory/identity.py`, `RISKS_AND_MITIGATIONS.md#R11`).
2. **No physical wet-lab execution without an explicit human approval gate.** Agent-generated Opentrons protocols run through `opentrons.simulate` first, the plan + simulation are surfaced to a human, and a physical run only starts on explicit confirmation. This is a safety/liability requirement, not a preference. Never auto-run a physical protocol from a text.
3. **Computational execution runs only in a sandbox** (E2B / Modal), never on the host. Spend-incurring or long jobs require a confirmation step.
4. **Per-user, per-lab data scoping is mandatory.** Lab data is unpublished IP (sometimes clinical). A rotation student must not query a PI's private sources. Enforce scope at retrieval time, not just UI.
5. **Everything is auditable.** Every ingestion, query, and execution writes an immutable audit record (who, what, when, which sources touched).
6. **Extraction cost is real.** Graphiti calls an LLM per ingested episode. Use a cheap model (Haiku/Sonnet) for extraction, reserve the strong model for query-time reasoning. Watch token spend on backfill.
7. **Claymore is a "lethal trifecta" system — treat all ingested content as untrusted.** It has private data + untrusted content + the ability to act, so indirect prompt injection is the top threat. Never let ingested text act as instructions. The extraction agent (reads untrusted content) holds NO action tools; the action agent works only on structured, provenance-tagged facts and every action is human-gated; egress is deny-by-default; the LLM never sees a secret. Full detail in `SECURITY.md` — read it before building any layer that ingests, acts, runs code, holds a secret, or exposes an endpoint.

---

## 3. Stack (decided — don't relitigate without a reason)

| Layer | Choice | Notes |
|---|---|---|
| Core language | **Python 3.12** | bio ecosystem + Opentrons + Graphiti are all Python. |
| API / web | **FastAPI** + Uvicorn | webhook receivers, SMS inbound, dashboard API. |
| Agent | **Anthropic API (Claude)** with tool use | direct SDK, not a heavy framework. Model routing: Haiku/Sonnet for extraction & cheap steps, Opus for query reasoning & planning. |
| Connectors (read) | **Composio** | managed OAuth, per-user creds, 1000+ apps, Anthropic provider pkg. Use for Slack/Gmail/GitHub/Notion/Drive/Docs. |
| Actions (write-back) | **Composio** (same layer, bidirectional) | draft reply, file issue, create Notion page, make calendar link — executed after human approval. This is Shepherd's "you just approve." |
| MCP server (out) | **FastMCP** (Python) | expose lab memory as tools so the lab's Codex/Claude Code/Cursor can query it. Base-layer feature, build it. |
| Custom connectors | Granola REST API; Claude Code / Codex log ingester | see §5. |
| Memory | **Graphiti** (Apache-2.0, self-hosted) on **FalkorDB** | bi-temporal facts + episodic provenance. Neo4j is the conservative fallback. Do NOT use HelixDB for v1 (would mean reimplementing temporal logic). |
| Embeddings | **Voyage** (`voyage-3-large`) | Graphiti hybrid search (graph + vector + BM25). |
| App state / audit | **Postgres** | users, labs, sources, jobs, approvals, audit log. |
| Queue / workers | **Arq** (Redis) for v1 → **Temporal** when execution lands | Temporal gives durable long-running workflows w/ human-in-the-loop signals (approvals). |
| Sci execution (dry-lab) | **Claude Agent SDK (Opus 4.8) + science Agent Skills + MCP + Modal** | This IS the "Claude science environment": Claymore runs its own science agent it can trigger from a text. **E2B** for light/arbitrary sandboxing, **Modal** for real/GPU scientific compute (what Claude Science uses), lab **HPC over SSH** when they have it. Callable workflow backends: **NVIDIA BioNeMo Agent Toolkit** (Evo 2 / Boltz-2 / OpenFold3, harness-agnostic) and **Nextflow/nf-core** for real pipelines. |
| Claude Science | **MCP client of Claymore + human escalation surface** | Claude Science (beta, all paid tiers, Opus 4.8) is a supervised workbench, **NOT a headless API** — don't try to drive it programmatically. Instead: (1) Claymore's MCP server is a tool Claude Science *connects to*; (2) hand heavy "run the full experiment" tasks into a Claude Science session where a human supervises. Watch for a programmatic entry point (1-week-old beta). |
| Wet-lab execution | **Opentrons Python Protocol API** (apiLevel ≥ 2.28) + **HTTP API**; `opentrons.simulate` for dry-run | late phase, gated. |
| Messaging | **Telegram** (dev/pilot, free, instant) → **Twilio SMS** (prod, A2P 10DLC) | optional iMessage via Sendblue/Loop later. |
| Deploy | Fly.io / Railway, containerized | |

---

## 4. Repo layout

```
claymore/
├── CLAUDE.md                  # this file
├── BUILD_PLAN.md              # full plan, roadmap, risks, rationale
├── pyproject.toml
├── docker-compose.yml         # falkordb, postgres, redis for local dev
├── .env.example
├── src/claymore/
│   ├── config.py
│   ├── api/                   # FastAPI: webhooks, sms inbound, dashboard
│   ├── ingest/
│   │   ├── composio/          # Slack, Gmail, GitHub, Notion, Drive, Docs
│   │   ├── granola.py         # public-api.granola.ai/v1
│   │   ├── codelogs.py        # Claude Code / Codex session logs
│   │   ├── normalize.py       # raw source -> Episode
│   │   └── episodes.py        # durable append-only Episode log (Postgres) = replay source of truth (R14)
│   ├── memory/
│   │   ├── graph.py           # Graphiti wrapper
│   │   ├── ontology.py        # scientific entity/edge types (§6)
│   │   ├── identity.py        # cross-source person/entity resolution (R11)
│   │   ├── reconcile.py       # cross-episode supersession/contradiction pass (R12)
│   │   └── retrieval.py       # attributed search (visibility-scoped, R13)
│   ├── agent/
│   │   ├── tools.py           # search_memory, draft_reply, file_issue, create_page,
│   │   │                      #   expand_idea, run_compute, propose_protocol, request_approval...
│   │   ├── router.py          # model routing + tool loop
│   │   ├── conversation.py    # per-user session state + follow-up coreference (Redis)
│   │   ├── temporal.py        # resolve "last week"/"a couple months ago" -> bi-temporal window
│   │   └── prompts/
│   ├── actions/               # BASE LAYER: write-backs via Composio (reply/issue/page/link)
│   │   └── approvals.py       # "you just approve" gate; numbered tokens for SMS, idempotent write-backs
│   ├── mcp_server/            # BASE LAYER: expose lab memory as an MCP server (FastMCP)
│   ├── proactive/             # BASE LAYER: briefs, "never-tested idea" nudges, digests
│   ├── execute/               # BIO LAYER
│   │   ├── science_agent.py   # Claude Agent SDK + science Agent Skills + MCP; the "science env"
│   │   ├── compute.py         # backends: E2B (light), Modal (GPU/real), HPC-over-SSH
│   │   ├── workflows.py       # BioNeMo toolkit (Evo2/Boltz-2/OpenFold3), Nextflow/nf-core
│   │   ├── claude_science.py  # hand-off/escalation into a supervised Claude Science session
│   │   ├── opentrons.py       # protocol gen -> simulate -> (gated) run
│   │   └── approvals.py       # human-in-the-loop gate for physical/spend runs
│   ├── messaging/
│   │   ├── telegram.py
│   │   └── twilio_sms.py
│   ├── auth/                  # per-user/per-lab scoping, RBAC
│   └── audit.py
├── evals/                     # retrieval attribution eval harness (build EARLY)
└── tests/
```

---

## 5. Ingestion facts (baked-in, verified)

- **Composio**: managed OAuth, per-user connected accounts, SDK (`composio` Python) + `@composio/anthropic` provider. Free tier ~1k tool executions/mo. **Gotcha:** Composio-managed OAuth apps now default to **15-min polling** for triggers; for fresher sync you must register your **own OAuth app** per provider. Webhooks are signed — verify `webhook-signature`. **Backfill blows past the free 1k executions fast** — for the hackathon, scope the pilot backfill to a small window (recent history / a few channels), not a lab's full year; upgrade the tier only when a pilot needs it. Dedup + resumable checkpoints mean you never re-pay (R6).
- **Granola**: public REST API — `GET https://public-api.granola.ai/v1/notes` (cursor pagination, `created_after` filter), `GET /v1/notes/{id}?include=transcript`. Auth `Authorization: Bearer grn_...`. **Requires Business plan ($14/user/mo) for personal API; Enterprise ($35) for the team/admin API.** Free (Basic) is capped. There is also a Granola MCP server as an alternative ingestion path.
- **Claude Code / Codex logs**: file-based. Ingest session transcripts/commits as episodes; attribute to the author + repo.
- **iMessage ("Messages" in the pitch)**: **no official API.** Only via a Mac bridge (BlueBubbles) or a paid iMessage-as-API vendor (Sendblue/Loop), gray-area re: Apple ToS. **Deprioritize.** Do not build the core on iMessage ingestion.
- Normalize everything to an **Episode** (`{source, source_id, author, timestamp, text, refs, visibility, is_untrusted}`) before it hits Graphiti. Persist Episodes to a **durable append-only log in Postgres** — the graph is a *derived, rebuildable projection*, so a rebuild never re-hits sources or re-pays extraction (R14).
- **Identity resolution is a first-class ingest step** (`memory/identity.py`): resolve every episode's author/entities to canonical lab people across platforms, seeded from the lab roster at enrollment, LLM-assisted merge for unknowns behind a confidence gate. Granola transcripts are the weakest attribution source (diarization may only give "Speaker 1") — map speakers to meeting attendees where possible, else `author=unknown` and surface it. Never guess (R11).
- Every episode carries a **`visibility` scope** derived from its source object's ACL (channel membership, doc sharing). Facts inherit the *most restrictive* contributing source's visibility; retrieval filters on it (R13).

---

## 6. Scientific ontology (the moat — get this right)

Entity nodes (extend Graphiti's extraction with these types):
`Person, Meeting, Message, Document, CodeCommit, Dataset, Instrument, Reagent, Protocol, Hypothesis, Experiment, Result, Figure` + domain: `Gene, Protein, CellLine, Assay, Compound`.

Fact edges (bi-temporal — carry `valid_from` / `valid_to` + provenance):
`SUGGESTED, DECIDED, RAN, PRODUCED, CONTRADICTS, SUPERSEDES, MENTIONS, AUTHORED_BY, DERIVED_FROM, USES`.

Every edge stores provenance: `source_platform, source_id, timestamp, author, confidence`, plus an `extraction_confidence` (from the cheap extraction model) and a `visibility` scope. This is what makes *"what did Lucas suggest last week, and did we ever test it?"* answerable with a citation and a temporal answer ("suggested Mar 3, superseded Mar 10").

`CONTRADICTS` and `SUPERSEDES` are **not** created at single-episode extraction time — they require comparing a new fact against existing ones. A post-ingest **reconciliation pass** (`memory/reconcile.py`, cheap model) detects supersession/contradiction across episodes and writes those edges with provenance (R12). Retrieval can threshold on `extraction_confidence` and MUST filter on `visibility` (R13). This reconciliation is also what powers the proactive "a decision was just contradicted" trigger.

---

## 7. Current phase

**Phase 0 → 1: scaffold + ingestion + memory.** Full scope is the two-layer system in §1 — nothing is cut. The only thing that's *sequenced* is internal build order, so each layer lands on a working one beneath it:

`ingest+memory → ask → act (write-back) + MCP-out + proactive [= full Shepherd base] → compute execution → wet-lab execution [= bio layer]`.

Get attributed retrieval grounded and eval'd before wiring write-backs on top of it, and demo the base to a real lab before starting Opentrons. This is ordering, not scope reduction — all of §1 ships.

Parallel, non-blocking: Twilio A2P 10DLC registration is in flight (10–15 day carrier review). Until it clears, all messaging dev happens on **Telegram**.

See `BUILD_PLAN.md` for the full milestone breakdown, risk register, and open decisions. See `RISKS_AND_MITIGATIONS.md` for the concrete, current playbook on solving each risk (attribution eval, cost controls, multi-tenant isolation, secrets, SMS gate, wet-lab safety). See `SECURITY.md` for the full threat model and hardening spec (lethal-trifecta architecture, prompt-injection defense, MCP server/client hardening, sandbox isolation, secrets, webhooks, infra) — security is architectural here, not a bolt-on. See `ENGINEERING_GUIDELINES.md` for how to build it: modularity, DRY, performance/memory/scalability, debugging method, and the per-PR definition of done. See `CREDENTIALS.md` for every account/key needed, where to get it, and the just-in-time rules for asking Rikhin (check first, ask by phase, one at a time, validate before continuing).

---

## 8. Working conventions

- Ship the thinnest vertical slice that a real lab member can use. Prefer one working end-to-end path over five half-built connectors.
- Build the **eval harness (`evals/`) in Phase 1**, not later. The killer failure is confident wrong attribution; measure it (LongMemEval-style: temporal, multi-hop, knowledge-update queries against a seeded lab corpus).
- Surface disconfirming evidence in PRs/plans — if a chosen approach is failing on evals or cost, say so early.
- Keep secrets in `.env` / a vault, never in the graph or logs.
- Every new source connector must pass: backfill → incremental sync → correct provenance on a spot-checked episode, before it's "done."



<!-- ============================================================ -->
<!-- FILE: BUILD_PLAN.md -->
<!-- ============================================================ -->

# Claymore — Validated Build Plan

*A full Shepherd-equivalent base for research labs — ingest scattered memory → ask over SMS → act (draft/file/create, you approve) → serve the lab's coding agents via MCP → reach out proactively — plus a bio layer on top: science-native memory with provenance, and the ability to run the experiment (compute first, wet-lab later behind a hard gate).*

---

## 0. TL;DR / decisions up front

- **Two layers, both fully built.** **Base = a faithful askshepherd.ai replica** (ingest → ask → **act** → **MCP-out** → **proactive**) — replicating the base is a stated goal, not something to avoid. **Bio layer = science-native memory + provenance + run-the-experiment**, sitting on top. Nothing is descoped.
- **Build order is the whole ballgame** (ordering, not scope reduction). Sequence: **ingest+memory → ask (attributed) → act + MCP-out + proactive [full base] → computational execution → wet-lab execution [bio].** Each layer lands on a working one beneath it.
- **Bio ontology is the differentiator on top of the base.** Proteins, assays, protocols, hypotheses, results are first-class graph entities; every fact carries who/where/when.
- **Memory layer: Graphiti on FalkorDB.** Bi-temporal facts + episodic provenance are exactly "who said what, when, and is it still true." It beats vector-only memory on the temporal/multi-hop queries this product lives on (~64% vs ~49% on LongMemEval in independent tests). Skip HelixDB for v1.
- **Connectors: Composio** for the OAuth SaaS apps; custom for Granola (has a real REST API now) and code logs. iMessage has no legit API — deprioritize.
- **Messaging: Telegram for dev/pilot, Twilio SMS for prod.** A2P 10DLC carrier registration is a 10–15 day gate needing an EIN + privacy/ToS URLs — start it day 1, don't let it block you.
- **Execution: Claymore runs its own science agent** (Claude Agent SDK + Anthropic science Agent Skills + MCP + Modal/E2B/HPC, calling BioNeMo & Nextflow) — SMS-triggerable. **Claude Science** (new Anthropic workbench) is a supervised app, not a headless API, so use it as an MCP-client of Claymore + a human-escalation surface, not a backend. Wet-lab (Opentrons + `simulate` + human approval) stays late and opt-in.
- **Build the retrieval eval harness in Phase 1.** Confident wrong attribution is the failure that kills trust.

---

## 1. The problem & why now

Research labs leak knowledge. A postdoc floats a sharp hypothesis in a Tuesday meeting; it's in a Granola transcript nobody re-opens. A protocol tweak that fixed a failed assay lives in one Slack thread. The person who knew rotated out. The result: duplicated work, lost ideas, irreproducible "we changed something around then."

Three things now make Claymore buildable that weren't 18 months ago:
- **Managed connectors** (Composio) collapse the OAuth/integration tax across Slack, Gmail, GitHub, Notion, Drive.
- **Temporal knowledge-graph memory** (Graphiti) makes "true as of when, said by whom" a first-class query instead of a similarity guess.
- **Agentic execution sandboxes** (E2B/Modal) + **lab-robot APIs** (Opentrons) make "run it" a real endpoint, not a demo.

The wedge is emotional and concrete: *your lab's golden ideas stop dying in meetings.*

---

## 2. What we are NOT building (scope discipline)

- Not an iMessage-first product (no legit API; universal SMS/Telegram beats it).
- Not an autonomous wet-lab that runs experiments off a text with no human in the loop (unsafe, uninsurable, and most target labs don't have robots).
- Not a literature-search assistant (Scite/Elicit/Web of Science own that; we can *call* them, not rebuild them).

---

## 3. Architecture

```
             ┌─────────────────────────────────────────────────────────┐
  Sources    │  Slack  Gmail  GitHub  Notion  Drive/Docs  Granola  Logs │
             └───────┬───────────────────────────────────┬─────────────┘
                     │  Composio (managed OAuth)          │  custom connectors
                     ▼                                    ▼
             ┌─────────────────────────────────────────────────────────┐
  Ingest     │  normalize → Episode {source,id,author,ts,text,refs}     │
             │  scientific entity/edge extraction (cheap LLM)           │
             └───────────────────────────┬─────────────────────────────┘
                                         ▼
             ┌─────────────────────────────────────────────────────────┐
  Memory     │  Graphiti + FalkorDB  (bi-temporal facts + provenance)   │
             │  hybrid retrieval: graph traversal + vector + BM25       │
             └───────────────────────────┬─────────────────────────────┘
                                         ▼
             ┌─────────────────────────────────────────────────────────┐
  Agent      │  Claude tool-loop  (per-user/per-lab scope at retrieval) │
             │   BASE: search_memory · draft_reply · file_issue ·       │
             │         create_page · make_link · request_approval       │
             │   BIO:  expand_idea · run_compute · propose_protocol      │
             └──┬──────────────┬───────────────┬──────────────┬─────────┘
                ▼              ▼               ▼              ▼
       ┌────────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────────┐
  Out  │ Act        │  │ science agent│  │ wet-lab   │  │ MCP server   │
       │ (Composio  │  │ (Agent SDK + │  │ (Opentrons│  │ OUT →        │
       │ write-back,│  │ skills + MCP;│  │ gen→sim→  │  │ lab's Codex/ │
       │ you approve)│ │ Modal/E2B/HPC│  │ APPROVE→  │  │ Claude Code/ │
       │            │  │ BioNeMo,nf)  │  │ run)      │  │ Cursor / +   │
       │            │  │ ↕ Claude Sci │  │           │  │ Claude Sci   │
       └─────┬──────┘  └──────┬───────┘  └─────┬─────┘  └──────────────┘
             └────────┬───────┴────────────────┘
                      ▼
             ┌─────────────────────────────────────────────────────────┐
  Interface  │  Telegram (dev) / Twilio SMS (prod)                      │
             │  answers · result summaries · PROACTIVE briefs & nudges  │
             └─────────────────────────────────────────────────────────┘

  Cross-cutting: Postgres (state/audit) · Redis+Arq→Temporal (jobs/approvals) · RBAC · audit log
```

---

## 4. Component decisions (with rationale + the alternative you'd otherwise pick)

### 4.1 Memory — **Graphiti on FalkorDB**
- **Why:** The product's core queries are temporal and relational ("last week," "before we switched," "did we ever test it"). Graphiti models every fact as a bi-temporal edge with a validity window and keeps `EpisodicNodes` that point back to the original source text — that IS provenance. Independent LongMemEval numbers put Zep/Graphiti's temporal-KG approach around **63.8%** vs **Mem0** vector+graph around **49.0%** on exactly this kind of query. Graphiti core is **Apache-2.0 and self-hostable** (the full Zep app is not; Community Edition was deprecated — so self-host Graphiti, don't depend on Zep Cloud).
- **Backend:** **FalkorDB** (Redis-based, single container, fast, cheap) for the balance of ops simplicity and multi-tenant concurrency. **Neo4j** = conservative fallback if you need maturity/tooling. **Kuzu** = fine for embedded single-tenant dev, weaker for concurrent prod.
- **Alternative you'd otherwise pick:** Mem0 (easier, SOC2/HIPAA, managed) — but it stores timestamps, not validity windows, so it surfaces stale facts on temporal queries. Wrong tradeoff for this product.
- **Do NOT use HelixDB for v1.** It's real, YC-backed, GA in 2026, and genuinely nice (graph+vector+temporal+BM25 in one Rust engine). But: young, single-writer, HNSW without quantization (memory pressure at scale), thin docs, custom query language (HelixQL), and core-engine commit cadence has been quiet. Adopting it means **reimplementing Graphiti's bi-temporal + episodic provenance logic yourself.** Revisit only if Graphiti's backend becomes a bottleneck and you want to consolidate infra.
- **Cost gotcha:** Graphiti runs an LLM extraction pass per episode. Backfilling a lab's history is a token bill. Use Haiku/Sonnet for extraction, cap concurrency, and make backfill resumable.

### 4.2 Connectors — **Composio**
- **Why:** managed OAuth + token refresh, per-user connected accounts (critical for scoping), 1000+ apps, official `@composio/anthropic` provider, SOC2/ISO27001. Beats hand-rolling six OAuth flows.
- **Gotchas:** Composio-managed OAuth apps now default to **15-minute polling** for triggers (shared rate limits). For near-real-time sync, register **your own OAuth app** per provider. Webhook deliveries are signed — verify `webhook-signature`; loopback/internal webhook targets are rejected. Their managed-OAuth connection endpoint migrated to a `/link` consent flow in mid-2026 — use the current SDK.
- **Alternatives:** Nango / Arcade / Merge / Pipedream. Arcade has a strong delegated-auth model but a smaller catalog (~112 first-party). Composio's catalog breadth wins for "ingest everything."

### 4.3 Granola — **official REST API (Business plan)**
- `GET /v1/notes` (cursor pagination, `created_after`), `GET /v1/notes/{id}?include=transcript`, Bearer `grn_` key. Personal API needs **Business ($14/user/mo)**; team/admin API needs **Enterprise ($35)**. Basic (free) is capped. MCP server is an alternative path. Historically Granola had *no* API and people reverse-engineered the local cache — don't; use the real API now that it exists.

### 4.4 Messaging — **Telegram now, Twilio SMS for prod**
- **A2P 10DLC reality:** any app→person SMS to US numbers must register a Brand + Campaign with **The Campaign Registry** via Twilio. Brand approval is fast; **campaign review is 10–15 days.** Standard/Low-Volume brands need an **EIN**; sole-proprietor path exists but caps throughput. As of June 30 2026, campaigns require **PrivacyPolicyUrl + TermsAndConditionsUrl** (publicly reachable HTTPS). Some use cases need extra carrier review.
- **Consequence:** start registration on day 1 (get the EIN + a real privacy/ToS page up), but **do all agent iteration on Telegram** (free, instant, no gate). Flip prod to Twilio when the campaign clears. Optional later: iMessage via Sendblue/Loop for the Shepherd-like feel — but it's a vendor dependency and Apple-ToS gray zone, so it's a nice-to-have, not the spine.

### 4.5 Agent — **Claude tool-loop, model-routed**
- Anthropic SDK directly (Composio provides the tool schemas). Route models: cheap model for extraction/classification/summaries, strong model for query planning and multi-hop reasoning.
- Tools — **base:** `search_memory`, `draft_reply`, `file_issue`, `create_page`, `make_link`, `request_approval`, `post_result`. **bio:** `expand_idea`, `run_compute`, `propose_protocol`.
- Keep the loop auditable: log every tool call + which sources were touched.
- **Conversation state + follow-up coreference** (`agent/conversation.py`): the primary mode is multi-turn ("expand on that," "who else touched it," "what changed since"). Keep per-user session context (last N turns + the node IDs cited in the last answer) in Redis; resolve deictic follow-ups against that cited-node set before falling back to full retrieval. Without this, "that idea" has no referent.
- **Temporal-expression resolver** (`agent/temporal.py`): signature queries use fuzzy relative time ("last week," "a couple months ago"). Resolve these to an explicit bi-temporal `valid_from/valid_to` window in the *asker's* timezone (captured at enrollment), and echo the resolved window in the answer ("facts from Jun 30–Jul 6") so temporal ambiguity is visible, not silent.

### 4.5a Action layer (write-back) — **base layer, via Composio**
- This is Shepherd's *"turns what was said into work — drafts the reply, files the bug, makes the link. You just approve."* Composio is bidirectional, so the same connector layer that reads Slack/Gmail/GitHub/Notion also **writes**: post a Slack reply, send/draft an email, open a GitHub issue, create a Notion page, add a calendar event.
- **Every write goes through an approval gate** (`actions/approvals.py`): the agent proposes the exact payload, the human one-taps ✅/❌ over the same chat channel. No silent writes. This gate is also where you get safety and trust for free.
- **Approval UX must work on the prod channel, not just Telegram.** Telegram has inline buttons; **Twilio SMS has none** — approval is a free-text reply. Model each pending approval as a short-lived, numbered token in Postgres (`approve A3` / `reject A3`); with a single pending action a bare "yes/no" resolves. Never map an ambiguous "yes" to the wrong pending action.
- **Write-backs are idempotent.** Attach an idempotency key to every Composio write (jobs already have them; write actions must too) so a lost ack or a retry can't double-file an issue or double-send an email. There is no un-send, so this is a correctness requirement, not an optimization.

### 4.5b MCP server (out) — **base layer, FastMCP**
- Claymore exposes its **lab memory as an MCP server** so the lab's own agents (Codex, Claude Code, Cursor) can pull lab context mid-task: `search_lab_memory`, `who_worked_on`, `what_was_decided`, `find_protocol`. This is high-value for a bio/ML lab that already lives in coding agents — "what did Philip build," "what params did we settle on," answered inside their editor.
- Scope/permissions still enforced (the MCP caller authenticates as a lab user). Read-only by default; write actions stay behind the approval gate.

### 4.5c Proactive ("reach out first") — **base layer**
- Scheduled + event-triggered surfacing over the chat channel: pre-meeting briefs (who's attending, what you discussed last time), "this idea from last week was never tested," daily/weekly digests, "a decision was just contradicted in #protein-eng." Backed by the temporal graph (it knows what changed and what's stale).
- Start simple: a scheduled digest + one event trigger (contradiction/never-tested-idea). Expand later.
- The contradiction / never-tested triggers are powered by the **reconciliation pass** (`memory/reconcile.py`, §4.9) that writes `CONTRADICTS`/`SUPERSEDES` edges across episodes — the proactive layer subscribes to those edge-creation events rather than re-deriving them.
- **Respect a notification budget.** Proactive pushes over SMS/Telegram become spam fast: rate-limit per user, honor per-user quiet hours / opt-out, and batch low-priority nudges into the scheduled digest instead of firing each individually.

### 4.6 Computational (dry-lab) execution — **build Claymore's own science agent; Claude Science as MCP-client + escalation**
This is the "expand and run it" / "Claude science environment" piece. The key finding: **Anthropic's Claude Science (launched ~June 30 2026, beta, all paid tiers, Opus 4.8) is a human-supervised workbench, NOT a headless API** — you can't programmatically drive someone's Claude Science from an SMS agent. So don't build on it as a backend. Instead, do three things:

**(a) Claymore runs its own science-execution agent — the SMS-triggerable path.** Build it from the same public ingredients Claude Science itself uses:
- **Claude Agent SDK (Opus 4.8)** as the agent loop.
- **Anthropic science Agent Skills** — `single-cell-rna-qc`, `scVI-tools`, `Nextflow` deployment, instrument-data→Allotrope, etc. (generally available to all subscribers; several are first-party bio skills).
- **MCP connectors** to the lab's data/tools (Benchling, 10x, PubMed, LatchBio, bioRxiv, Exa…).
- **Compute backends:** **E2B** for light/arbitrary sandboxed code; **Modal** for real/GPU scientific compute (Modal is literally what Claude Science uses); the lab's **HPC over SSH** when they have it (write batch script → submit → poll → collect).
- **Callable scientific workflows:** **NVIDIA BioNeMo Agent Toolkit** (Evo 2, Boltz-2, OpenFold3 — packaged as harness-agnostic skills, so you can call them without Claude Science) and **Nextflow/nf-core** (rnaseq, sarek, atacseq) for real pipelines.
- Output: figure + the exact code + environment + message history (reproducible), texted back as a summary, and **ingested back into memory** as `Experiment`/`Result` nodes so future queries know it ran.

**(b) Expose Claymore to Claude Science over MCP (the inversion).** Claude Science connects *inbound* to external tools via MCP/connectors (that's how LatchBio/Helix/Benchling plug in). So Claymore's memory MCP server (§4.5b) becomes a tool a scientist can use *inside* their own Claude Science session — "what did we decide about the assay" answerable there, for free, today.

**(c) Escalate heavy supervised runs into Claude Science.** For "run the full experiment" tasks that want a human watching, Claymore frames the task and hands it into a Claude Science session rather than running headless. Reviewer-agent citation/calc checking and rich artifact rendering come along for free.

- **Gate:** any spend-incurring or long run requires a one-tap confirmation before launch.
- **Don't hard-depend on a Claude Science API** — it's a 1-week-old beta; if/when a programmatic entry point ships, swap it in behind the same `execute/` interface.
- **Alternatives considered (to Claude Science / E2B):** Modal (chosen for real compute), Daytona / Runloop / Northflank / Cursor sandboxed cloud VMs (generic agent sandboxes), LatchBio (agent-native verified bioinformatics tools, via MCP), BioNeMo toolkit (accelerated bio models, callable directly). FutureHouse / Google AI co-scientist / Edison-Kosmos are hypothesis/lit agents, not execution backends — out of scope as a compute layer.

### 4.7 Wet-lab execution — **Opentrons, gated, late**
- **Python Protocol API** (apiLevel ≥ 2.28, OT-2 + Flex) to generate protocols; **HTTP API** to upload/run/monitor on a networked robot; **`opentrons.simulate`** to dry-run with zero hardware.
- **Mandatory flow:** agent drafts protocol → `simulate` → surface plan + simulation + reagent/labware list to a human → **explicit approval** → upload + run → ingest the run result back into memory. Never skip the gate. Opentrons even ships their own protocol-gen tool (OpentronsAI), so this path is validated but also partly commoditized — our value is the *context* (the retrieved idea) feeding it, plus the approval + result-capture loop.
- Only labs that (a) have a robot and (b) explicitly opt in get this. It's a wow-demo and a wedge into automated labs, not a v1 requirement.

### 4.8 State / jobs / infra
- **Postgres:** users, labs, sources, connected accounts, jobs, approvals, immutable audit log.
- **Arq (Redis)** for v1 background work (ingestion, backfill). Migrate execution workflows to **Temporal** when execution lands — durable, resumable, and its signals model human-in-the-loop approvals cleanly (a run can park for hours waiting for a text-back "yes").
- **Deploy:** containerized on Fly.io/Railway. `docker-compose` locally (falkordb + postgres + redis).

### 4.9 Correctness layer — identity, reconciliation, permissions, durability (build in Phase 1)
These are capabilities the plan *names* but that need an explicit mechanism, not an emergent one. They land in Phase 1 on purpose: retrofitting identity, ACLs, or a replay log onto a populated graph is the expensive path.
- **Cross-source identity resolution** (`memory/identity.py`, R11): the "who said X" moat depends on resolving one person across Slack handle ↔ email ↔ GitHub login ↔ Granola speaker label. A `person_identity` table in Postgres (platform_id → canonical person) seeded from the lab roster at enrollment, with an LLM-assisted merge for unknowns held behind a confidence gate. Unresolved authors ingest as `unknown` and are surfaced, never guessed. Granola diarization (often just "Speaker 1") is the weakest source — map speakers to the meeting attendee list where possible.
- **Cross-episode reconciliation + extraction-quality gate** (`memory/reconcile.py`, R12): `CONTRADICTS`/`SUPERSEDES` can't be extracted from a single episode. A post-ingest pass (cheap model) compares each new fact about an entity against existing facts and writes those edges with provenance — the engine behind "suggested Mar 3, superseded Mar 10." The same pass sample-audits a small % of extractions through a stronger model and tracks extraction attribution-error from Phase 1, so a mis-attributed fact can't silently enter the graph and get cited confidently later (the answer-time reviewer pass in R2 only guards the output, not the store).
- **Provenance-based permission policy** (R13): the *mechanism* (`group_id` scoping) exists; the *policy* was the gap. Every episode gets a source-derived `visibility` from its source ACL (channel membership, doc sharing); every fact inherits the *most restrictive* contributing source's visibility; retrieval filters on it. A fact from a private DM restated in #general stays restricted. Design this alongside ingest, not after.
- **Durable Episode log + graph DR** (`ingest/episodes.py`, R14): persist normalized Episodes append-only in Postgres as the system of record; treat the graph as a derived, rebuildable projection. Buys cheap graph rebuilds, extraction A/B without re-hitting sources, and disaster recovery for the crown-jewel data (FalkorDB is self-hosted + single-writer — a backup/rebuild path is mandatory). Add periodic graph snapshots too.

---

## 5. Data model (Graphiti-oriented)

**Episode** (pre-graph normalization, and the durable **system of record** — append-only in Postgres so the graph is a rebuildable projection, R14): `{ source_platform, source_id, author, timestamp, text, refs[], visibility, is_untrusted }`. `author` is the canonical lab person after identity resolution (R11), or `unknown` (never guessed). `visibility` is derived from the source object's ACL and propagates onto every fact (R13).

**Entity nodes:** `Person, Meeting, Message, Document, CodeCommit, Dataset, Instrument, Reagent, Protocol, Hypothesis, Experiment, Result, Figure`, plus domain `Gene, Protein, CellLine, Assay, Compound`.

**Fact edges (bi-temporal, provenance-bearing):** `SUGGESTED, DECIDED, RAN, PRODUCED, CONTRADICTS, SUPERSEDES, MENTIONS, AUTHORED_BY, DERIVED_FROM, USES`. Each carries `valid_from, valid_to, source_platform, source_id, timestamp, author, confidence, extraction_confidence, visibility`. `CONTRADICTS`/`SUPERSEDES` are written by the reconciliation pass (§4.9, R12), not single-episode extraction; retrieval MUST filter on `visibility` and may threshold on `extraction_confidence`.

This is what lets the agent answer: *"Lucas suggested testing the Y hypothesis on Mar 3 (Granola: Weekly Sync). It was superseded Mar 10 (Slack #protein-eng). No experiment is linked — it was never run."* — grounded, temporal, and honest about the gap.

---

## 6. Roadmap (milestones, not calendar-locked)

### Phase 0 — Scaffold (≈ week 1)
- Fresh repo from `CLAUDE.md`; `docker-compose` (falkordb/postgres/redis); config + secrets; FastAPI skeleton; Telegram echo bot; Graphiti connected to FalkorDB with a hello-world episode.
- **Parallel/non-blocking:** register the entity + EIN, stand up a privacy policy + ToS page, start Twilio A2P 10DLC Brand + Campaign.
- **Exit:** an Episode ingested by hand shows up as attributed facts in the graph; a Telegram message round-trips through the agent.

### Phase 1 — Ingestion + Memory + Eval (≈ weeks 2–4)
- Composio connectors: Slack, Gmail, GitHub, Notion, Drive/Docs (backfill + incremental).
- Granola REST connector; Claude Code/Codex log ingester.
- Scientific entity/edge extraction into Graphiti.
- **Correctness layer (§4.9):** cross-source identity resolution (`memory/identity.py`), the cross-episode reconciliation pass for `CONTRADICTS`/`SUPERSEDES` + extraction-quality sampling (`memory/reconcile.py`), source-derived `visibility` on every episode/fact (permission policy), and the durable append-only Episode log in Postgres (`ingest/episodes.py`). These are Phase-1 work because they're painful to retrofit later.
- **`evals/`: retrieval-attribution harness** — seed a synthetic lab corpus with known ground truth, measure temporal / multi-hop / knowledge-update accuracy AND attribution correctness (hallucinated-source rate). This is your Reviewer-2-proof metric and it's in your wheelhouse. Extend the set with **deep-history recall** (the "random doc from months ago" — the hardest retrieval case), an **extraction-quality** check, and a **Granola-diarization attribution** case; validate the synthetic numbers against one small *real* lab corpus with human-labeled ground truth so they transfer.
- **Exit:** on the seeded corpus, "who said X, when" answers are grounded and attribution error is near zero; every connector passes backfill→incremental→correct-provenance; identity resolves correctly across sources on a spot-checked person; and a fact from a restricted source never surfaces to an unauthorized user.

### Phase 2 — Query agent over messaging (≈ weeks 3–6, overlaps P1)
- Retrieval agent with `search_memory`, answers with inline citations + temporal framing. **Pull-based Q&A is the primary mode** — the agent must handle the full range on demand: person/idea recall, meeting-roundup recall (Granola), old-doc recall (that random Notion/Drive doc from months ago), status/history ("did we ever run Y"), and multi-turn follow-ups ("expand on that," "who else touched it," "what changed since"). Not just one canned example.
- Retrieval must be genuinely hybrid (graph + vector + BM25 + temporal) so old/obscure items surface by meaning and recency, not keyword luck.
- Multi-turn is first-class: conversation state + follow-up coreference (`agent/conversation.py`) and the temporal-expression resolver (`agent/temporal.py`) ship *with* the query agent, not later — the primary mode is a conversation, not one-shot Q&A.
- Per-user/per-lab scope enforced at retrieval (filtered on `visibility`, R13); audit log live.
- Telegram in pilot; flip to Twilio SMS when 10DLC clears.
- **Ship to 1–2 friendly labs** (your Broad/MedARC network is the unfair advantage here). This is the MVP.
- **Exit:** a real lab member texts several *different kinds* of questions (a meeting, an old doc, a decision, a follow-up) and gets correct, cited answers they couldn't have gotten in <5 min themselves.

### Phase 2.5 — Complete the Shepherd base: Act + MCP-out + Proactive (≈ weeks 5–7, overlaps P2)
- **Act:** wire Composio write actions (`draft_reply`, `file_issue`, `create_page`, `make_link`) behind the approval gate. "Summarize that thread and file it as a GitHub issue" → agent proposes → you approve → it's filed. Approval works over **SMS via numbered tokens** (not just Telegram buttons) and writes are **idempotent** (§4.5a). Add an **action-correctness eval** (did it draft the *right* issue/reply?) to `evals/`.
- **MCP-out:** stand up the FastMCP server exposing `search_lab_memory` / `who_worked_on` / `what_was_decided`; connect it in Claude Code/Cursor and query lab memory from inside an editor.
- **Proactive:** one scheduled digest + one event trigger (never-tested-idea or contradiction alert).
- **Exit:** the base is now feature-complete vs Shepherd — a lab member can ask, get things done ("you just approve"), and their coding agents can pull lab context. This is the strong demo even before bio execution.

### Phase 3 — Computational execution (≈ weeks 6–10)
- `expand_idea` → `run_compute`: build Claymore's **own science agent** (Claude Agent SDK + Anthropic science Agent Skills + MCP), running on **E2B** (light) / **Modal** (real/GPU) / lab **HPC over SSH**, able to call **BioNeMo** workflows and **Nextflow/nf-core** pipelines. Texts back a reproducible summary (figure + code + env).
- Wire the **inversion**: Claymore's MCP memory server is consumable inside the lab's **Claude Science** sessions; and heavy supervised runs can escalate into Claude Science.
- Confirmation gate before spend; results ingested back into memory as `Experiment`/`Result` nodes (closing the loop — future queries know it was run).
- **Exit:** "expand Lucas's idea and run the analysis" produces a real, reproducible result artifact from a text, and a scientist can pull Claymore memory from inside their own Claude Science session.

### Phase 4 — Wet-lab execution (opt-in, gated, later)
- `propose_protocol` → `simulate` → approval → Opentrons run → result ingestion.
- Only for opted-in robot labs. Heavy on safety UX, reagent/labware checks, and audit.
- **Exit:** one design partner runs an approved, simulated-then-physical protocol end to end without a safety incident.

### Cross-cutting (all phases)
RBAC + scoping, immutable audit, provenance surfacing, cost dashboards for extraction/inference/sandbox spend, and continuous eval.

---

## 7. Risk register (the disconfirming view)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Scope: full base + bio layer is a lot of surface area.** Building ingest+ask+act+MCP+proactive AND compute+wet-lab at once ships none well. | High | Ordering (not descoping): each layer lands on a working one beneath it. Attributed retrieval eval'd before write-backs; base demoed before Opentrons. |
| R2 | **Confident wrong attribution** destroys trust in a science context. | High | Grounding rule (§CLAUDE.md rule 1); eval harness measures hallucinated-source rate from Phase 1. |
| R3 | **Wet-lab liability / biosafety.** Agent-run physical protocols = uninsurable if ungated; few target labs even have robots. | High | Simulate-first + mandatory human approval; opt-in only; lead with computational execution instead. |
| R4 | **A2P 10DLC 10–15 day gate + EIN requirement** blocks "text a number." | Med | Start registration day 1; pilot on Telegram so it never blocks iteration. |
| R5 | **Base is a deliberate Shepherd replica** — that's the plan, not a risk. Differentiation lives entirely in the bio layer. | Low | Replicate base fully; put the effort/originality into ontology, provenance-for-reproducibility, and the run-the-experiment loop. (This is a hackathon build — replicating the base is a feature.) |
| R6 | **Ingestion/extraction cost** at backfill scale (LLM per episode) — *and* the cost model must not forget Voyage embeddings (every episode is embedded) or Composio's ~1k/mo free-tier execution cap. | Med | Cheap extraction model, prompt-cache + Batch, concurrency caps, resumable backfill, per-lab spend caps. Add an `Embedder` adapter (embedding fallback). Hackathon: scope the pilot backfill small (recent window / a few channels), produce a concrete $ estimate before any full backfill, upgrade tiers only when a pilot needs it. |
| R7 | **Data sensitivity** — unpublished IP, possible PHI. | High | Per-user/per-lab scope at retrieval; SOC2 posture from Composio/Granola; encrypt; audit; no data in logs. |
| R8 | **Granola paywall** (API needs Business plan) + iMessage has no API. | Low-Med | Treat Granola as a paid-tier connector; deprioritize iMessage, use SMS/Telegram spine. |
| R9 | **Vendor concentration** (Composio, Graphiti backend, Anthropic). | Med | Keep the `Episode` normalization + ontology vendor-neutral so any layer is swappable; Graphiti self-hosted (no Zep-Cloud lock-in). |
| R10 | **Multi-tenant on a young graph store.** | Med | FalkorDB namespacing per lab; load-test before onboarding beyond pilot; Neo4j fallback path kept warm. |
| R11 | **Cross-source identity resolution unspecified** — "who said X" (the moat + rule 1) needs one person resolved across Slack / email / GitHub / Granola-speaker; without it, attribution breaks at the source. | High | Identity table seeded from lab roster + LLM-merge behind a confidence gate; `unknown` + surface when unresolved; Granola diarization mapped to attendees. `memory/identity.py`, Phase 1. See `RISKS_AND_MITIGATIONS.md#R11`. |
| R12 | **No mechanism for `CONTRADICTS`/`SUPERSEDES` or extraction-time attribution quality** — the signature temporal answer *and* graph integrity depend on cross-episode reasoning, which per-episode extraction can't do. | High | Post-ingest reconciliation pass writes those edges with provenance; same pass sample-audits extraction attribution from Phase 1. `memory/reconcile.py`. See #R12. |
| R13 | **Permission *policy* (not just mechanism) undefined** — facts from mixed-ACL sources have no visibility rule; the shared-vs-private line is the core tension. | High | Source-derived `visibility` per episode; facts inherit the most restrictive contributing source; retrieval filters on it. Design with ingest, not after. See #R13. |
| R14 | **Graph durability / DR** — FalkorDB self-hosted, single-writer, holds crown-jewel data; corruption = re-pay the whole extraction bill. | Med | Durable append-only Episode log in Postgres as system of record; graph = rebuildable projection; periodic snapshots. `ingest/episodes.py`. See #R14. |

---

## 8. Open strategic decisions (answer before/at Phase 2)

1. **Wedge persona:** single PI's lab vs. a whole department vs. a company R&D team? (Affects RBAC depth, pricing, and which sources matter most.) *Recommendation: one PI's lab, 5–15 people — matches your network and keeps scope sane.*
2. **First killer query type:** decision-recall ("what did we decide about X"), person-recall ("what did Lucas suggest"), or status ("did we ever run Y"). Optimize eval + prompts for one first. *Recommendation: person/idea-recall — it's the pitch's demo.*
3. **Execution-first vs retrieval-first as the paid hook.** Retrieval is the trust-builder; execution is the wow. *Recommendation: retrieval MVP free/cheap to seed labs, execution as the paid tier.*
4. **iMessage or not.** *Recommendation: not for v1.*
5. **When (if) to consolidate onto HelixDB.** *Recommendation: only post-PMF, and only if the graph backend is the bottleneck.*

---

## 9. First commands for Claude Code (Phase 0 kickoff)

1. Read `CLAUDE.md` fully. Confirm the stack table and the hard rules.
2. Scaffold the repo layout in `CLAUDE.md §4`. `pyproject.toml` (python 3.12), `docker-compose.yml` (falkordb, postgres, redis), `.env.example`.
3. Stand up FastAPI + a Telegram echo bot; verify a message round-trips.
4. Wire Graphiti → FalkorDB; ingest one hand-made Episode; query it back with provenance.
5. Stub `evals/` with the seeded-corpus harness skeleton (we fill ground truth in Phase 1).
6. Do NOT touch Opentrons or Twilio code yet. Twilio/EIN/privacy-page work is a human parallel track.

---

## 10. Sources this plan was validated against (July 2026)

Composio (docs, changelog, connectors review); HelixDB (GitHub, YC, GA/ProductHunt, independent repo review); Graphiti vs Mem0 vs Letta (LongMemEval independent evals, ~63.8% vs ~49.0%; Graphiti Apache-2.0, Zep Community Edition deprecated); Twilio A2P 10DLC (official docs: 10–15 day review, EIN/brand/campaign, June-30-2026 privacy/ToS URL requirement); Opentrons (Python Protocol API v2 ≥2.28, HTTP API, `opentrons.simulate`, OpentronsAI); Granola (public REST API launch, Business/Enterprise gating, $14/$35 pricing, MCP); **Claude Science** (Anthropic launch ~June 30 2026, beta all paid tiers, Opus 4.8, multi-agent, runs on your infra/Modal/HPC, MCP+connectors inbound, NVIDIA BioNeMo/LatchBio/Helix integrations — verified it's a supervised app, not a headless API); askshepherd.ai (reference product). Verify anything pricing-/API-version-sensitive at build time — these move.



<!-- ============================================================ -->
<!-- FILE: ENGINEERING_GUIDELINES.md -->
<!-- ============================================================ -->

# Claymore — Engineering Guidelines

> How to build Claymore like a senior team would: modular, DRY, fast, scalable, debuggable, production-ready. Read this alongside `CLAUDE.md`. These aren't suggestions — hold this bar on every module. When a shortcut trades quality for speed, name the tradeoff instead of taking it silently.

---

## 0. The prime directives

1. **Clean beats clever.** Readable, boring, obvious code that a new engineer understands in 5 minutes beats a smart one-liner.
2. **DRY, but not premature.** One source of truth for every concept; no copy-paste. But don't abstract until there are 2–3 real uses — premature abstraction is its own mess.
3. **Measure, then optimize.** No performance change without a profile that proves the bottleneck. Guessing wastes time and adds complexity.
4. **Root cause, not symptom.** Every bug fix explains *why* it broke and ships a regression test so it can't come back.
5. **Ship the phase's slice, clean.** Don't gold-plate future phases; do make the current slice production-quality.
6. **Leave the campsite cleaner.** Touch a file, improve it slightly (types, a test, a clearer name). Update `CLAUDE.md` when a decision changes.

---

## 1. Architecture & modularity (build it like a senior SWE)

**Boundaries.** Follow the module layout in `CLAUDE.md §4`. Each module owns one responsibility. The dependency arrow points inward: the domain core (`memory/ontology`, `Episode` schema, agent logic) must not import vendor SDKs directly.

**Ports & adapters (hexagonal).** Every external vendor sits behind a narrow interface, so it's swappable and testable (this is also the R9 lock-in mitigation):
- `MemoryStore` → Graphiti/FalkorDB adapter
- `ConnectorHub` → Composio adapter
- `ComputeBackend` → E2B / Modal / HPC adapters
- `LLM` → Anthropic adapter (with model routing inside)
- `Embedder` → Voyage adapter (embedding model behind a seam too — every episode is embedded, so it's a real cost/availability dependency and needs a fallback path, R6/R9)
- `MessagingChannel` → Telegram / Twilio adapters
- `SecretsProvider` → env / Infisical adapter

Domain code depends on the interface, never the concrete SDK. Swapping a vendor = one new adapter, zero changes to core.

**Single source of truth.**
- The `Episode` schema and the scientific ontology are defined **once** (Pydantic models) and imported everywhere. Never redefine a shape inline.
- Config is centralized in `config.py`, env-driven (Pydantic `BaseSettings`). No magic numbers or hardcoded strings scattered in code — name them.
- Prompts live in `agent/prompts/` as versioned files, not string literals buried in logic.

**Types & contracts.** Full type hints everywhere; `mypy --strict` in CI. Pydantic models validate every boundary (API in/out, tool args, episode shape, LLM structured output). Strict tool-arg schemas double as a security control (see `SECURITY.md §3a`).

**Style.** Async-first (FastAPI, Graphiti, httpx are async — don't block the event loop with sync I/O). Small, single-purpose functions; pure where possible; explicit over implicit. `ruff` (lint) + `ruff format` in CI; consistent naming. Docstrings on public functions explaining *why*, not *what*.

**Tests are part of "done."** Unit tests for logic, integration tests for adapters (against local docker services), and the `evals/` harness for retrieval quality. A layer isn't done until its tests + the relevant `SECURITY.md` checklist pass. LLM-driven steps (extraction, generation, reconciliation) are **non-deterministic** — don't assert exact strings; test them against a **golden set with tolerance** (schema-valid output, required entities present, attribution correct, supersession edge created) pinned in the `evals/` gate, not brittle unit asserts.

---

## 2. Performance, memory & scalability (build it like a performance engineer)

**Rule zero: profile before you optimize.** Use `py-spy` / `cProfile` for CPU, `tracemalloc` for memory, async task timing for latency. Optimize the measured hot path, not a guess. Add a perf note to the PR when you do.

**Claymore's known hot paths — watch these:**
1. **Ingestion (the big one):** LLM-per-episode extraction dominates cost *and* latency. Mitigations (also R6): cheap model (Haiku) for extraction, **prompt-cache the extraction system prompt + ontology** (90% off repeat input), **Batch API for backfill** (50% off), tune Graphiti `SEMAPHORE_LIMIT` for concurrency without 429s, and **don't re-extract unchanged content** — dedup by source hash, incremental sync only touches deltas.
2. **Retrieval:** hybrid graph+vector+BM25. Avoid N+1 graph queries; scope to explicit `group_ids` (smaller search space = faster *and* isolated); cache hot embeddings; set `num_results` sanely.
3. **Agent loop:** token usage = latency + cost. Route models (Haiku/Sonnet/Opus by task), cache stable context, cap `max_tokens`, avoid re-sending unchanged history.
4. **SMS round-trip:** the reply must feel instant. Simple/cached queries answer inline; anything heavy (backfill, compute, multi-hop research) goes to a background worker with an immediate "on it — I'll text you back" ack. **Never block the messaging handler on slow work.**

**Concurrency & I/O.**
- Async I/O throughout; parallelize independent calls (`asyncio.gather`), don't serialize.
- Connection pools for Postgres, Redis, FalkorDB — create once, reuse; never open per-request.
- Heavy/long work → background workers (Arq → Temporal); the request path stays fast. Jobs are **idempotent** and resumable.

**Memory.**
- Stream, don't slurp. Backfill iterates pages/generators; never load a lab's entire history into memory. Bounded queues with backpressure.
- Release references; avoid unbounded caches (use TTL/LRU). Watch for accidental accumulation in long-running workers.

**Scalability.**
- Services are **stateless** (state in Postgres/Redis/graph) so they scale horizontally.
- Per-lab graph isolation scales naturally; load-test concurrent ingest+query at pilot size before onboarding more (FalkorDB is single-writer per graph — validate write throughput).
- Rate-limit and add backpressure so one busy lab can't starve others.

**"Don't recompute / don't re-render."**
- Backend: don't re-embed unchanged text, don't re-extract unchanged episodes, don't re-run a query whose inputs didn't change — memoize/cache with proper invalidation.
- Any UI (dashboard, artifacts): avoid unnecessary re-renders (memoization, stable keys, correct effect deps), lazy-load, virtualize long lists. Ship the data progressively rather than blocking on the whole payload.

**Cost is a performance metric here.** LLM tokens and sandbox minutes are real spend — treat a cost regression like a latency regression. Per-lab spend caps + alerts.

---

## 3. Debugging & reliability (build it like a senior debugging engineer)

**Method — every time, no shortcuts:**
1. **Reproduce** deterministically (a failing test or a scripted repro). If you can't reproduce it, you can't fix it — instrument until you can.
2. **Isolate** — bisect the pipeline (ingest → extract → store → retrieve → generate → act). Correlation IDs make this possible across the async flow.
3. **Hypothesize the root cause**, think step by step, and **verify** it before patching. Don't fix the symptom.
4. **Fix robustly** — handle the whole class of the bug, not the one input.
5. **Regression test** so it can't silently return.
6. Note the root cause in the PR.

**Observability (build it in from Phase 0):**
- Structured JSON logging with correlation IDs threaded through the whole request/pipeline. No secrets or raw source text in logs (see `SECURITY.md`).
- Tracing (OpenTelemetry) across async boundaries and tool calls.
- Metrics: ingestion rate, extraction cost/latency, retrieval latency, answer faithfulness, tool-call outcomes, per-lab spend, **extraction attribution-error rate** (R12), **identity unresolved-rate** (R11), and **embedding spend** (every episode is embedded — don't leave it out of the cost model, R6).

**Error handling & resilience:**
- Fail explicitly; never swallow exceptions. Distinguish transient (429, network, timeout → retry with exponential backoff + jitter) from permanent (bad input → surface + dead-letter).
- Circuit breakers on flaky upstreams; graceful degradation (extraction fails → queue + retry, don't drop; strong model rate-limited → fall back; one connector down → other syncs keep running).
- Dead-letter queue for failed episodes with enough context to replay.
- Idempotency keys on jobs + resumable backfill checkpoints so a crash never double-bills or corrupts state.

**Edge cases to handle explicitly (Claymore-specific):**
- Empty / malformed / gigantic source items; unicode & encoding; documents over the context window (chunk).
- **Temporal correctness** — timezones, out-of-order events, superseded facts. The whole value prop is "as of when," so bi-temporal handling must be right and tested.
- Duplicate episodes, edited/deleted source data (reflect deletions — use provenance to purge a `source_id`'s facts, per `SECURITY.md §10`), partial sync failures.
- **Identity ambiguity** — same person across handles, unresolved Granola speakers; resolve to a canonical person or `unknown`, never guess (R11). **Cross-episode supersession** — a later episode changes an earlier fact; the reconciliation pass must write `SUPERSEDES` with `reference_time` = the source timestamp, correct even on out-of-order backfill (R12).
- Concurrent writes to one lab's graph (single-writer — serialize or queue).
- Provenance gaps — the agent must say "I can't find that" rather than invent (see R2), and that path must be tested.
- Unknown sender / unenrolled phone number (untrusted — see `SECURITY.md §8`).

**Production readiness checklist (before a layer goes live):**
- Health/readiness/liveness endpoints; graceful shutdown that drains in-flight work.
- DB migrations with a rollback path; feature flags default-off; one-command rollback.
- **Graph durability (R14):** the graph is a rebuildable projection of the append-only Episode log (Postgres = system of record). Before any layer that writes to the graph ships, have periodic FalkorDB snapshots + a **tested rebuild-from-episodes path** — losing the graph must never mean re-hitting sources or re-paying the extraction bill.
- Alerts wired for the metrics above; kill switches (per-lab, global action-disable, robot halt).
- Passing: unit + integration tests, the `evals/` faithfulness gate (R2), the injection eval, the `SECURITY.md` checklist, and a manual smoke test of the happy path **plus one edge case**.

---

## 4. UX & DX must be seamless

**UX (the person texting):**
- Fast and honest. Cited answers; "I couldn't find that" when ungrounded; conversational, not robotic.
- Immediate acknowledgment for async work ("Looking into that across last week's notes — I'll text back in a sec").
- Approvals are one-tap and show exactly what will happen. Errors surface as friendly messages, never stack traces.

**DX (whoever builds/extends Claymore):**
- `git clone` → `cp .env.example .env` → `docker compose up` → seeded local stack running, in minutes. Document it in the README.
- Typed interfaces, meaningful error messages, seed/fixture data, a fast test loop.
- CI gates every PR on: `ruff` + `mypy` + tests + eval faithfulness floor + injection eval + the security checklist. Green CI = safe to merge.

---

## 5. Definition of done (per PR / per layer)

- [ ] One concern, small diff, descriptive commit.
- [ ] Types complete; `ruff` + `mypy --strict` clean.
- [ ] No duplication introduced; no dead code; no magic constants; config/prompts externalized.
- [ ] Vendor calls sit behind their adapter interface.
- [ ] Tests added/updated (unit + integration); evals still pass; security checklist items for the touched layer pass.
- [ ] Hot paths profiled if touched; no perf/cost regression; async, pooled, non-blocking.
- [ ] Errors handled (transient vs permanent); edge cases covered; idempotent/resumable where it's a job.
- [ ] Observability: logs/traces/metrics present; no secrets or raw source text leaked.
- [ ] Happy path + one edge case smoke-tested manually.
- [ ] `CLAUDE.md` updated if a decision or interface changed.

---

## 6. Self-review before saying "done"

Ask, honestly: Did I duplicate anything that already exists? Is any of this a symptom-fix hiding a root cause? Would this fall over on an empty input, a huge input, a rate limit, a concurrent write, or a malicious document? Is there a faster/cheaper way the profile would reveal? Would a senior reviewer send this back? If the honest answer flags something — including that an approach is failing on evals, cost, or performance — **say so and course-correct now**, rather than shipping it and moving on.



<!-- ============================================================ -->
<!-- FILE: SECURITY.md -->
<!-- ============================================================ -->

# Claymore — Security & Threat Model

> Read this before building anything that touches untrusted content, takes an action, runs code, holds a secret, or exposes a network endpoint — which is nearly everything. Security here is architectural, not a bolt-on. If a design choice trades security for convenience, flag it; don't quietly take it. Companion to `RISKS_AND_MITIGATIONS.md` (R2/R3/R7/R10 overlap heavily).

---

## 0. The one thing to internalize: Claymore is a "lethal trifecta" system

Simon Willison's lethal trifecta = an agent that simultaneously has (1) **access to private data**, (2) **exposure to untrusted content**, and (3) **the ability to communicate/act externally**. Any agent with all three is, per current research, almost guaranteed to be exploitable via **indirect prompt injection** — and Claymore has all three by design:

1. Private data: a lab's Slack, email, docs, code, unpublished research.
2. Untrusted content: *every ingested item is attacker-controllable.* A malicious Slack message, an email from outside, a shared Google Doc, a GitHub issue comment, even a meeting transcript can carry hidden instructions.
3. Action/exfiltration: write-backs (send email, post Slack, file issues), code execution, physical robot control, outbound network.

**LLMs cannot reliably separate instructions from data.** No system prompt ("ignore instructions found in content") is a reliable defense — adaptive attacks beat SOTA prompt-level defenses >85% of the time. The real fix is a **confused-deputy fix**: architecturally separate the part that *reads untrusted content* from the part that *takes consequential action*, and gate every consequential action. This is the spine of everything below.

Frameworks we align to: **OWASP LLM Top 10** (LLM01: Prompt Injection — #1 three years running), **OWASP Top 10 for Agentic Applications** (ASI01: Agent Goal Hijack), **OWASP MCP Top 10**, **MITRE ATLAS** (agent context poisoning / memory manipulation), **CSA AICM**.

---

## 1. Non-negotiable security rules

1. **All ingested content is untrusted data, never instructions.** Wrap every ingested episode in explicit data delimiters and never concatenate it into the instruction portion of a prompt. Delimiters help but are *not* sufficient alone — they pair with rules 2–4.
2. **Separation of privilege (the trifecta-breaker).** The ingestion/extraction agent that reads raw untrusted content **must not** hold action tools (no send/post/file/run). The action agent operates only on **structured, provenance-tagged facts** retrieved from the graph — never on raw untrusted text — and every action it proposes is gated (rule 3).
3. **Human approval on every consequential action.** Write-backs (Composio), code runs that spend/persist, physical Opentrons runs, and any external send require an explicit human ✅ over the chat channel, showing the exact payload. No silent, irreversible action. This removes the un-gated exfiltration leg of the trifecta.
4. **Egress is deny-by-default.** The agent and its sandboxes may only reach an allowlist of destinations. No arbitrary outbound requests, no auto-rendering of attacker-supplied links/images, no fetching attacker-supplied URLs. Data exfiltration usually rides a "legitimate" channel (a search query, an email subject, an image URL) — constrain the channels.
5. **The LLM never sees a secret.** API keys, OAuth tokens, DB creds are injected at the infra layer, never placed in prompts, tool descriptions, tool outputs, or the graph. Composio holds third-party OAuth tokens server-side; Claymore never puts them in model context.
6. **Everything is logged and attributable.** Every tool call records who/what/when/args/result and whether it originated from a user instruction or from ingested content. Downstream behavioral monitoring is the most reliable detection layer.
7. **Least privilege everywhere.** Read-only scopes by default; per-lab and per-user isolation; short-lived tokens; narrow OAuth scopes (`mail.readonly`, not `mail.modify`).

---

## 2. Prompt injection (LLM01 / ASI01) — the primary threat

**Attack surfaces (all real for Claymore):**
- **Indirect injection via ingested content** — the big one. Hidden/white-text instructions in a doc, email, message, transcript, or issue comment that the agent reads.
- **RAG/memory poisoning** — a poisoned source becomes a graph fact; later retrieval feeds the injection into a query answer. (Research: ~5 crafted docs can steer answers ~90% of the time.) Poisoned memory persists across sessions.
- **Tool-description poisoning** — malicious instructions in an MCP tool's name/description/schema (see §3).
- **Self-propagation** — the agent is tricked into embedding payloads in its own outputs (a filed issue, a Slack post), infecting the next reader/agent.

**Defenses (layered — no single one suffices):**
- **Architectural (primary):** rules 2–4 above. The extraction agent has no action tools; the action agent never sees raw untrusted text; actions are gated; egress is allowlisted. This is what actually holds.
- **Data/instruction isolation:** untrusted content processed in isolated prompt contexts with hard delimiters; provenance tags travel with every fact so retrieval never launders untrusted text into "trusted" instructions.
- **Reviewer pass before any output/action:** a cheap second model decomposes the drafted answer/action into atomic claims/params and verifies them against retrieved context; drop/flag anything unsupported (doubles as the R2 attribution check). Optional detector (Vectara HHEM / MiniCheck / a FaithJudge-style judge).
- **Provenance-anchored answers:** the agent asserts only facts that carry a retrieved source; it cannot free-write an instruction it "found." (See R2.)
- **Behavioral monitoring:** alert when the agent's tool-call pattern deviates from baseline (e.g., a "summarize" request suddenly triggers an outbound send). Detection is most reliable *downstream* of the attack.
- **Eval it:** run injection scenarios in CI (AgentDojo-style: seed the corpus with adversarial documents and assert the agent doesn't act on them). Track attack-success-rate as a release metric.

**Reality check:** assume some injections will land. Design so the *blast radius* is small — that's why gates + egress limits + least privilege matter more than any filter.

---

## 3. MCP security — Claymore is both a server (out) and a client (connectors + Claude Science)

MCP wires old vulnerability classes straight to an autonomous agent. Empirical scans of public MCP servers found ~43% with command injection, ~30% SSRF, ~22% path traversal, ~40% with no auth, ~79% handling credentials in plaintext, plus real CVEs (mcp-remote RCE, MCP Inspector unauth RCE). Don't ship a demo-grade server.

### 3a. Claymore's MCP server (the "MCP out" that Codex/Claude Code/Cursor/Claude Science consume)
- **OAuth 2.1 + PKCE** for the network-exposed server. **Validate token audience** (RFC 8707/9068) — accept only tokens minted for *this* server. **Never token-passthrough** a client's token to an upstream API; the server is the authoritative caller.
- **Per-client consent registry** + exact-match redirect-URI validation + CSRF `state` — prevents the confused-deputy code-interception attack.
- **Bind sessions to user** (`<user_id>:<session_id>`), validate on every request, use cryptographically random session IDs. Enforce per-lab/per-user scope inside every tool (a rotation student's session can't read the PI's private group).
- **Read-only by default**; any write goes through the same human-approval gate. Tools expose *narrow, named capabilities* ("search_lab_memory", "what_was_decided"), not raw DB access.
- **Strict JSON Schema** on every tool param (`additionalProperties: false`, `pattern` on strings) to block injection/overflow via arguments. Validate/sanitize all inputs (command-injection, path-traversal).
- **SSRF controls:** block egress to private IP ranges / cloud metadata endpoints (169.254.169.254) from any URL-taking tool or OAuth discovery.
- **TLS always**; sign messages at the app layer (don't rely on TLS alone); rate-limit/quota per session/tenant (DoS + blast-radius).
- **Never** store secrets in server code/config/env exposed to the model.

### 3b. Claymore as MCP client (connectors, and when consumed by Claude Science)
- **Treat every tool description/schema/output as untrusted model input** (tool-description poisoning = injection). 
- **Pin tool definitions** with cryptographic hashes; **alert on any change** between sessions (rug-pull / bait-and-switch). Scan configs with **mcp-scan** (Invariant Labs) or equivalent.
- **Allowlist** which servers/tools are usable; deny by default; review before enabling. Watch cross-server **tool shadowing** (one server's description altering behavior toward another's tools).
- Prefer connectors where credentials stay in the connector's vault and are injected at execution (Composio pattern) so the LLM never sees the token.

---

## 4. Code execution sandbox (dry-lab / bioinformatics runs)

Agent-generated code can exfiltrate env vars, write disk, open outbound connections, and escape to the host if not contained. Harden it:
- **Use microVM isolation for untrusted code.** E2B runs Firecracker microVMs (own kernel + rootfs + network namespace — same tech as AWS Lambda); Modal uses gVisor. Prefer microVM (Firecracker/Kata) over plain containers (shared host kernel = escape vectors). Reserve containers for trusted/vetted code only.
- **Deny-by-default egress from the sandbox.** Per-sandbox iptables/NAT rules; allowlist only the data sources the run legitimately needs. This is the main defense against code-based exfiltration (sandbox isolation alone won't stop the model misusing *allowed* channels).
- **No secrets in the sandbox environment.** Inject data via scoped, short-lived, proxied access — not by dumping API keys into env vars the code can read.
- **Ephemeral + resource-limited.** Fresh sandbox per run, destroyed after; CPU/mem/time/disk quotas to resist runaway/DoS and cap spend.
- **Human gate before spend/long runs** (rule 3). Capture artifacts + the exact code/env for reproducibility and audit.
- If the run needs the lab's HPC over SSH: least-privilege service account, scoped keys, never the LLM's to see; treat generated batch scripts as untrusted until reviewed.

---

## 5. Wet-lab / physical (Opentrons) — safety *is* security

A prompt injection that reaches physical hardware is a safety incident. See `RISKS_AND_MITIGATIONS.md#R3`. Security-specific points: physical execution is off by default, opt-in per lab, gated by `opentrons.simulate` + explicit human approval, with an always-available `halt`/`stop`, a protocol-type allowlist, and a hard refusal for hazardous-reagent / BSL-escalating protocols unless a human explicitly configures them. Never let ingested content drive an un-gated physical action.

---

## 6. Data trust boundary & multi-tenant isolation

- **Ingestion is the trust boundary.** Tag every episode with `source_platform`, `source_id`, `author`, `timestamp`, and an `is_untrusted=true` marker. Facts derived from external/unauthenticated sources carry lower trust; surface that in answers and never let them silently drive actions.
- **Hard tenant isolation** (see R10): separate FalkorDB graph per lab (`graph_name`), per-user `group_id` inside a lab, and **always** scope queries to explicit `group_ids` — never a global search (cross-tenant leak = both a privacy breach and an injection amplifier). Cross-lab data must be provably unreachable.
- **Intra-lab need-to-know is a permission *policy*, not just the `group_id` mechanism** (see R13): tag every episode with a `visibility` derived from its source object's ACL (channel membership, doc/repo sharing); every fact inherits the *most restrictive* contributing source's visibility (fail-closed); retrieval **and the MCP-out server** filter on the querying user's clearance ∩ fact visibility. A fact whose only source is a private DM must not reach a user without access to that DM. `group_id` is the tenant boundary; `visibility` is the within-lab boundary.
- **Identity is a trust input** (see R11): attribution drives both hard rule 1 and downstream trust. Resolve authors to canonical lab people at ingest; where a source can't be resolved (an unlabeled Granola speaker, an unauthenticated external email), mark `author=unknown` and treat the content as lower-trust — never guess an identity.
- **Encrypt** Postgres (including the durable append-only Episode log — it holds raw source text, R14) + graph at rest and in transit. Keep raw source text and secrets out of logs; redact PII.
- **PHI out of scope** for MVP; a clinical lab requires a HIPAA/BAA path before onboarding (don't claim compliance you don't have).

---

## 7. Secrets & credentials

- App secrets in a real secrets manager (**Infisical** self-host / **Doppler** / cloud Secret Manager), **injected at runtime**, never committed. Separate dev/staging/prod. Rotate. Audit every access. `.env` is gitignored and dev-only.
- **Composio holds the third-party OAuth tokens** server-side (SOC2/ISO27001) — Claymore stores only a Composio API key + per-user connection references, shrinking blast radius. Narrow scopes, prefer read-only, prefer short-lived tokens.
- **OIDC (not static creds) in CI** — GitHub Actions → short-lived cloud token; no long-lived secret in the pipeline. (CI runners are a top breach vector in 2026.)
- The LLM, tool descriptions, tool outputs, and the graph never contain a secret.

---

## 8. Webhooks & the SMS/chat interface

- **Verify inbound webhooks.** Validate Twilio's `X-Twilio-Signature` on every inbound SMS webhook; validate Composio's signed `webhook-signature`. Reject unsigned/invalid — otherwise anyone can forge inbound "messages" or ingestion events. Webhook URLs must be public HTTPS (Composio rejects loopback/internal targets).
- **Authenticate the human, not the phone.** Anyone can text the number and caller-ID/phone numbers are spoofable. Map inbound numbers to **enrolled, verified lab users** (allowlist); treat unknown numbers as untrusted and non-privileged; require an enrollment step before any data access. Never take a privileged action based on caller ID alone.
- **Rate-limit** inbound per number and the API broadly (DoS + abuse + spend control).

---

## 9. Infrastructure & supply chain

- **Network egress firewall** on every service (deny-by-default; allowlist Anthropic, Voyage, Composio, Granola, Twilio, Modal/E2B, the graph — nothing else). This bounds exfiltration even if the agent is compromised. (This dev environment itself runs an egress allowlist — mirror that posture in prod.)
- **SSRF hygiene** anywhere a URL is fetched/rendered: block private ranges + metadata endpoints, no redirects to internal hosts, exact-match allowlists.
- **TLS 1.2+** everywhere; mTLS for internal service-to-service where feasible; DNS-rebinding protection on any local server.
- **Supply chain:** pin dependencies with lockfiles; scan (Dependabot/Snyk/`pip-audit`); pin MCP server versions and verify signatures; review any community MCP server before enabling (the CVEs above came from unreviewed servers). Don't install from unverified registries.
- **Sandbox the agent runtime host** and ensure it's in scope for endpoint/behavioral monitoring (agent runtimes/containers are common blind spots).

---

## 10. Monitoring, audit & incident response

- **Log every tool invocation** centrally with full context (user, client, args, downstream system, result, trust-origin). Immutable audit trail for ingestion, queries, actions, executions.
- **Behavioral detection** downstream: alert on anomalies — a read-only query that triggers a send, an unusual tool chain, egress to a new destination, a spike in extraction spend, a tool description that changed hash.
- **Kill switches:** per-lab disable, global action-disable flag, robot halt. Feature flags default off (`ACT_ENABLED`, `EXEC_*` etc.).
- **Have a revocation path:** rotate/revoke a leaked key, revoke a lab's Composio connections, purge a poisoned source's facts from the graph (provenance makes targeted purge possible — you can delete all facts from a given `source_id`).

---

## 11. Security "definition of done" checklist (per layer, before it ships)

- [ ] Ingestion: content tagged untrusted; extraction agent has no action tools.
- [ ] Retrieval: scoped to explicit `group_ids`; filtered on `visibility` (intra-lab need-to-know, R13); cross-tenant leak test passes; a restricted-source fact never reaches an under-cleared user.
- [ ] Identity: authors resolved to canonical persons or `author=unknown` and surfaced — never guessed (R11).
- [ ] Answers: every claim carries a retrieved source; reviewer pass runs; injection eval in CI.
- [ ] Actions (write-back): human-approval gate shows exact payload; egress allowlisted; audited.
- [ ] MCP server: OAuth 2.1+PKCE, audience validation, no passthrough, per-client consent, strict schemas, SSRF blocks, TLS, per-session rate limits.
- [ ] MCP client: tool defs pinned/hashed + change-alerted; mcp-scan clean; server allowlist.
- [ ] Sandbox: microVM isolation; deny-by-default egress; no secrets in env; ephemeral; quotas.
- [ ] Wet-lab: simulate→approve→run; abort path; off by default; opt-in.
- [ ] Secrets: none in repo/prompt/graph/logs; vault-injected; scoped; rotated.
- [ ] Webhooks: signatures verified; numbers enrolled/allowlisted; rate-limited.
- [ ] Infra: egress firewall; SSRF blocks; deps pinned+scanned; audit log + anomaly alerts + kill switches live.



<!-- ============================================================ -->
<!-- FILE: RISKS_AND_MITIGATIONS.md -->
<!-- ============================================================ -->

# Claymore — Risk Mitigation Playbook

> Companion to `BUILD_PLAN.md §7`. For each risk, this gives Claude Code a concrete, current approach — specific tools, settings, params, and a "definition of done." Read the relevant section before building the affected layer. Verify anything version/pricing-sensitive at build time.

---

## R1 — Scope (full base + bio layer is a lot of surface area)

**Approach: vertical slices behind flags, one working layer under the next.**
- Build the smallest end-to-end path first: 1 source (Slack) → Graphiti → 1 query type → Telegram reply, cited. Prove it, then fan out sources and capabilities.
- Put every layer behind a feature flag (`INGEST_*`, `ACT_ENABLED`, `MCP_OUT_ENABLED`, `EXEC_COMPUTE_ENABLED`, `EXEC_WETLAB_ENABLED`) so half-built layers can't break the demo.
- Definition of done per layer = the exit criteria in `BUILD_PLAN.md §6`. Don't start layer N+1 until layer N passes its exit.
- Hackathon triage: if time-boxed, the demo-critical spine is **ingest → ask (cited) → one act write-back → one compute run**. MCP-out and proactive are high-ROI additions; wet-lab is a stretch/opt-in.

---

## R2 — Confident wrong attribution (the trust-killer)

This is the risk that matters most. Three layers of defense:

**1. Grounded generation (prevent).**
- System-prompt rule: the agent may only assert a fact if it carries a retrieved source; otherwise it says it can't find it. Force a structured answer: `{claim, source_id, source_platform, author, timestamp}[]`. No source → the claim is dropped or flagged, never emitted.
- Graphiti already stores provenance: every fact edge is extracted from an `EpisodicNode` that keeps the original source text. Retrieve the episode alongside the fact and cite it. Never let the LLM free-write an attribution.
- Scope every retrieval to explicit `group_ids` (never global search) — cross-tenant bleed is also a wrong-attribution failure.

**2. Reviewer pass (catch).**
- Before any answer is texted out, run a cheap second-agent check (Haiku): decompose the drafted answer into atomic claims, verify each against the retrieved context, drop/flag unsupported ones. This is the same "reviewer agent" pattern Claude Science uses for citations/calcs.
- Optionally add a fine-tuned hallucination detector as a guard (Vectara **HHEM**, **MiniCheck**, or **FaithJudge**-style LLM judge) for a fast supported/unsupported verdict.

**3. Eval harness (measure — build in Phase 1, `evals/`).**
- Seed a synthetic lab corpus with **known ground truth** (who said what, when, what was superseded). Generate query sets across the LongMemEval categories: temporal, multi-hop, knowledge-update (fact changed over time), and single-session recall.
- Metrics (use **RAGAS**, reference-free): **Faithfulness** (claims grounded in retrieved context — set the strictest floor, ~0.85), Answer Relevancy, Context Precision, Context Recall. Add a **custom attribution-correctness metric**: is the cited source the *actual* origin of the fact? (hallucinated-source rate → target ~0).
- **Gate CI on it:** run the eval in CI (**DeepEval** for CI/CD integration), exit non-zero if faithfulness or attribution falls below floor → blocks the merge. LLM-judge eval costs ~$0.001–0.003 per case, so a few hundred cases per run is cheap.
- Production monitoring later: Langfuse / Patronus traces on live answers.

**Definition of done:** on the seeded corpus, faithfulness ≥ 0.85 and hallucinated-source rate ≈ 0; the CI gate is wired and actually blocks a regression PR.

---

## R3 — Wet-lab liability / biosafety

**Approach: simulate-first, human-approve-always, opt-in-only. Never auto-run physical hardware from a text.**
- **Dry-run every protocol** with `opentrons.simulate` (or `opentrons_simulate` CLI) — it validates the protocol and produces a step-by-step run preview with zero hardware. No protocol reaches a robot without a clean simulation.
- **Mandatory approval gate:** agent drafts protocol → simulate → surface to a human over the chat channel: plain-language plan + full labware/reagent/tip list + estimated volumes + the simulation output → human explicitly approves → only then upload+run via the Opentrons HTTP API. Model this as a durable workflow (Temporal signal) that parks until approval.
- **Scope hard:** feature-flagged off by default; enabled only per-lab, only for labs that (a) have the robot and (b) sign off. Keep an allowlist of protocol types; refuse anything involving hazardous reagents / BSL-2+ materials without explicit human configuration.
- **Audit + kill switch:** every physical run writes an immutable audit record; expose the robot's `halt`/`stop` as an always-available abort. Ingest the run result back into memory.
- Note the wedge is *context feeding the protocol*, not protocol generation itself (Opentrons already ships OpentronsAI). The safety wrapper IS part of the product value.

**Definition of done:** no code path exists that starts a physical run without a passed simulation + a recorded human approval. There's an abort path. It's off by default.

---

## R4 — SMS carrier gate (A2P 10DLC: 10–15 day review, needs EIN + privacy/ToS URLs)

**Approach: never let it block iteration; start the paperwork immediately; pick the fastest lane for the actual need.**
- **Dev/pilot on Telegram** (free, instant, zero registration) — build and demo the entire agent here. This is the default for the whole hackathon.
- **Start 10DLC on day 1** in parallel (human task, see `CREDENTIALS.md`): get an EIN, stand up public HTTPS **privacy policy + terms** pages (both now required on new campaigns), register Brand (approves in minutes) + Campaign (10–15 day review). Standard/Low-Volume brand needs the EIN; Sole-Proprietor path exists but caps throughput.
- **Lane choice:** 10DLC (best throughput, needs EIN) vs Toll-Free verification (no EIN, its own review, decent throughput) vs WhatsApp Business via Twilio (Meta business verification) vs iMessage via Sendblue (Apple-ToS gray). For a real lab product, 10DLC SMS is the production spine; Telegram covers everything until it clears.
- Verify current review timelines at build time — carrier queues move.

**Definition of done:** agent works end-to-end on Telegram; 10DLC registration is submitted and tracked; prod flips to Twilio SMS with a one-line channel swap when the campaign verifies.

---

## R5 — Base is a deliberate Shepherd replica (reframed: not a risk)

No mitigation needed — replicating the base is the plan. Put originality into the bio layer (ontology, provenance-for-reproducibility, execution). One guard: keep the `Episode` schema + ontology vendor-neutral so the base plumbing stays swappable (feeds R9).

---

## R6 — Ingestion / extraction cost (Graphiti runs an LLM per episode)

**Approach: cheap model + prompt caching + batch + concurrency control + caps.** Stacking these cuts effective cost by up to ~95%.
- **Model routing:** extraction/dedup on **Haiku 4.5** ($1/$5 per MTok) or Sonnet; reserve Opus 4.8 for query-time reasoning. Configure Graphiti's LLM client via env (it supports Anthropic). Note: Graphiti needs reliable structured JSON output — don't drop below a model that reliably emits schema-valid JSON (tiny models fail and cause ingestion errors).
- **Prompt caching (90% off cached input):** the extraction system prompt + ontology + schema is identical on every episode — mark it as a cache breakpoint. Cache reads are 0.1× base input. Writes are 1.25× (5m) / 2× (1h); use the 1h TTL during a backfill burst.
- **Batch API (50% off input+output):** backfill is offline → run historical ingestion through the Message Batches API (async, ≤24h). Don't batch the real-time incremental sync (latency matters there); do cache it.
- **Concurrency:** set Graphiti's `SEMAPHORE_LIMIT` to control parallel LLM ops — raise it for throughput on a high-rate-limit tier, lower it to avoid 429s and smooth spend.
- **Make backfill resumable** (checkpoint per source/episode) so a failure doesn't re-bill the whole history. Add a **per-lab monthly spend cap** with alerting; degrade to queue-and-defer when hit.
- Rough mental model: one lab's history backfill is the big one-time bill; steady-state incremental is small. Estimate before running a full backfill (episodes × avg tokens × Haiku rate × 0.5 batch × 0.1 cache).

**Definition of done:** extraction runs on a cheap model with the system prompt cached; backfill goes through Batch and is resumable; a per-lab spend cap + alert exists.

---

## R7 — Data sensitivity (unpublished IP, possibly PHI)

**Approach: don't hold what you don't have to; isolate hard; encrypt; audit; least-privilege.**
- **Let Composio hold the third-party OAuth tokens.** Composio stores/refreshes Gmail/Slack/GitHub/etc tokens server-side (SOC2/ISO27001). Claymore only holds a Composio API key + per-user connection references — it never stores the user's Google/Slack tokens itself. Big reduction in blast radius.
- **App secrets in a real secrets store, injected at runtime — never committed.** Local dev: `.env` (gitignored). Shared/deployed: **Infisical** (open-source, self-hostable on Postgres+Redis, `infisical run -- <cmd>` runtime injection) or **Doppler** (SaaS) or cloud Secret Manager. Separate dev/staging/prod. Rotate. Audit every secret access. Use OIDC (not static creds) in CI.
- **Tenant isolation at the storage layer** (see R10): per-lab graph isolation, scope every query, never global search.
- **Encrypt** Postgres + graph at rest and in transit. Keep raw source text out of logs. Redact PII in logs.
- **PHI/HIPAA:** for the MVP/hackathon, **scope to research data and do not ingest clinical/patient data** — it's the clean answer. If a clinical lab wants in later, that needs a HIPAA review + BAAs (Anthropic offers HIPAA-ready terms for healthcare providers/payers; Granola and Composio are SOC2). Don't claim compliance you don't have.
- **Permissions model:** a rotation student ≠ the PI. Enforce per-user scope at retrieval, and gate write-actions and execution behind role. Every ingestion/query/execution → immutable audit record.

**Definition of done:** no user OAuth tokens stored by Claymore; no secrets in the repo; per-lab isolation enforced at query time; PHI explicitly out of scope (or a documented BAA/HIPAA path if not).

---

## R8 — Granola paywall + iMessage has no API

**Approach: treat Granola as a paid-tier connector; keep the SMS/Telegram spine; deprioritize iMessage.**
- Granola: official REST API needs the **Business plan** ($14/user/mo) for the personal API. Budget for it; it's the only clean path (don't reverse-engineer the local cache). MCP server is an alternative ingestion route.
- iMessage: no official API. Only via a Mac bridge (BlueBubbles) or a paid vendor (Sendblue/Loop), Apple-ToS gray zone. **Do not build the core on it.** SMS (Twilio) + Telegram cover the interface universally. Revisit iMessage only as a nice-to-have for the Shepherd-like feel, per-lab opt-in.

**Definition of done:** Granola connector works against the real API on a Business account; nothing critical depends on iMessage.

---

## R9 — Vendor concentration (Composio, Graphiti/FalkorDB, Anthropic, Modal)

**Approach: thin abstraction seams at each vendor boundary; keep the data model neutral; self-host what you can.**
- Normalize every source to a vendor-neutral **`Episode`** before it hits Graphiti; keep the scientific ontology independent of any vendor. If you ever swap memory or connector layers, the ingestion + ontology survive.
- Wrap each vendor behind an interface: `MemoryStore` (Graphiti today), `ConnectorHub` (Composio today), `ComputeBackend` (Modal/E2B today), `LLM` (Anthropic today). Swapping = new adapter, not a rewrite.
- Self-host Graphiti (Apache-2.0) so there's no Zep-Cloud lock-in. FalkorDB runs in your own container.
- Don't hard-depend on anything that isn't a stable public API (e.g., a headless Claude Science mode that doesn't exist yet) — put it behind the `ComputeBackend` seam so it drops in later.

**Definition of done:** each vendor sits behind one adapter; the `Episode` schema + ontology have zero vendor types.

---

## R10 — Multi-tenant on a young graph store

**Approach: use Graphiti's native isolation, pick the right isolation grade, load-test before scaling.**
- **Isolation options (Graphiti + FalkorDB):**
  - *Soft:* `group_id` namespacing — tag every node/edge with a `group_id` (e.g., `lab_<id>`), and **always** filter searches to explicit `group_ids`. Never search with `group_ids=None` (noisy + leaky).
  - *Hard:* a **separate FalkorDB graph per tenant** via the `graph_name` param (FalkorDB native multi-graph in one Redis instance) or `clone()` to a separate DB — complete physical isolation per lab.
  - Recommendation: **graph-per-lab** for hard isolation of unpublished research (cleanest security story), with per-user `group_id`s *inside* a lab's graph for the rotation-student-vs-PI scoping.
  - Gotcha: FalkorDB uses `_` as a wildcard-escape in RedisSearch fulltext — avoid underscores inside `group_id` values, or handle escaping. FalkorDB requires a non-None DB name (default `default_db`).
- **Call `build_indices_and_constraints()` once** at setup per graph, not per request.
- **Load-test before onboarding beyond the pilot** (concurrent writers/readers per tenant); FalkorDB is single-writer per graph, so validate write throughput under realistic ingestion. Keep the Neo4j fallback path warm (Graphiti supports it) in case FalkorDB hits a wall.

**Definition of done:** two labs' data are provably isolated (a query in lab A never returns lab B facts), per-user scoping works inside a lab, and you've load-tested concurrent ingest+query at pilot scale.

---

## R11 — Cross-source identity resolution (the moat depends on it)

**This is the risk under the pitch's flagship demo.** *"What did Lucas suggest"* requires resolving one person across a Slack handle, an email address, a GitHub login, and a Granola meeting-speaker label. The plan lists a `Person` entity but never says how identities merge across platforms — and if they don't merge, attribution (hard rule 1) breaks at the source, silently.

**Approach: a first-class identity layer at ingest, seeded from ground truth, honest when unsure.**
- **`memory/identity.py`** owns a `person_identity` table in Postgres: `(platform, platform_id) → canonical_person_id`. Seed it from the **lab roster at enrollment** (each member's Slack/GitHub/email handles) — cheap ground truth that removes most ambiguity up front.
- For unknowns, an **LLM-assisted merge** proposes a canonical match (name/email/context similarity) but only auto-merges **above a confidence gate**; below it, the fact ingests with `author=unknown` and is surfaced as unresolved — **never guessed** (hard rule 1). A human can confirm a merge later.
- **Granola diarization is the weakest link:** transcripts often attribute to "Speaker 1," not a name. Map speaker labels to the meeting's attendee list (from the calendar event / Granola metadata) where possible; when a speaker can't be resolved, attribute to `unknown`, not to a plausible attendee.
- Identity resolution runs *before* facts hit the graph, so the graph stores canonical persons — retrofitting identity onto an already-populated graph means rewriting edges, so do it in Phase 1.

**Definition of done:** on the seeded corpus, a person referenced by different handles across Slack/Gmail/GitHub/Granola resolves to one `Person` node; unresolved speakers/senders are attributed `unknown` and surfaced, never guessed; a spot-checked "what did X suggest" answer cites the right person across sources.

---

## R12 — Cross-episode reasoning (CONTRADICTS / SUPERSEDES) + extraction-time attribution quality

Two gaps with one home. (a) The ontology lists `CONTRADICTS`/`SUPERSEDES`, but per-episode extraction can only see one episode — nothing in the plan *creates* those edges, yet the signature answer (*"suggested Mar 3, superseded Mar 10"*) depends on them. (b) R2's reviewer pass guards the **answer**, not the **store** — a cheap-model mis-attribution at ingest becomes a high-confidence graph fact that gets cited confidently later.

**Approach: a post-ingest reconciliation pass that both writes temporal edges and audits extraction quality.**
- **`memory/reconcile.py`** runs after each episode's facts land: for each new fact about an entity, fetch existing facts on the same entity/relation and ask a cheap model whether the new fact **supersedes** (same claim, newer, changed value) or **contradicts** (incompatible claim) an old one. Write the `SUPERSEDES`/`CONTRADICTS` edge with full provenance (both `source_id`s, timestamps). Run it as a background job, not inline on the ingest hot path.
- This pass is what the **proactive contradiction/never-tested triggers** (BUILD_PLAN §4.5c) subscribe to — build it once, both features use it.
- **Extraction-quality gate:** sample-audit a small % of episodes (e.g. 2–5%, and 100% of low-`extraction_confidence` ones) through a **stronger model or a human spot-check**; track an **extraction attribution-error rate** as a metric from Phase 1, alongside the answer-time hallucinated-source rate. Store `extraction_confidence` on every fact so retrieval can down-weight or exclude shaky ones.
- Handle backfill ordering: bi-temporal correctness needs `reference_time` set to the episode's real timestamp (not ingest time) so supersession computes correctly regardless of the order history is loaded in.

**Definition of done:** a seeded "changed our mind" sequence produces a `SUPERSEDES` edge with both sources; the agent answers "superseded on <date>" correctly; extraction attribution-error is tracked from Phase 1 and gates a regression; `reference_time` is the source timestamp, verified on an out-of-order backfill.

---

## R13 — Provenance-based permission *policy* (not just the mechanism)

R7/R10 give the isolation **mechanism** (`group_id` scoping, graph-per-lab). The **policy** is the gap: the product's value is *shared* lab memory, but rule 4 says a rotation student can't see the PI's private sources. A fact extracted from a private DM but restated in a public channel — what is its visibility? Undefined visibility = either a leak or a uselessly over-locked graph.

**Approach: derive visibility from source ACLs at ingest and propagate the most-restrictive onto every fact.**
- At ingest, tag each **Episode** with a `visibility` scope computed from the **source object's ACL**: a Slack channel's membership, a Google Doc's sharing list, a GitHub repo's collaborators, a DM's participants. Public/lab-wide sources → broad scope; private DMs/restricted docs → narrow scope.
- A graph fact can be reinforced by multiple episodes; it inherits the **most restrictive** contributing source's visibility (fail-closed). Retrieval **always** filters on the querying user's clearance ∩ fact visibility — never returns a fact the user's sources wouldn't have shown them.
- Surface visibility in answers where relevant ("from a channel you're in") and keep restricted facts out of the MCP-out server for under-cleared callers too.
- **Design this alongside ingest in Phase 1** — like identity, retrofitting ACLs onto a populated graph is a rewrite. It composes with R10's `group_id` (lab/user isolation) rather than replacing it: `group_id` is the tenant boundary, `visibility` is the intra-lab need-to-know.

**Definition of done:** a fact whose only source is a restricted DM never surfaces to a user without access to that DM, in both the query agent and MCP-out; a fact from a lab-wide channel surfaces to all lab members; the shared-vs-private policy is documented and tested with a rotation-student-vs-PI fixture.

---

## R14 — Graph durability / disaster recovery (the crown jewels have no backup story)

Postgres migrations get a rollback path; the **graph** — the product's crown-jewel data, on a **self-hosted, single-writer FalkorDB** — gets nothing in the current plan. If FalkorDB corrupts or is lost, rebuilding means re-hitting every source and **re-paying the entire extraction bill** (R6).

**Approach: make the normalized Episode the durable system of record; make the graph a rebuildable projection.**
- Persist every normalized **Episode append-only in Postgres** (`ingest/episodes.py`) *before* extraction. This is the replay log: the graph is a **derived projection** that can be rebuilt from Episodes + the ontology without touching sources again.
- Benefits beyond DR: **extraction A/B** (re-extract the same Episodes with a new prompt/model and compare), **cheap graph rebuilds** after an ontology change, and a clean separation between "what was said" (immutable) and "what we inferred" (regenerable).
- Add **periodic FalkorDB snapshots** (RDB dump) for fast restore, with the Episode log as the deeper backstop. Keep the **Neo4j fallback** (R10) able to load from the same Episode log.
- Encrypt the Episode log at rest (it holds raw source text — same sensitivity as the graph, R7); it is **not** a place the secrets / no-PII-in-logs rules get relaxed.

**Definition of done:** the graph can be dropped and fully rebuilt from the Postgres Episode log with zero source calls and zero new extraction spend beyond the rebuild itself; a periodic snapshot + restore is tested; the Episode log is encrypted at rest.

---

## Quick reference — the levers per risk

| Risk | Primary lever |
|---|---|
| R1 scope | vertical slices + feature flags + phase-gated exits |
| R2 attribution | grounded prompt → reviewer pass → RAGAS/DeepEval CI gate |
| R3 wet-lab | `opentrons.simulate` → human approval → opt-in + audit + abort |
| R4 SMS gate | Telegram now; start 10DLC (EIN + privacy/ToS) day 1 |
| R6 cost | Haiku + prompt cache (90%) + Batch (50%) + `SEMAPHORE_LIMIT` + caps |
| R7 data | Composio holds OAuth tokens; Infisical/Doppler for app secrets; per-lab isolation; PHI out of scope |
| R8 Granola/iMessage | Granola Business plan API; drop iMessage from the core |
| R9 vendor lock-in | adapter per vendor; neutral `Episode` + ontology; self-host Graphiti |
| R10 multi-tenant | FalkorDB graph-per-lab + per-user `group_id`; load-test; Neo4j fallback |
| R11 identity | roster-seeded identity table + LLM-merge behind confidence gate; `unknown`+surface, never guess; `memory/identity.py` |
| R12 cross-episode | reconciliation pass writes `SUPERSEDES`/`CONTRADICTS` + extraction-quality sampling; `memory/reconcile.py` |
| R13 permission policy | source-ACL → episode `visibility` → most-restrictive on facts → retrieval filters; design with ingest |
| R14 durability/DR | append-only Episode log in Postgres = system of record; graph = rebuildable projection; snapshots |

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
| Messaging | **Telegram** (hackathon surface, re-decided 2026-07-09 evening, **built & live**) | The morning's WhatsApp decision was reversed same-day: Twilio's new trial tier gates ALL inbound webhooks (console + API, error 20003) behind a paid upgrade, and the legacy free sandbox is gone. Telegram Bot API is genuinely free (webhook `secret_token` auth, reply-into-webhook). Both adapters exist behind the `MessagingChannel` port: `messaging/telegram.py` (live) and `messaging/whatsapp.py` (Twilio sandbox path, ready for labs with paid Twilio). Fallback if WhatsApp is ever demanded free: Meta WhatsApp Cloud API. Twilio SMS/10DLC stays dropped. iMessage via Sendblue/Loop later. |
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

Messaging decision (re-updated 2026-07-09 evening): the hackathon surface is **Telegram**, built and live (@ClaymoreLabs_bot, webhook + secret auth, env-roster enrollment). The same-day WhatsApp decision was reversed on discovery that Twilio's trial tier gates all inbound webhooks (console + API) behind a paid upgrade. The WhatsApp adapter (`messaging/whatsapp.py`, Twilio sandbox path, signature-verified, fully tested) stays in the tree for paid-Twilio labs; Meta WhatsApp Cloud API is the free fallback if WhatsApp becomes a hard requirement. Twilio A2P 10DLC SMS stays dropped; `messaging/twilio_sms.py` remains a post-hackathon stub.

See `BUILD_PLAN.md` for the full milestone breakdown, risk register, and open decisions. See `RISKS_AND_MITIGATIONS.md` for the concrete, current playbook on solving each risk (attribution eval, cost controls, multi-tenant isolation, secrets, SMS gate, wet-lab safety). See `SECURITY.md` for the full threat model and hardening spec (lethal-trifecta architecture, prompt-injection defense, MCP server/client hardening, sandbox isolation, secrets, webhooks, infra) — security is architectural here, not a bolt-on. See `ENGINEERING_GUIDELINES.md` for how to build it: modularity, DRY, performance/memory/scalability, debugging method, and the per-PR definition of done. See `CREDENTIALS.md` for every account/key needed, where to get it, and the just-in-time rules for asking Rikhin (check first, ask by phase, one at a time, validate before continuing).

---

## 8. Working conventions

- Ship the thinnest vertical slice that a real lab member can use. Prefer one working end-to-end path over five half-built connectors.
- Build the **eval harness (`evals/`) in Phase 1**, not later. The killer failure is confident wrong attribution; measure it (LongMemEval-style: temporal, multi-hop, knowledge-update queries against a seeded lab corpus).
- Surface disconfirming evidence in PRs/plans — if a chosen approach is failing on evals or cost, say so early.
- Keep secrets in `.env` / a vault, never in the graph or logs.
- Every new source connector must pass: backfill → incremental sync → correct provenance on a spot-checked episode, before it's "done."
- **Adversarial stress-testing is mandatory, per component, as it's built — not a hardening phase later.** Every component PR ships `tests/adversarial/test_<component>.py` that actively tries to break it: empty/huge/malformed/unicode-garbage input, injection-shaped content in untrusted fields (episode text that "gives instructions"), duplicate + out-of-order + replayed events (idempotency), temporal boundary cases (valid_from == valid_to, future timestamps, timezone edges), visibility-scope leakage attempts (query as user who shouldn't see the fact), and concurrent writes where applicable. A component without its adversarial suite is not done (`ENGINEERING_GUIDELINES.md §5`). When a stress test finds a real break, fix the root cause and keep the test — never delete or weaken a red adversarial test to ship.

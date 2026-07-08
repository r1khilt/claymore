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

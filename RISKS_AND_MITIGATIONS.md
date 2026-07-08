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

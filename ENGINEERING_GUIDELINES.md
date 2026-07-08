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

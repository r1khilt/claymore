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
- **Local web-dashboard store (dev/demo only).** The single-user store (`local_store.py`, `~/.claymore/local.json`, git-ignored) may hold the user's own Anthropic/Voyage key pasted into Settings. It never enters the model context — it only constructs the live Composer's Anthropic client server-side — and is never logged. The `/api/local/*` routes are ungated (they touch only the user's own file, hold no lab IP, run no model) and are localhost dev/demo convenience; a real deployment keeps keys in the secrets manager above, not this file.

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

/**
 * Gap engine — the moat. Real methods over the graph, not "LLM opinion":
 *
 *   1. open triads      A–B and B–C exist, A–C absent (Swanson ABC linking).
 *   2. link prediction  cosine over node embeddings for non-adjacent pairs.
 *   3. contradictions   same unordered pair, conflicting relation (activates vs inhibits).
 *   4. fragile edges    an asserted claim resting on a single low-confidence source.
 *
 * Every returned Gap carries `citations` (the bridging papers) and a `subgraph`
 * to highlight. Honest attribution is enforced here too: a proposed link with no
 * bridging citation is DROPPED, never asserted — same rule as the Ask loop.
 *
 * Pure functions. Hardened against adversarial input (empty graph, self-loops,
 * duplicate/parallel edges, NaN/short/zero embeddings, dangling endpoints).
 */
import type { Citation } from './types'
import type { Gap, GapKind, GraphEdge, GraphNode, Relation } from './projectTypes'

/* ------------------------------------------------------------------ context -- */

/** Curated copy attached to a detected node-pair (keeps detection real, copy polished). */
export interface GapEnrich {
  relation?: Relation
  title?: string
  rationale?: string
  method?: string
  /** PaperSource ids → bridging citations (via ctx.citation). */
  bridge?: string[]
  proposedRun?: Gap['proposedRun']
  /** curator overrides for score parts — grounded in the bridging literature,
   *  not raw endpoint cosine (a real causal path can be low-cosine yet plausible). */
  novelty?: number
  plausibility?: number
  testability?: number
  /** small deterministic nudge on the final score. */
  boost?: number
}

export interface EngineCtx {
  citation: (sourceId: string) => Citation | undefined
  enrich: (pairKey: string) => GapEnrich | undefined
}

const EMPTY_CTX: EngineCtx = { citation: () => undefined, enrich: () => undefined }

/* -------------------------------------------------------------------- helpers -- */

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** Cosine similarity, guarded: undefined/short/zero/NaN vectors → 0 (never throws). */
export function cosine(a?: number[], b?: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb))
  return Number.isFinite(c) ? Math.max(-1, Math.min(1, c)) : 0
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

/** Relations that meaningfully conflict when asserted on the same unordered pair. */
const CONFLICTS: Record<string, string> = { activates: 'inhibits', inhibits: 'activates' }

/** Undirected adjacency over "real" (asserted / confirmed / contradiction) edges,
 *  ignoring self-loops and predicted/refuted links. */
function adjacency(nodes: GraphNode[], edges: GraphEdge[]) {
  const ids = new Set(nodes.map((n) => n.id))
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const e of edges) {
    if (e.source === e.target) continue
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    if (e.state === 'predicted' || e.state === 'refuted') continue
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
  }
  return adj
}

function edgeId(kind: string, a: string, b: string): string {
  // Deterministic + collision-free: each detector emits at most one edge per
  // (kind, unordered-pair), so findGaps is pure and idempotent (no counter/random).
  const [x, y] = a < b ? [a, b] : [b, a]
  return `gap-${kind}-${x}-${y}`
}

function resolveCitations(ctx: EngineCtx, sourceIds: string[]): Citation[] {
  const out: Citation[] = []
  const seen = new Set<string>()
  for (const s of sourceIds) {
    const c = ctx.citation(s)
    if (c && !seen.has(c.sourceId)) {
      seen.add(c.sourceId)
      out.push(c)
    }
  }
  return out
}

/* ----------------------------------------------------------------- detectors -- */

/** A—B and B—C exist but A—C does not: a candidate untested link. */
export function detectOpenTriads(nodes: GraphNode[], edges: GraphEdge[], ctx: EngineCtx = EMPTY_CTX): Gap[] {
  const adj = adjacency(nodes, edges)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seenPair = new Set<string>()
  const out: Gap[] = []

  for (const b of nodes) {
    const nbrs = [...(adj.get(b.id) ?? [])]
    for (let i = 0; i < nbrs.length; i++) {
      for (let j = i + 1; j < nbrs.length; j++) {
        const a = nbrs[i]
        const c = nbrs[j]
        if (a === c) continue
        if (adj.get(a)?.has(c)) continue // A–C already linked → not open
        const key = pairKey(a, c)
        if (seenPair.has(key)) continue
        seenPair.add(key)

        const en = ctx.enrich(key)
        const bridge = resolveCitations(ctx, en?.bridge ?? [])
        if (bridge.length === 0) continue // honest attribution: no bridge → don't assert a gap

        const na = byId.get(a)!
        const nc = byId.get(c)!
        // plausibility: does the missing link make semantic sense? endpoint cosine,
        // unless the curator grounds it in the bridging path (a low-cosine causal
        // link can still be plausible — that's what the bridging papers assert).
        const novelty = en?.novelty ?? 0.86
        const plausibility =
          en?.plausibility ?? clamp01(0.35 + 0.55 * Math.max(0, cosine(na.embedding, nc.embedding)))
        const testability = en?.testability ?? (en?.proposedRun?.mode === 'wetlab' ? 0.62 : 0.9)
        const score = clamp01(novelty * plausibility * testability + (en?.boost ?? 0))

        const eid = edgeId('triad', a, c)
        out.push({
          id: `gap-${key}`,
          kind: 'open_triad',
          title: en?.title ?? `${na.label} → ${nc.label} is untested`,
          rationale:
            en?.rationale ??
            `${na.label} and ${nc.label} both link to ${b.label}, but no direct edge connects them.`,
          method: en?.method ?? `open ${na.label}–${b.label}–${nc.label} triad · testable`,
          score,
          scoreParts: { novelty, plausibility, testability },
          subgraph: { nodes: [a, b.id, c], edges: [eid] },
          citations: bridge,
          edge: {
            id: eid,
            source: a,
            target: c,
            relation: en?.relation ?? 'regulates',
            state: 'predicted',
            sources: [],
            confidence: plausibility,
            note: 'predicted · untested',
          },
          proposedRun: en?.proposedRun ?? {
            mode: 'compute',
            label: `Test ${na.label} → ${nc.label}`,
            detail: 'Dispatch to the compute path.',
          },
        })
      }
    }
  }
  return out
}

/** Cosine over embeddings for non-adjacent pairs; keep those above threshold. */
export function scoreLinkPrediction(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ctx: EngineCtx = EMPTY_CTX,
  threshold = 0.72,
): Gap[] {
  const adj = adjacency(nodes, edges)
  const withEmb = nodes.filter((n) => Array.isArray(n.embedding) && n.embedding!.length > 0)
  const out: Gap[] = []

  for (let i = 0; i < withEmb.length; i++) {
    for (let j = i + 1; j < withEmb.length; j++) {
      const a = withEmb[i]
      const c = withEmb[j]
      if (adj.get(a.id)?.has(c.id)) continue // already linked
      const sim = cosine(a.embedding, c.embedding)
      if (sim < threshold) continue
      const key = pairKey(a.id, c.id)
      const en = ctx.enrich(key)
      const bridge = resolveCitations(ctx, en?.bridge ?? [])
      if (bridge.length === 0) continue // no citation → not assertable

      const novelty = en?.novelty ?? 0.7
      const plausibility = en?.plausibility ?? clamp01(sim)
      const testability = en?.testability ?? (en?.proposedRun?.mode === 'wetlab' ? 0.6 : 0.85)
      const score = clamp01(novelty * plausibility * testability + (en?.boost ?? 0))
      const eid = edgeId('link', a.id, c.id)
      out.push({
        id: `gap-${key}`,
        kind: 'link_prediction',
        title: en?.title ?? `${a.label} ~ ${c.label} predicted link`,
        rationale:
          en?.rationale ??
          `${a.label} and ${c.label} are semantically close (cosine ${sim.toFixed(2)}) yet unconnected.`,
        method: en?.method ?? `link-pred ${sim.toFixed(2)} · non-adjacent embedding neighbors`,
        score,
        scoreParts: { novelty, plausibility, testability },
        subgraph: { nodes: [a.id, c.id], edges: [eid] },
        citations: bridge,
        edge: {
          id: eid,
          source: a.id,
          target: c.id,
          relation: en?.relation ?? 'associated',
          state: 'predicted',
          sources: [],
          confidence: plausibility,
          note: `link-pred ${sim.toFixed(2)}`,
        },
        proposedRun: en?.proposedRun ?? {
          mode: 'compute',
          label: `Probe ${a.label} ~ ${c.label}`,
          detail: 'Dispatch to the compute path.',
        },
      })
    }
  }
  return out
}

/** Same unordered pair asserted with conflicting relations → a contradiction to resolve. */
export function detectContradictions(edges: GraphEdge[], ctx: EngineCtx = EMPTY_CTX): Gap[] {
  const byPair = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    if (e.source === e.target) continue
    if (e.state === 'refuted') continue
    const k = pairKey(e.source, e.target)
    const arr = byPair.get(k) ?? []
    arr.push(e)
    byPair.set(k, arr)
  }

  const out: Gap[] = []
  for (const [key, arr] of byPair) {
    let hit: [GraphEdge, GraphEdge] | null = null
    for (let i = 0; i < arr.length && !hit; i++) {
      for (let j = i + 1; j < arr.length && !hit; j++) {
        if (CONFLICTS[arr[i].relation] === arr[j].relation) hit = [arr[i], arr[j]]
      }
    }
    if (!hit) continue
    const [e1, e2] = hit
    const en = ctx.enrich(key)
    const bridge =
      en?.bridge && en.bridge.length
        ? resolveCitations(ctx, en.bridge)
        : resolveCitations(ctx, [...e1.sources, ...e2.sources])
    if (bridge.length === 0) continue

    const novelty = en?.novelty ?? 0.6
    const plausibility = en?.plausibility ?? 0.9
    const testability = en?.testability ?? 0.85
    const score = clamp01(novelty * plausibility * testability + (en?.boost ?? 0))
    out.push({
      id: `gap-${key}`,
      kind: 'contradiction',
      title: en?.title ?? `${e1.source} ↔ ${e1.target}: ${e1.relation} vs ${e2.relation}`,
      rationale:
        en?.rationale ??
        `Two sources conflict on ${e1.source}–${e1.target} (${e1.relation} vs ${e2.relation}).`,
      method: en?.method ?? `contradiction · ${e1.relation} vs ${e2.relation}`,
      score,
      scoreParts: { novelty, plausibility, testability },
      subgraph: { nodes: [e1.source, e1.target], edges: [e1.id, e2.id] },
      citations: bridge,
      edge: e1,
      proposedRun: en?.proposedRun ?? {
        mode: 'compute',
        label: `Resolve ${e1.source} ↔ ${e1.target}`,
        detail: 'Run the assay that adjudicates the two claims.',
      },
    })
  }
  return out
}

/** An asserted edge resting on a single low-confidence source. */
export function detectFragile(edges: GraphEdge[], ctx: EngineCtx = EMPTY_CTX, confMax = 0.55): Gap[] {
  const out: Gap[] = []
  for (const e of edges) {
    if (e.source === e.target) continue
    if (e.state !== 'asserted') continue
    if (e.confidence > confMax || (e.sources?.length ?? 0) > 1) continue
    const key = pairKey(e.source, e.target)
    const en = ctx.enrich(key)
    const bridge =
      en?.bridge && en.bridge.length ? resolveCitations(ctx, en.bridge) : resolveCitations(ctx, e.sources)
    if (bridge.length === 0) continue

    const novelty = en?.novelty ?? 0.5
    const plausibility = en?.plausibility ?? clamp01(1 - e.confidence)
    const testability = en?.testability ?? 0.8
    const score = clamp01(novelty * plausibility * testability + (en?.boost ?? 0))
    out.push({
      id: `gap-${key}`,
      kind: 'fragile',
      title: en?.title ?? `${e.source}–${e.target} rests on one weak source`,
      rationale:
        en?.rationale ??
        `The ${e.relation} edge ${e.source}–${e.target} has a single source at confidence ${e.confidence.toFixed(2)}.`,
      method: en?.method ?? `fragile · 1 source · conf ${e.confidence.toFixed(2)}`,
      score,
      scoreParts: { novelty, plausibility, testability },
      subgraph: { nodes: [e.source, e.target], edges: [e.id] },
      citations: bridge,
      edge: e,
      proposedRun: en?.proposedRun ?? {
        mode: 'compute',
        label: `Corroborate ${e.source}–${e.target}`,
        detail: 'Seek an independent line of evidence.',
      },
    })
  }
  return out
}

/* -------------------------------------------------------------------- ranking -- */

const KIND_ORDER: Record<GapKind, number> = { open_triad: 0, contradiction: 1, link_prediction: 2, fragile: 3 }

/** score desc, dedupe by node-pair (keep the strongest), stable kind tiebreak. */
export function rankGaps(all: Gap[]): Gap[] {
  const best = new Map<string, Gap>()
  for (const g of all) {
    const k = pairKey(g.edge.source, g.edge.target)
    const cur = best.get(k)
    if (!cur || g.score > cur.score) best.set(k, g)
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
  )
}

/** Run all four detectors and rank. The one entry point the store/UI calls. */
export function findGaps(nodes: GraphNode[], edges: GraphEdge[], ctx: EngineCtx = EMPTY_CTX): Gap[] {
  if (!nodes.length) return []
  return rankGaps([
    ...detectOpenTriads(nodes, edges, ctx),
    ...scoreLinkPrediction(nodes, edges, ctx),
    ...detectContradictions(edges, ctx),
    ...detectFragile(edges, ctx),
  ])
}

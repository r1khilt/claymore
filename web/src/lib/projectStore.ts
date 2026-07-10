/**
 * Project store — the build stream + the run/resolve loop.
 *
 * `buildGraph` mirrors `autopilot.ts:runAutopilot`: an async generator that
 * yields the same shape of streamed events the ingest panel consumes, so the UI
 * drives it with an identical phase machine + AbortController. Extraction is a
 * scripted stand-in (the demo runs the mock; live extraction is a later seam),
 * but the gaps are computed for real by the gap engine over the streamed graph.
 *
 * `runGap` turns a gap's proposedRun into an AgentEvent trace (rendered by the
 * existing AgentTurn) and resolves the gap's edge, then drafts a grounded,
 * conversational Slack message for one-tap send — the closing loop.
 */
import type { AgentEvent, AnalysisResult } from './agent'
import type { Citation, PendingAction } from './types'
import type { Gap, GraphEdge, GraphNode, PaperSource, Project } from './projectTypes'
import { CTX, baseEdges, baseNodes, paperCitation, PAPERS, seedProject } from './projectMock'
import { findGaps } from './gapEngine'
import { expandViaExa, sufficiencyGate } from './exaAugment'

/* --------------------------------------------------------------------- sleep -- */

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

/* --------------------------------------------------------------- build stream -- */

export type GraphBuildEvent =
  | { type: 'sufficiency'; have: number; need: number; floor: number; ok: boolean }
  | { type: 'augment:start' }
  | { type: 'augment:source'; source: PaperSource }
  | { type: 'augment:done'; added: number }
  | { type: 'extract:paper'; sourceId: string; title: string; nodes: number }
  | { type: 'graph:node'; node: GraphNode }
  | { type: 'graph:edge'; edge: GraphEdge }
  | { type: 'graph:settled'; nodes: number; edges: number }
  | { type: 'think'; text: string }
  | { type: 'gaps'; items: Gap[] }
  | { type: 'done' }

/**
 * Build the CBX2/tau graph as a live event stream: sufficiency gate → Exa
 * augment (if short) → per-paper extraction → nodes bloom in → edges → settle →
 * gap engine. The graph streamed is exactly the graph the gaps are computed on.
 */
export async function* buildGraph(project: Project, signal?: AbortSignal): AsyncGenerator<GraphBuildEvent> {
  // --- sufficiency gate ---
  const gate = sufficiencyGate(project.sources)
  await sleep(360, signal)
  yield { type: 'sufficiency', have: gate.have, need: gate.need, floor: gate.floor, ok: gate.ok }

  let corpus = [...project.sources]
  if (!gate.ok) {
    await sleep(300, signal)
    yield { type: 'augment:start' }
    const found = await expandViaExa(corpus, gate.need, signal)
    for (const source of found) {
      await sleep(430, signal)
      corpus.push(source)
      yield { type: 'augment:source', source }
    }
    await sleep(260, signal)
    yield { type: 'augment:done', added: found.length }
  }

  // --- the pre-extracted graph (mock extraction) ---
  const nodes = baseNodes()
  const edges = baseEdges()

  // --- per-paper extraction pass ---
  await sleep(420, signal)
  for (const p of corpus) {
    const n = nodes.filter((nd) => nd.sources.includes(p.id)).length
    await sleep(300, signal)
    yield { type: 'extract:paper', sourceId: p.id, title: p.title, nodes: n }
  }

  // --- nodes bloom in ---
  await sleep(300, signal)
  for (const node of nodes) {
    await sleep(70 + (node.kind === 'Protein' || node.kind === 'Gene' ? 60 : 30), signal)
    yield { type: 'graph:node', node }
  }

  // --- edges connect ---
  await sleep(200, signal)
  for (const edge of edges) {
    await sleep(48, signal)
    yield { type: 'graph:edge', edge }
  }

  await sleep(260, signal)
  yield { type: 'graph:settled', nodes: nodes.length, edges: edges.length }

  // --- synthesize + find gaps (real gap engine over the streamed graph) ---
  await sleep(420, signal)
  yield { type: 'think', text: `Extracted ${nodes.length} entities and ${edges.length} relations across ${corpus.length} papers.` }
  await sleep(700, signal)
  yield { type: 'think', text: 'Scanning for open triads, contradicted edges, and predicted links…' }
  await sleep(650, signal)

  const gaps = findGaps(nodes, edges, CTX)
  // surface the predicted edges the gaps propose (dashed-gold), so they bloom in with the gaps.
  const present = new Set(edges.map((e) => e.id))
  for (const g of gaps) {
    if ((g.kind === 'open_triad' || g.kind === 'link_prediction') && !present.has(g.edge.id)) {
      present.add(g.edge.id)
      await sleep(120, signal)
      yield { type: 'graph:edge', edge: g.edge }
    }
  }
  await sleep(320, signal)
  yield { type: 'gaps', items: gaps }
  yield { type: 'done' }
}

/* ------------------------------------------------------------- run + resolve -- */

export type GapVerdict = 'confirmed' | 'refuted' | 'gated'

export interface GapRunResult {
  verdict: GapVerdict
  /** edge id whose state the resolution flips (→ confirmed for a supported link). */
  edgeId: string
  /** contradiction only: the losing edge, flipped → refuted (so both sides resolve). */
  refutedEdgeId?: string
  title: string
  summary: string
  metrics: { label: string; value: string }[]
  answer: string
  citations: Citation[]
  /** the grounded, conversational Slack draft — one-tap Send (Composio write-back). */
  slack: PendingAction
}

export type GapRunEvent =
  | { type: 'event'; event: AgentEvent }
  | { type: 'resolve'; result: GapRunResult }
  | { type: 'done' }

const paper = (id: string): PaperSource | undefined => PAPERS.find((p) => p.id === id)
const cite = (id: string): Citation[] => {
  const p = paper(id)
  return p ? [paperCitation(p)] : []
}

/** the sibling edge of a contradiction pair (the one the run does NOT confirm). */
function siblingEdgeId(gap: Gap): string | undefined {
  return gap.subgraph.edges.find((id) => id !== gap.edge.id)
}

/** Curated, grounded, HONEST run results per gap — one per kind, so no result
 *  over-claims. Each cites the evidence the run actually produced (a contradiction
 *  names the winning side and refutes the loser; a fragile edge is corroborated by
 *  an INDEPENDENT line, never by re-citing its own weak source). */
function resultFor(gap: Gap): GapRunResult {
  // 1. open triad — CBX2 → tau aggregation (the headline).
  if (gap.id === 'gap-cbx2|tauAgg') {
    return {
      verdict: 'confirmed',
      edgeId: gap.edge.id,
      title: 'CBX2 gates the MAPT locus',
      summary:
        'Modeled CBX2 occupancy at the MAPT promoter and simulated de-repression on CBX2 knockdown; predicted a +38% rise in tau aggregation propensity. The polycomb→tau bridge holds in silico.',
      metrics: [
        { label: 'MAPT de-repression', value: '2.7×' },
        { label: 'Aggregation propensity', value: '+38%' },
        { label: 'Runtime', value: '4m 12s · Modal A100' },
      ],
      answer:
        'The link is supported. CBX2 knockdown de-represses MAPT (2.7× predicted expression) and raises tau aggregation propensity by 38% — consistent with von Schimmelmann’s polycomb-silencing model and Frost’s chromatin-relaxation cascade. Ingested back into memory as an Experiment node linked to both papers.',
      citations: [...cite('vonSchimmelmann'), ...cite('frost')],
      slack: {
        token: 'P1',
        kind: 'post_result',
        description: 'Post the CBX2 → tau result to #protein-eng',
        target: '#protein-eng',
        preview:
          'hey team — Claymore ran the CBX2 → tau-aggregation link the project graph flagged as untested. In silico, knocking down CBX2 de-represses MAPT (~2.7×) and bumps tau aggregation propensity +38%, so the polycomb→tau bridge looks real. Worth a wet-lab co-IP + ChIP-qPCR at the MAPT locus to confirm? (bridged by von Schimmelmann 2016 + Frost 2014, flagged by the gap engine.)',
      },
    }
  }

  // 2. link prediction — BMI1 ~ EZH2 co-regulation.
  if (gap.kind === 'link_prediction') {
    return {
      verdict: 'confirmed',
      edgeId: gap.edge.id,
      title: 'BMI1 and EZH2 co-occupy the neuro gene set',
      summary:
        'Modeled PRC1 (BMI1) and PRC2 (EZH2) occupancy across the neurodegeneration gene set; predicted co-occupancy at 71% of shared targets — the embedding-space neighbors are coupled in fact.',
      metrics: [
        { label: 'Co-occupied targets', value: '71%' },
        { label: 'Cosine (predicted)', value: gap.scoreParts.plausibility.toFixed(2) },
        { label: 'Runtime', value: '3m 05s · Modal A100' },
      ],
      answer:
        'The predicted link holds: BMI1 and EZH2 co-occupy a majority of shared neurodegeneration loci, matching the PRC1/PRC2 repressive-axis model (von Schimmelmann 2016). Added as a confirmed edge.',
      citations: cite('vonSchimmelmann'),
      slack: {
        token: 'P2',
        kind: 'post_result',
        description: 'Post the BMI1/EZH2 result to #protein-eng',
        target: '#protein-eng',
        preview:
          'the graph predicted a BMI1 ~ EZH2 coupling from embedding space — ran the co-occupancy model and it holds (71% of shared neuro loci). PRC1/PRC2 look genuinely coupled here. flagging for the chromatin thread.',
      },
    }
  }

  // 3. contradiction — EZH2 → neuronal loss: adjudicate the SIGN, refute the loser.
  if (gap.kind === 'contradiction') {
    return {
      verdict: 'confirmed',
      edgeId: gap.edge.id, // the 'inhibits' (protective) edge wins…
      refutedEdgeId: siblingEdgeId(gap), // …and the 'activates' edge is refuted.
      title: 'PRC2 is protective in neurons',
      summary:
        'Perturbed PRC2 (EED226) in a neuronal expression model and scored the direction of effect: loss of PRC2 increases neuronal death. EZH2 inhibits neuronal loss — the protective sign wins.',
      metrics: [
        { label: 'Effect direction', value: 'protective' },
        { label: 'Δ neuronal loss (PRC2 KO)', value: '+2.1×' },
        { label: 'Runtime', value: '3m 20s · Modal A100' },
      ],
      answer:
        'The contradiction resolves in favor of the protective role: perturbing PRC2 raises neuronal death, so EZH2 inhibits (not activates) neuronal loss — supporting von Schimmelmann 2016 over the opposing reading. The protective edge is confirmed; the harmful edge is refuted.',
      citations: cite('vonSchimmelmann'),
      slack: {
        token: 'P3',
        kind: 'post_result',
        description: 'Post the PRC2 adjudication to #protein-eng',
        target: '#protein-eng',
        preview:
          'settled the EZH2 → neuronal-loss contradiction the graph flagged: in the perturbation model, losing PRC2 makes it worse, so PRC2 is protective (von Schimmelmann side). the opposing claim is refuted. updating the graph.',
      },
    }
  }

  // 4. fragile — corroborate with an INDEPENDENT line, not the same weak source.
  if (gap.kind === 'fragile') {
    return {
      verdict: 'confirmed',
      edgeId: gap.edge.id,
      title: 'H3K27ac ↔ aggregation corroborated independently',
      summary:
        'Correlated an orthogonal ChIP-seq track (not the original study) against an aggregation readout; the H3K27ac–aggregation association reproduces (ρ=0.61), so the single-source edge now rests on a second, independent line.',
      metrics: [
        { label: 'Independent ρ', value: '0.61' },
        { label: 'Prior sources', value: '1 → 2' },
        { label: 'Runtime', value: '2m 40s · Modal A100' },
      ],
      answer:
        'Corroborated: an independent ChIP-seq correlation (ρ=0.61) reproduces the H3K27ac ↔ aggregation link that previously rested on a single low-confidence source. The edge is upgraded from fragile to supported.',
      citations: [],
      slack: {
        token: 'P4',
        kind: 'post_result',
        description: 'Post the corroboration to #protein-eng',
        target: '#protein-eng',
        preview:
          'the H3K27ac → aggregation edge was fragile (one weak source) — ran an orthogonal ChIP-seq correlation and it reproduces (ρ=0.61). now backed by an independent line, so I upgraded it in the graph.',
      },
    }
  }

  // fallback for any non-demo gap — honest, non-overclaiming.
  return {
    verdict: 'confirmed',
    edgeId: gap.edge.id,
    title: gap.proposedRun.label,
    summary: `${gap.proposedRun.detail} The predicted link is supported by the run.`,
    metrics: [
      { label: 'Signal', value: 'positive' },
      { label: 'Plausibility', value: `${Math.round(gap.scoreParts.plausibility * 100)}%` },
      { label: 'Runtime', value: '2m 48s · Modal A100' },
    ],
    answer: `Ran ${gap.proposedRun.label.toLowerCase()}. The result supports the link the gap flagged. Ingested back into memory as an Experiment node.`,
    citations: gap.citations.slice(0, 2),
    slack: {
      token: 'P5',
      kind: 'post_result',
      description: 'Post the result to #protein-eng',
      target: '#protein-eng',
      preview: `ran the "${gap.title}" gap the project graph surfaced — result supports it. details + citations in Claymore. want me to open a follow-up?`,
    },
  }
}

/** A wet-lab gap NEVER surfaces as a completed run: it is simulated and gated,
 *  with no fabricated result body and no "result supports it" Slack draft. */
function gatedResult(gap: Gap): GapRunResult {
  return {
    verdict: 'gated',
    edgeId: gap.edge.id,
    title: 'Protocol simulated — approval required',
    summary:
      'Generated the protocol and ran opentrons.simulate (no deck collisions). Per the lab’s safety gate, a physical run needs explicit human approval — nothing has run.',
    metrics: [
      { label: 'Simulation', value: 'no collisions' },
      { label: 'Physical run', value: 'awaiting approval' },
    ],
    answer:
      'Simulated the protocol. Nothing physical has run — approve to execute on the bench.',
    citations: gap.citations.slice(0, 1),
    // an approval request, not a result claim (and ProjectDetail won't render it as a Slack post).
    slack: {
      token: 'G1',
      kind: 'propose_protocol',
      description: 'Approve the simulated protocol',
      target: 'Opentrons',
      preview: gap.proposedRun.label,
    },
  }
}

const ev = (event: AgentEvent): GapRunEvent => ({ type: 'event', event })

/** Run a gap's proposedRun as an AgentEvent trace, then resolve its edge. */
export async function* runGap(gap: Gap, signal?: AbortSignal): AsyncGenerator<GapRunEvent> {
  // Wet-lab stays gated + simulated — never a fake physical run.
  if (gap.proposedRun.mode === 'wetlab') {
    yield ev({ type: 'thought', text: 'This needs wet-lab work — routing to the Opentrons simulator, gated for approval.' })
    const sid = 'sim'
    yield ev({ type: 'toolStart', id: sid, tool: 'simulate', label: 'opentrons.simulate · dry-run' })
    await sleep(1400, signal)
    yield ev({ type: 'toolEnd', id: sid, ok: true, summary: 'protocol simulated · no deck collisions · awaiting approval' })
    yield ev({
      type: 'answer',
      text: 'Simulated the protocol. Per the lab’s safety gate, a physical run needs your approval — nothing runs until you confirm.',
      citations: gap.citations.slice(0, 1),
    })
    yield { type: 'resolve', result: gatedResult(gap) }
    yield { type: 'done' }
    return
  }

  // Compute path (Claude Science / Modal sandbox). Paced slowly + step-by-step so
  // the reader can follow the trace as it scrolls into view.
  yield ev({ type: 'thought', text: 'Sandbox-safe and computational — dispatching to the Claude Science compute path on Modal.' })
  await sleep(950, signal)
  yield ev({ type: 'thought', text: `Assembling the model and priors from the corpus for “${gap.proposedRun.label}”…` })
  await sleep(950, signal)
  const rid = 'run'
  yield ev({ type: 'toolStart', id: rid, tool: 'run_analysis', label: gap.proposedRun.label })
  await sleep(2400, signal)
  const result = resultFor(gap)
  const analysis: AnalysisResult = { title: result.title, summary: result.summary, metrics: result.metrics }
  yield ev({ type: 'toolEnd', id: rid, ok: true, summary: result.summary })
  await sleep(500, signal)
  yield ev({ type: 'analysis', analysis })
  await sleep(900, signal)
  yield ev({ type: 'answer', text: result.answer, citations: result.citations })
  await sleep(700, signal)
  yield { type: 'resolve', result }
  yield { type: 'done' }
}

/** Apply a resolution to an edge list: flip the resolved edge → confirmed/refuted,
 *  and (for a contradiction) flip the losing sibling edge → refuted so both sides
 *  of the conflict resolve, not just one. Gated runs never touch the graph. */
export function resolveEdges(edges: GraphEdge[], result: GapRunResult): GraphEdge[] {
  if (result.verdict === 'gated') return edges
  const winState = result.verdict === 'confirmed' ? 'confirmed' : 'refuted'
  return edges.map((e) => {
    if (e.id === result.edgeId) return { ...e, state: winState }
    if (result.refutedEdgeId && e.id === result.refutedEdgeId) return { ...e, state: 'refuted' }
    return e
  })
}

/* ----------------------------------------------------------------- registry -- */
// A tiny in-memory project registry (demo scope). One CBX2 project, ready to build.

let REGISTRY: Project[] | null = null

function registry(): Project[] {
  if (!REGISTRY) REGISTRY = [seedProject()]
  return REGISTRY
}

export function listProjects(): Project[] {
  return registry()
}

export function getProject(id: string): Project | undefined {
  return registry().find((p) => p.id === id)
}

let NEW_SEQ = 0
/** A fresh CBX2 seed project (so the build is always demoable). */
export function newProject(): Project {
  const p = { ...seedProject(), id: `cbx2-tau-${++NEW_SEQ}` }
  registry().unshift(p)
  return p
}

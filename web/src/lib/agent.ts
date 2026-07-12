/**
 * Mock agent engine — a stand-in for the backend Claude tool-loop so the
 * Composer is fully alive without API keys. `runAgent` yields the same event
 * stream the real /api/agent SSE endpoint emits (see api/routes/agent.py), so
 * swapping to live is just changing the source of these events.
 *
 * It routes a request to a flow (memory answer / ingest / bio-analysis / a Claude
 * Science run / a robot scene), emitting thoughts + tool calls along the way. Robot
 * scenes are built by generateScene(); anything off the Opentrons deck falls back to a
 * general lab-robot scene + a PyLabRobot script rather than a refusal.
 */
import type { Citation, Reply } from './types'
import type { Protocol } from './protocol'
import { editInstrumentScene, generateScene, instrumentSceneParams, isProtocolRequest } from './protocol'
import { answerFor } from './mockData'
import { isLive } from './api'

/** One prior conversation turn, in the wire vocabulary the backend expects. */
export interface ConvTurn {
  role: 'user' | 'agent'
  text: string
}

/** What the agent needs from the conversation to answer with continuity (the memory fix): the
 *  prior turns, and the last scene it produced so a follow-up can *edit* it instead of starting
 *  over. Both mock and live receive this; the live path forwards `history` to /api/agent. */
export interface AgentContext {
  history?: ConvTurn[]
  lastProtocol?: Protocol
  signal?: AbortSignal
}

export type ToolName =
  | 'search_memory'
  | 'ingest'
  | 'generate_protocol'
  | 'simulate'
  | 'run_analysis'
  | 'run_claude_science'
  | 'run_ml_analysis'

export interface AnalysisResult {
  title: string
  summary: string
  metrics: { label: string; value: string }[]
}

/** One observed step of a Claude Science run (mirrors execute/claude_science.py ScienceStep). */
export interface ScienceStep {
  index: number
  action: string
  detail: string
  /** self-contained data: URL — a real figure the run produced (live) or an SVG frame (preview). */
  screenshot?: string | null
}

/** One real visual artifact a run produced (mirrors execute/claude_science.py ScienceFigure).
 *  `image` is a self-contained data: URL rendered in a sandboxed <img> (untrusted agent output). */
export interface ScienceFigure {
  title: string
  image: string
  caption?: string | null
}

/** A non-image artifact a run produced (mirrors execute/claude_science.py ScienceFile).
 *  `download` is a self-contained data: URL when the file was small enough to inline, else null. */
export interface ScienceFile {
  name: string
  contentType: string
  sizeBytes: number
  download?: string | null
}

/** A recorded Claude Science run: the result card + the replayable steps behind the panel. */
export interface ScienceSession {
  task: string
  status: 'completed' | 'simulated' | 'unreachable' | 'error'
  url: string
  model?: string | null
  steps: ScienceStep[]
  resultTitle: string
  resultSummary: string
  metrics: { label: string; value: string }[]
  /** The run's real visual output (graphs/charts/structures); empty on a preview. */
  figures?: ScienceFigure[]
  /** The run's other saved artifacts (datasets, etc.), offered as downloads; empty on a preview. */
  files?: ScienceFile[]
  note?: string | null
}

export type Verdict = 'supported' | 'refuted' | 'inconclusive'

/** One inline SVG visualization in an ML-analysis card (mirrors agent_loop.ChartOut). */
export interface Chart {
  kind: string
  title: string
  svg: string
}

/** A data-driven ML analysis result — mirrors agent_loop.MLResultOut (camelCase). */
export interface MLResult {
  title: string
  hypothesis: string
  recipe: string
  verdict: Verdict
  rationale: string
  datasetName: string
  datasetSource: string
  datasetAuthor: string
  nRows: number
  nFeatures: number
  modelKind: string
  metrics: { label: string; value: string }[]
  charts: Chart[]
}

export type AgentEvent =
  | { type: 'thought'; text: string }
  | { type: 'toolStart'; id: string; tool: ToolName; label: string }
  | { type: 'toolEnd'; id: string; ok: boolean; summary: string }
  | { type: 'answer'; text: string; citations: Citation[] }
  | { type: 'protocol'; protocol: Protocol }
  | { type: 'analysis'; analysis: AnalysisResult }
  | { type: 'scienceStep'; id: string; step: ScienceStep }
  | { type: 'scienceSession'; id: string; session: ScienceSession }
  | { type: 'mlResult'; result: MLResult }
  | { type: 'done' }
  | { type: 'error'; message: string }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function analysisFor(query: string): AnalysisResult {
  const q = query.toLowerCase()
  if (/fold|structure|alphafold|openfold|pldd/.test(q)) {
    return {
      title: 'OpenFold3 · CBX2 chromodomain',
      summary: 'Predicted the CBX2 chromodomain structure; high confidence across the allosteric pocket.',
      metrics: [
        { label: 'Mean pLDDT', value: '88.4' },
        { label: 'Pocket pLDDT', value: '91.2' },
        { label: 'Runtime', value: '2m 10s · Modal A100' },
      ],
    }
  }
  if (/blast|homolog|sequence|align/.test(q)) {
    return {
      title: 'BLAST · CBX2 vs. PDB',
      summary: '3 structural homologs above 40% identity — CBX4 and CBX7 share the allosteric groove.',
      metrics: [
        { label: 'Top hit', value: 'CBX7 · 61% id' },
        { label: 'Homologs', value: '3 / 512' },
        { label: 'E-value', value: '2e-58' },
      ],
    }
  }
  return {
    title: 'Docking · CBX2 allosteric site',
    summary: 'Boltz-2 docked the fragment library into the allosteric pocket; 12 pass the ΔG threshold.',
    metrics: [
      { label: 'Top ΔG', value: '-8.9 kcal/mol' },
      { label: 'Hits (ΔG < -7)', value: '12 / 240' },
      { label: 'Runtime', value: '3m 41s · Modal A100' },
    ],
  }
}

/* --- Claude Science (mock): mirrors execute/claude_science.py's simulated run --- */

/** An inline SVG "screenshot" of the Claude Science window at one step (self-contained data URL). */
function scienceFrame(badge: string, caption: string, subtle: boolean): string {
  const accent = subtle ? '#6f7268' : '#3f7d5c'
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const b = esc(badge.slice(0, 22))
  const c = esc(caption.slice(0, 66))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" ` +
    `font-family="Inter, system-ui, sans-serif"><rect width="640" height="400" rx="14" fill="#f4f2ec"/>` +
    `<rect x="0" y="0" width="640" height="46" rx="14" fill="#e9e6dd"/>` +
    `<rect x="0" y="32" width="640" height="14" fill="#e9e6dd"/>` +
    `<circle cx="24" cy="23" r="6" fill="#dcae9a"/><circle cx="44" cy="23" r="6" fill="#e6d3a3"/>` +
    `<circle cx="64" cy="23" r="6" fill="#b6cbb2"/>` +
    `<text x="96" y="28" font-size="14" fill="#6f7268">Claude Science — localhost:8765</text>` +
    `<rect x="20" y="66" width="600" height="66" rx="12" fill="#ffffff" stroke="#e4e1d7"/>` +
    `<circle cx="52" cy="99" r="16" fill="${accent}"/>` +
    `<text x="52" y="104" font-size="15" fill="#ffffff" text-anchor="middle">CS</text>` +
    `<text x="82" y="94" font-size="15" fill="#1c1d18" font-weight="600">${b}</text>` +
    `<text x="82" y="116" font-size="13" fill="#6f7268">${c}</text>` +
    `<rect x="20" y="150" width="380" height="230" rx="12" fill="#ffffff" stroke="#e4e1d7"/>` +
    `<rect x="40" y="176" width="150" height="12" rx="6" fill="${accent}" opacity="0.85"/>` +
    `<rect x="40" y="202" width="330" height="9" rx="4" fill="#d8d5cb"/>` +
    `<rect x="40" y="222" width="300" height="9" rx="4" fill="#d8d5cb"/>` +
    `<rect x="40" y="242" width="322" height="9" rx="4" fill="#d8d5cb"/>` +
    `<rect x="40" y="272" width="120" height="34" rx="8" fill="${accent}"/>` +
    `<text x="100" y="294" font-size="13" fill="#ffffff" text-anchor="middle">Running…</text>` +
    `<rect x="416" y="150" width="204" height="230" rx="12" fill="#ffffff" stroke="#e4e1d7"/>` +
    `<text x="436" y="180" font-size="12" fill="#6f7268">AGENTS</text>` +
    `<circle cx="442" cy="208" r="5" fill="${accent}"/>` +
    `<text x="456" y="213" font-size="12" fill="#1c1d18">coordinator</text>` +
    `<circle cx="442" cy="236" r="5" fill="#9cc0a4"/>` +
    `<text x="456" y="241" font-size="12" fill="#1c1d18">sub-agent</text>` +
    `<circle cx="442" cy="264" r="5" fill="#dca059"/>` +
    `<text x="456" y="269" font-size="12" fill="#1c1d18">reviewer</text>` +
    `<rect x="436" y="300" width="164" height="56" rx="8" fill="#f4f2ec"/>` +
    `<text x="448" y="324" font-size="11" fill="#6f7268">60+ databases · Modal GPU</text>` +
    `<text x="448" y="342" font-size="11" fill="#6f7268">BioNeMo · reproducible</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

interface ScienceFlavor {
  db: string
  method: string
  artifact: string
  summary: string
  metrics: { label: string; value: string }[]
}

function scienceFlavor(q: string): ScienceFlavor {
  if (/fold|structure|alphafold|openfold|pldd/.test(q))
    return {
      db: 'UniProt + PDB',
      method: 'OpenFold3',
      artifact: 'the predicted 3D structure (interactive viewer)',
      summary: 'Predicted the fold; high confidence across the core and the target pocket.',
      metrics: [
        { label: 'Mean pLDDT', value: '88.4' },
        { label: 'Pocket pLDDT', value: '91.2' },
        { label: 'Runtime', value: '2m 10s · Modal A100' },
      ],
    }
  if (/dock|bind|compound|ligand|inhibitor|chembl/.test(q))
    return {
      db: 'ChEMBL + PDB',
      method: 'Boltz-2 docking',
      artifact: 'the top poses in the binding pocket',
      summary: 'Docked the fragment library; several candidates clear the ΔG threshold.',
      metrics: [
        { label: 'Best ΔG', value: '-8.9 kcal/mol' },
        { label: 'Hits (ΔG < -7)', value: '12 / 240' },
        { label: 'Runtime', value: '3m 41s · Modal A100' },
      ],
    }
  if (/variant|pathogen|mutation|clinvar|snp/.test(q))
    return {
      db: 'ClinVar + gnomAD',
      method: 'Evo 2 variant effect',
      artifact: 'the variant effect table',
      summary: 'Scored the variants; a subset is predicted likely-pathogenic.',
      metrics: [
        { label: 'Likely-pathogenic', value: '3' },
        { label: 'Variants scored', value: '184' },
        { label: 'Databases', value: 'ClinVar · gnomAD' },
      ],
    }
  if (/blast|homolog|sequence|align|evolution/.test(q))
    return {
      db: 'UniProt (MMseqs2)',
      method: 'Evo 2',
      artifact: 'the homolog alignment and conservation track',
      summary: 'Found structural homologs sharing the functional groove (>40% identity).',
      metrics: [
        { label: 'Top hit', value: 'CBX7 · 61% id' },
        { label: 'Homologs', value: '3 / 512' },
        { label: 'E-value', value: '2e-58' },
      ],
    }
  return {
    db: 'UniProt + Reactome',
    method: 'the analysis pipeline',
    artifact: 'the result figures and a reproducibility report',
    summary: 'Ran the analysis end-to-end and traced every figure back to its source code.',
    metrics: [
      { label: 'Sub-agents', value: '4' },
      { label: 'Databases', value: '3' },
      { label: 'Citations checked', value: '18' },
    ],
  }
}

function scienceSteps(f: ScienceFlavor): ScienceStep[] {
  const plan: [string, string, string, boolean][] = [
    ['navigate', 'Opened the Claude Science workbench (localhost:8765)', 'Workbench', false],
    ['type', "Typed the task into the coordinating agent's composer", 'Compose', false],
    ['submit', 'Sent the task to the generalist coordinating agent', 'Dispatch', false],
    ['plan', 'Coordinating agent decomposed the task and spawned sub-agents', 'Plan', true],
    ['connect', `Sub-agent queried ${f.db}`, f.db, false],
    ['compute', `Dispatched ${f.method} on Modal (GPU)`, f.method, false],
    ['review', 'Reviewer agent verified citations and figures against the code', 'Review', true],
    ['render', `Rendered ${f.artifact}`, 'Result', false],
  ]
  return plan.map(([action, detail, badge, subtle], i) => ({
    index: i + 1,
    action,
    detail,
    screenshot: scienceFrame(badge, detail, subtle),
  }))
}

/** Illustrative figures for the mock's Claude Science gallery — the same self-contained SVG charts
 *  the ML card uses, as data: URLs, so the "visual output" panel is demoable without a daemon. On a
 *  live run these are replaced by the run's real figures (execute/claude_science.py `_collect_figures`). */
function scienceFigures(q: string, rand: () => number): ScienceFigure[] {
  const url = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  if (/fold|structure|alphafold|openfold|pldd/.test(q))
    return [
      { title: 'Per-residue pLDDT', image: url(lossChart(rand)), caption: 'Confidence across the chain' },
      { title: 'Predicted contact map', image: url(scatterChart(1.2, rand, 'residue i', 'residue j')) },
    ]
  if (/dock|bind|compound|ligand|inhibitor|chembl/.test(q))
    return [
      { title: 'Binding-affinity distribution', image: url(lossChart(rand)), caption: 'Docked fragment library' },
      { title: 'Affinity vs. ligand size', image: url(scatterChart(-1.1, rand, 'heavy atoms', 'ΔG (kcal/mol)')) },
    ]
  if (/variant|pathogen|mutation|clinvar|snp/.test(q))
    return [
      { title: 'Variant-effect ROC', image: url(rocChart(0.86, rand)), caption: 'vs. ClinVar labels' },
      { title: 'Effect score by position', image: url(scatterChart(0.9, rand, 'residue', 'effect score')) },
    ]
  return [
    { title: 'Training loss', image: url(lossChart(rand)) },
    { title: 'ROC curve', image: url(rocChart(0.82, rand)) },
  ]
}

// A seeded PRNG so mock charts look real yet render identically across reloads (no Math.random).
function seededRng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h += 0x6d2b79f5
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const W = 340
const H = 210
const PL = 44
const PR = 14
const PT = 16
const PB = 34
const SAGE = '#5f8257'
const CLAY = '#b8654f'
const MUTED = '#8a857c'

function frame(xs: number[], ys: number[]) {
  const xlo = Math.min(...xs)
  const xhi = Math.max(...xs)
  const ylo = Math.min(...ys)
  const yhi = Math.max(...ys)
  const px = (x: number) => PL + ((x - xlo) / (xhi - xlo || 1)) * (W - PL - PR)
  const py = (y: number) => H - PB - ((y - ylo) / (yhi - ylo || 1)) * (H - PT - PB)
  return { px, py }
}

function axes(xLabel: string, yLabel: string): string {
  const midY = (H - PB + PT) / 2
  return (
    `<line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" stroke="rgba(0,0,0,0.18)"/>` +
    `<line x1="${PL}" y1="${H - PB}" x2="${PL}" y2="${PT}" stroke="rgba(0,0,0,0.18)"/>` +
    `<text x="${(PL + W - PR) / 2}" y="${H - 6}" font-size="10" fill="#2b2a27" text-anchor="middle">${xLabel}</text>` +
    `<text x="12" y="${midY}" font-size="10" fill="#2b2a27" text-anchor="middle" transform="rotate(-90 12 ${midY})">${yLabel}</text>`
  )
}

function svgWrap(inner: string): string {
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="max-width:100%;height:auto;display:block">${inner}</svg>`
}

function lossChart(rand: () => number): string {
  const series = Array.from({ length: 60 }, (_, i) => 0.69 * Math.exp(-i / 22) + 0.18 + rand() * 0.02)
  const { px, py } = frame([0, series.length - 1], series)
  const pts = series.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  return svgWrap(axes('epoch', 'BCE loss') + `<polyline points="${pts}" fill="none" stroke="${SAGE}" stroke-width="2"/>`)
}

function rocChart(auc: number, rand: () => number): string {
  const n = 22
  const pts: [number, number][] = [[0, 0]]
  for (let i = 1; i <= n; i++) {
    const fp = i / n
    const tp = Math.min(1, Math.pow(fp, Math.max(0.08, 1 - auc)) + rand() * 0.04)
    pts.push([fp, tp])
  }
  pts.push([1, 1])
  const { px, py } = frame([0, 1], [0, 1])
  const line = pts.map(([f, t]) => `${px(f).toFixed(1)},${py(t).toFixed(1)}`).join(' ')
  return svgWrap(
    axes('false positive rate', 'true positive rate') +
      `<line x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}" stroke="${MUTED}" stroke-dasharray="4 3"/>` +
      `<polygon points="${line} ${px(1)},${py(0)} ${px(0)},${py(0)}" fill="rgba(95,130,87,0.14)"/>` +
      `<polyline points="${line}" fill="none" stroke="${SAGE}" stroke-width="2"/>` +
      `<text x="${W - PR - 4}" y="${PT + 12}" font-size="11" fill="#2b2a27" text-anchor="end">AUC ${auc.toFixed(2)}</text>`,
  )
}

function scatterChart(strength: number, rand: () => number, xLabel: string, yLabel: string): string {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < 90; i++) {
    const x = rand() * 4 - 2
    xs.push(x)
    ys.push(strength * x + (rand() * 2 - 1) * 1.4)
  }
  const { px, py } = frame(xs, ys)
  const dots = xs
    .map((x, i) => `<circle cx="${px(x).toFixed(1)}" cy="${py(ys[i]).toFixed(1)}" r="2.6" fill="${SAGE}" fill-opacity="0.72"/>`)
    .join('')
  const xlo = Math.min(...xs)
  const xhi = Math.max(...xs)
  const fit = `<line x1="${px(xlo)}" y1="${py(strength * xlo)}" x2="${px(xhi)}" y2="${py(strength * xhi)}" stroke="${CLAY}" stroke-width="2"/>`
  return svgWrap(axes(xLabel, yLabel) + fit + dots)
}

export function mlResultFor(query: string): MLResult {
  const q = query.toLowerCase()
  const rand = seededRng(query)
  const nullish = /\bnull\b|control|random|no signal|refut/.test(q)
  const correlation = /correlat|associat/.test(q)
  const regression = !correlation && /regress|viabilit|dose|expression|predict.*(value|score|level)/.test(q)

  if (nullish) {
    return {
      title: 'Classification · Randomized control',
      hypothesis: query,
      recipe: 'classification',
      verdict: 'refuted',
      rationale:
        'Held-out AUC 0.50 on 50 samples (below the 0.70 support threshold); accuracy 48% vs a 56% majority-class baseline — no better than chance.',
      datasetName: 'Randomized control',
      datasetSource: '#protein-eng',
      datasetAuthor: 'lucas',
      nRows: 200,
      nFeatures: 3,
      modelKind: '2-layer neural net (pure-Python backprop)',
      metrics: [
        { label: 'test AUC', value: '0.50' },
        { label: 'accuracy', value: '48%' },
        { label: 'baseline', value: '56%' },
        { label: 'train / test', value: '150 / 50' },
      ],
      charts: [
        { kind: 'loss', title: 'Training loss', svg: lossChart(rand) },
        { kind: 'roc', title: 'ROC curve', svg: rocChart(0.5, rand) },
      ],
    }
  }
  if (correlation) {
    return {
      title: 'Correlation · Expression → viability screen',
      hypothesis: query,
      recipe: 'correlation',
      verdict: 'supported',
      rationale:
        'Pearson r=+0.75 between BRD4 and viability (permutation p=0.002); significant with a meaningful effect size.',
      datasetName: 'Expression → viability screen',
      datasetSource: 'Granola · Tuesday sync',
      datasetAuthor: 'philip',
      nRows: 220,
      nFeatures: 4,
      modelKind: 'Pearson correlation + permutation test',
      metrics: [
        { label: 'Pearson r', value: '+0.75' },
        { label: 'p-value', value: '0.002' },
        { label: 'feature', value: 'BRD4' },
        { label: 'n', value: '220' },
      ],
      charts: [{ kind: 'scatter', title: 'BRD4 vs. viability', svg: scatterChart(1.5, rand, 'BRD4', 'viability') }],
    }
  }
  if (regression) {
    return {
      title: 'Regression · Expression → viability screen',
      hypothesis: query,
      recipe: 'regression',
      verdict: 'supported',
      rationale:
        'The model explains R²=0.80 of held-out variance in viability (≥ the 0.50 support threshold), RMSE 8.68 over 55 samples.',
      datasetName: 'Expression → viability screen',
      datasetSource: 'Granola · Tuesday sync',
      datasetAuthor: 'philip',
      nRows: 220,
      nFeatures: 4,
      modelKind: 'linear regression (gradient descent)',
      metrics: [
        { label: 'test R²', value: '0.80' },
        { label: 'RMSE', value: '8.68' },
        { label: 'features', value: '4' },
        { label: 'train / test', value: '165 / 55' },
      ],
      charts: [
        { kind: 'fit', title: 'Predicted vs. actual', svg: scatterChart(1.0, rand, 'actual viability', 'predicted') },
      ],
    }
  }
  return {
    title: 'Classification · CBX2 binding assay',
    hypothesis: query,
    recipe: 'classification',
    verdict: 'supported',
    rationale:
      'Held-out AUC 0.80 on 65 samples (≥ the 0.70 support threshold); accuracy 77% vs a 60% majority-class baseline.',
    datasetName: 'CBX2 binding assay',
    datasetSource: '#protein-eng',
    datasetAuthor: 'lucas',
    nRows: 260,
    nFeatures: 5,
    modelKind: '2-layer neural net (pure-Python backprop)',
    metrics: [
      { label: 'test AUC', value: '0.80' },
      { label: 'accuracy', value: '77%' },
      { label: 'baseline', value: '60%' },
      { label: 'train / test', value: '195 / 65' },
    ],
    charts: [
      { kind: 'loss', title: 'Training loss', svg: lossChart(rand) },
      { kind: 'roc', title: 'ROC curve', svg: rocChart(0.8, rand) },
    ],
  }
}


/** Whether a follow-up is a *tweak* of the current scene rather than a brand-new request. */
function looksLikeSceneEdit(q: string): boolean {
  return /\b(make it|change|instead|now (make|spin|run|use|set)|use (a|an|the)|spin|centrifuge|longer|shorter|faster|slower|gentl|bigger|smaller|more wells|fewer wells|increase|decrease|set (it|the)|adjust|\d{1,3}[\s-]*well|\d+\s*(seconds?|secs?|minutes?|mins?|rpm|rcf)|volume|µl|microlit)\b/i.test(
    q,
  )
}

/** Whether a follow-up actually asks for a whole *new* protocol (so it shouldn't edit the last one). */
function looksLikeNewProtocol(q: string): boolean {
  return /\b(fill a|dispense into|run a|set up a|serial dilut|\bpcr\b|master ?mix|bead ?cleanup|clean ?up|resuspend|normali[sz]|elisa|absorbance|new protocol|from scratch)\b/i.test(
    q,
  )
}

/** One-line summary of what a follow-up edit changed vs. the previous scene (sells the continuity). */
function changeSummary(prev: Protocol, next: Protocol): string {
  const a = instrumentSceneParams(prev)
  const b = instrumentSceneParams(next)
  if (!b) return 'Updated the scene.'
  const parts: string[] = []
  if (!a || a.plateKind !== b.plateKind) parts.push(`a ${b.plateDisplay}`)
  if (!a || a.seconds !== b.seconds) parts.push(`${b.seconds ?? 0} s spin`)
  if ((a?.rpm ?? undefined) !== b.rpm && b.rpm) parts.push(`${b.rpm.toLocaleString()} rpm`)
  if (a && a.instrument !== b.instrument && b.instrument) parts.push(`the ${b.instrument.toLowerCase()}`)
  const changed = parts.length ? parts.join(', ') : 'the run'
  return `Updated the run — now ${changed}. I kept everything else the same: same prep, same sample, still filling every well before the hand-off.`
}

/** A grounded, cited conclusion that wraps a bench run — so the 3D scene reads as the OUTPUT of a
 *  reasoning step (search memory -> ground in the assay notes -> build to match -> simulate), the
 *  same shape as the ML/Claude-Science answers, not a bare demo. */
function protocolConclusion(proto: Protocol, mem: Reply, general: boolean): string {
  const c = mem.citations[0]
  const why = c
    ? `Grounded in ${c.author}'s ${c.sourceLabel} — "${c.quote}" — I built the run to match: ${proto.deck.labware.length} labware, ${proto.steps.length} steps. `
    : `${proto.fallbackNote ? proto.fallbackNote + ' ' : ''}I composed the run — ${proto.deck.labware.length} labware, ${proto.steps.length} steps. `
  const sim = general
    ? 'PyLabRobot dry-ran the movement script clean. '
    : 'opentrons.simulate ran it clean — no deck collisions. '
  const tail = 'Scrub the run above, or open the full bench for the code. Nothing physical runs without your approval.'
  return why + sim + tail
}

/** The agent run as an async event stream. */
export async function* runAgent(query: string, ctx?: AgentContext): AsyncGenerator<AgentEvent> {
  let n = 0
  const id = () => `t${++n}`
  const q = query.trim()

  const wantsIngest = /\b(ingest|sync|pull in|refresh|latest from)\b/i.test(q)
  const wantsML =
    /\b(hypothesis|dataset|classif|regress|correlat|train (a )?model|ml analysis|was .*(true|right)|does .* predict|predict .* activity|test .* on .* data)\b/i.test(
      q,
    )
  const wantsAnalysis =
    !wantsML && /\b(dock|docking|fold|predict|blast|analy|score|simulat.*bind|virtual screen)\b/i.test(q)
  // Claude Science is the alternative to local analysis — richer/multi-tool science, or an explicit ask.
  const wantsScience =
    /\bclaude science\b|\bworkbench\b/i.test(q) ||
    (wantsAnalysis && /\b(genom|proteom|structur|cheminform|rna|variant|express|pipeline|fold)\b/i.test(q))
  const wantsProtocol = isProtocolRequest(q) && !wantsAnalysis && !wantsML && !wantsScience

  // --- memory: continue on the last scene ---
  // If the previous turn produced an instrument scene and this turn is a tweak ("spin it for 30 s",
  // "make it 48-well"), edit that scene instead of regenerating from scratch. This is the visible
  // "it remembers what we were doing" behaviour.
  if (ctx?.lastProtocol && !wantsML && !wantsAnalysis && !wantsScience && !wantsIngest && looksLikeSceneEdit(q) && !looksLikeNewProtocol(q)) {
    const edited = editInstrumentScene(ctx.lastProtocol, q)
    if (edited) {
      yield { type: 'thought', text: 'Picking up the scene we were building — tweaking it, keeping the rest.' }
      const g = id()
      yield { type: 'toolStart', id: g, tool: 'generate_protocol', label: 'Updating the lab-robot scene' }
      await sleep(850)
      yield { type: 'toolEnd', id: g, ok: true, summary: `${edited.name} · ${edited.steps.length} steps · updated` }
      const sm = id()
      yield { type: 'toolStart', id: sm, tool: 'simulate', label: 'Re-simulating (PyLabRobot · dry-run)' }
      await sleep(700)
      yield { type: 'toolEnd', id: sm, ok: true, summary: `${edited.steps.length} commands · no collisions · run ready` }
      yield { type: 'protocol', protocol: edited }
      yield { type: 'answer', text: changeSummary(ctx.lastProtocol, edited), citations: [] }
      yield { type: 'done' }
      return
    }
  }

  // --- optional ingest step ---
  if (wantsIngest) {
    yield { type: 'thought', text: 'Let me sync the latest from the connected sources first.' }
    const t = id()
    yield { type: 'toolStart', id: t, tool: 'ingest', label: 'Ingesting #protein-eng · Gmail (last 7 days)' }
    await sleep(1100)
    yield { type: 'toolEnd', id: t, ok: true, summary: '42 new episodes · 3 unresolved authors surfaced' }
  }

  // --- always ground in memory ---
  yield { type: 'thought', text: wantsProtocol ? 'A bench task — let me check the assay notes before I build it.' : "Let me pull what the lab already knows about this." }
  const m = id()
  yield { type: 'toolStart', id: m, tool: 'search_memory', label: 'Searching lab memory' }
  await sleep(900)
  const memReply = answerFor(q)
  const grounded = memReply.citations.length > 0
  yield {
    type: 'toolEnd',
    id: m,
    ok: true,
    summary: grounded ? `${memReply.citations.length} attributed facts (Assay Buffer v3, CBX2 thread)` : 'no strong matches',
  }

  // --- ML analysis: find the dataset in memory, train a model, judge the hypothesis ---
  if (wantsML) {
    yield { type: 'thought', text: 'A hypothesis to test — let me find the dataset in memory and train a model on it.' }
    const a = id()
    yield { type: 'toolStart', id: a, tool: 'run_ml_analysis', label: 'Running an ML analysis in a sandbox' }
    await sleep(1600)
    const result = mlResultFor(q)
    yield { type: 'toolEnd', id: a, ok: true, summary: `${result.verdict} · ${result.title}` }
    yield { type: 'mlResult', result }
    const verb =
      result.verdict === 'supported'
        ? 'supports'
        : result.verdict === 'refuted'
          ? 'does not support'
          : 'is inconclusive on'
    yield {
      type: 'answer',
      text: `The data ${verb} the hypothesis. ${result.rationale} Trained on the ${result.datasetName} (${result.nRows} rows) that ${result.datasetAuthor} referenced in ${result.datasetSource}.`,
      citations: memReply.citations.slice(0, 1),
    }
    yield { type: 'done' }
    return
  }


  // --- Claude Science workbench (Claymore operates the app via computer use) ---
  if (wantsScience) {
    yield { type: 'thought', text: 'This is a job for the Claude Science workbench — let me drive it.' }
    const cs = id()
    yield { type: 'toolStart', id: cs, tool: 'run_claude_science', label: 'Using Claude Science' }
    const flavor = scienceFlavor(q)
    const steps = scienceSteps(flavor)
    const figures = scienceFigures(q, seededRng(q))
    const csv = 'x,y\n0,1.0\n1,0.8\n2,0.6\n3,0.5\n'
    const files: ScienceFile[] = [
      {
        name: 'dataset_SIMULATED.csv',
        contentType: 'text/csv',
        sizeBytes: csv.length,
        download: `data:text/csv;base64,${btoa(csv)}`,
      },
    ]
    for (const step of steps) {
      await sleep(650)
      yield { type: 'scienceStep', id: cs, step }
    }
    const session: ScienceSession = {
      task: q,
      status: 'simulated',
      url: 'http://localhost:8765',
      model: null,
      steps,
      resultTitle: `Claude Science · ${q.slice(0, 48) || 'analysis'}`,
      resultSummary: flavor.summary,
      metrics: flavor.metrics,
      figures,
      files,
      note: 'Simulated preview — start the Claude Science app on localhost:8765 and Claymore drives it for real.',
    }
    yield { type: 'toolEnd', id: cs, ok: true, summary: session.resultTitle }
    yield { type: 'scienceSession', id: cs, session }
    yield {
      type: 'answer',
      text: `${flavor.summary} (Simulated preview of Claude Science — open the panel to watch the run; start the app on localhost:8765 for a real drive.)`,
      citations: memReply.citations.slice(0, 1),
    }
    yield { type: 'done' }
    return
  }

  // --- bio analysis ---
  if (wantsAnalysis) {
    yield { type: 'thought', text: 'This needs compute — dispatching to a sandbox on Modal.' }
    const a = id()
    yield { type: 'toolStart', id: a, tool: 'run_analysis', label: 'Running analysis in a Modal sandbox' }
    await sleep(1500)
    const result = analysisFor(q)
    yield { type: 'toolEnd', id: a, ok: true, summary: result.summary }
    yield { type: 'analysis', analysis: result }
    yield {
      type: 'answer',
      text: `${result.summary} Result ingested back into memory as an Experiment node.`,
      citations: memReply.citations.slice(0, 1),
    }
    yield { type: 'done' }
    return
  }

  // --- robot scene ---
  if (wantsProtocol) {
    const g = id()
    const proto = generateScene(q).protocol
    const general = proto.mode === 'general'
    // Reason from what the lab already decided before building — the bench is the conclusion of a
    // grounded step, not a standalone demo.
    if (grounded) {
      const c = memReply.citations[0]
      yield {
        type: 'thought',
        text: `${c.author}'s ${c.sourceLabel} is the ground truth here — building the run to match it.`,
      }
    }
    yield {
      type: 'toolStart',
      id: g,
      tool: 'generate_protocol',
      label: general ? 'Composing a lab-robot run' : 'Composing an Opentrons scene',
    }
    await sleep(1000)
    const labwareCount = proto.deck.labware.length
    const modNames = proto.deck.modules.map((m) => m.display).join(', ')
    yield {
      type: 'toolEnd',
      id: g,
      ok: true,
      summary: general
        ? `${proto.name} · off-deck handoff · ${proto.steps.length} steps`
        : `${proto.name} · ${labwareCount} labware${modNames ? ` · ${modNames}` : ''} · ${proto.steps.length} steps`,
    }

    const s = id()
    yield {
      type: 'toolStart',
      id: s,
      tool: 'simulate',
      label: general ? 'Simulating (PyLabRobot · dry-run)' : 'Simulating (opentrons.simulate · dry-run)',
    }
    await sleep(950)
    yield {
      type: 'toolEnd',
      id: s,
      ok: true,
      summary: `${proto.steps.length} commands · no deck collisions · run ready`,
    }
    yield { type: 'protocol', protocol: proto }
    // Always close with a reasoned, attributed conclusion (opentrons runs used to end on a bare card).
    yield {
      type: 'answer',
      text: protocolConclusion(proto, memReply, general),
      citations: memReply.citations.slice(0, 2),
    }
    yield { type: 'done' }
    return
  }

  // --- plain grounded answer ---
  yield { type: 'answer', text: memReply.text, citations: memReply.citations }
  yield { type: 'done' }
}

/* -------------------------------------------------- live: /api/agent SSE -- */

async function* runAgentLive(query: string, ctx?: AgentContext): AsyncGenerator<AgentEvent> {
  let res: Response
  try {
    res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Send the prior turns so the real agent has the conversation (backend seeds them into the
      // Claude message list). `history` is the wire contract in api/routes/agent.py.
      body: JSON.stringify({ query, history: ctx?.history ?? [] }),
      signal: ctx?.signal,
    })
  } catch {
    yield { type: 'error', message: 'could not reach the agent endpoint' }
    return
  }
  if (!res.ok || !res.body) {
    yield { type: 'error', message: `agent unavailable (${res.status})` }
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      const json = dataLine.slice(5).trim()
      if (!json) continue
      try {
        yield JSON.parse(json) as AgentEvent
      } catch {
        // ignore a malformed frame
      }
    }
  }
}

/** Mock or live agent event stream, chosen by VITE_CLAYMORE_LIVE. Same event
 *  contract either way, so the Composer doesn't care which is running. */
export async function* agentStream(query: string, ctx?: AgentContext): AsyncGenerator<AgentEvent> {
  if (isLive) {
    yield* runAgentLive(query, ctx)
  } else {
    yield* runAgent(query, ctx)
  }
}

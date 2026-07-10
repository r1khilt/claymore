/**
 * Mock agent engine — a stand-in for the backend Claude tool-loop so the
 * Composer is fully alive without API keys. `runAgent` yields the same event
 * stream the real /api/agent SSE endpoint emits (see api/routes/agent.py), so
 * swapping to live is just changing the source of these events.
 *
 * It routes a request to a flow (memory answer / ingest / bio-analysis / an
 * Opentrons scene), emitting thoughts + tool calls along the way. Robot scenes
 * are built by generateScene(), which refuses anything Opentrons can't do.
 */
import type { Citation } from './types'
import type { Protocol } from './protocol'
import { generateScene, isProtocolRequest } from './protocol'
import { answerFor } from './mockData'
import { isLive } from './api'

export type ToolName =
  | 'search_memory'
  | 'ingest'
  | 'generate_protocol'
  | 'simulate'
  | 'run_analysis'
  | 'run_ml_analysis'

export interface AnalysisResult {
  title: string
  summary: string
  metrics: { label: string; value: string }[]
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
  | { type: 'mlResult'; result: MLResult }
  | { type: 'done' }
  | { type: 'error'; message: string }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function analysisFor(query: string): AnalysisResult {
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

/* ---- mock ML analysis (keyless demo mirror of execute/ml_analysis.py) ---- */

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

/** The agent run as an async event stream. */
export async function* runAgent(query: string): AsyncGenerator<AgentEvent> {
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
  const wantsProtocol = isProtocolRequest(q) && !wantsAnalysis && !wantsML

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
    yield { type: 'toolStart', id: g, tool: 'generate_protocol', label: 'Generating an Opentrons protocol' }
    await sleep(1000)
    const scene = generateScene(q)
    if ('unsupported' in scene) {
      yield { type: 'toolEnd', id: g, ok: false, summary: `unsupported: ${scene.unsupported}` }
      yield {
        type: 'answer',
        text: `I can't run that on the deck — ${scene.unsupported}. I can prep samples for that step, or design a protocol around the supported hardware (pipettes, plates, tube racks, thermocycler, heater-shaker, magnetic module). Want me to?`,
        citations: [],
      }
      yield { type: 'done' }
      return
    }
    const proto = scene.protocol
    yield { type: 'toolEnd', id: g, ok: true, summary: `${proto.name} · ${proto.steps.length} steps · validated against supported hardware` }

    const s = id()
    yield { type: 'toolStart', id: s, tool: 'simulate', label: 'Simulating (opentrons.simulate · dry-run)' }
    await sleep(1000)
    yield { type: 'toolEnd', id: s, ok: true, summary: `${proto.steps.length} commands · no deck collisions · est. run ready` }
    yield { type: 'protocol', protocol: proto }
    yield { type: 'done' }
    return
  }

  // --- plain grounded answer ---
  yield { type: 'answer', text: memReply.text, citations: memReply.citations }
  yield { type: 'done' }
}

/* -------------------------------------------------- live: /api/agent SSE -- */

async function* runAgentLive(query: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  let res: Response
  try {
    res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
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
export async function* agentStream(query: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  if (isLive) {
    yield* runAgentLive(query, signal)
  } else {
    yield* runAgent(query)
  }
}

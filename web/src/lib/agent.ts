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
  | 'run_claude_science'

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
  /** self-contained data: URL — a PNG frame (live) or an SVG frame (preview). */
  screenshot?: string | null
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
  note?: string | null
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

/** The agent run as an async event stream. */
export async function* runAgent(query: string): AsyncGenerator<AgentEvent> {
  let n = 0
  const id = () => `t${++n}`
  const q = query.trim()

  const wantsIngest = /\b(ingest|sync|pull in|refresh|latest from)\b/i.test(q)
  const wantsAnalysis = /\b(dock|docking|fold|predict|blast|analy|score|simulat.*bind|virtual screen)\b/i.test(q)
  // Claude Science is the alternative to local analysis — richer/multi-tool science, or an explicit ask.
  const wantsScience =
    /\bclaude science\b|\bworkbench\b/i.test(q) ||
    (wantsAnalysis && /\b(genom|proteom|structur|cheminform|rna|variant|express|pipeline|fold)\b/i.test(q))
  const wantsProtocol = isProtocolRequest(q) && !wantsAnalysis && !wantsScience

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

  // --- Claude Science workbench (Claymore operates the app via computer use) ---
  if (wantsScience) {
    yield { type: 'thought', text: 'This is a job for the Claude Science workbench — let me drive it.' }
    const cs = id()
    yield { type: 'toolStart', id: cs, tool: 'run_claude_science', label: 'Using Claude Science' }
    const flavor = scienceFlavor(q)
    const steps = scienceSteps(flavor)
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
    if (general) {
      yield {
        type: 'answer',
        text: `${proto.fallbackNote ?? ''} I've built the deck, the step sequence, and a PyLabRobot movement script — open it in the Bench to scrub through or view the code.`,
        citations: [],
      }
    }
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

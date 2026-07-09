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

export type ToolName = 'search_memory' | 'ingest' | 'generate_protocol' | 'simulate' | 'run_analysis'

export interface AnalysisResult {
  title: string
  summary: string
  metrics: { label: string; value: string }[]
}

export type AgentEvent =
  | { type: 'thought'; text: string }
  | { type: 'toolStart'; id: string; tool: ToolName; label: string }
  | { type: 'toolEnd'; id: string; ok: boolean; summary: string }
  | { type: 'answer'; text: string; citations: Citation[] }
  | { type: 'protocol'; protocol: Protocol }
  | { type: 'analysis'; analysis: AnalysisResult }
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

/** The agent run as an async event stream. */
export async function* runAgent(query: string): AsyncGenerator<AgentEvent> {
  let n = 0
  const id = () => `t${++n}`
  const q = query.trim()

  const wantsIngest = /\b(ingest|sync|pull in|refresh|latest from)\b/i.test(q)
  const wantsAnalysis = /\b(dock|docking|fold|predict|blast|analy|score|simulat.*bind|virtual screen)\b/i.test(q)
  const wantsProtocol = isProtocolRequest(q) && !wantsAnalysis

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

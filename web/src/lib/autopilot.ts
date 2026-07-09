/**
 * Autopilot — the "Run" mode engine. Where the Composer (Chat) is driven by the
 * user, autopilot drives itself: it ingests every connected source, synthesizes
 * what the lab is actually working on, then runs the experiments that follow —
 * executing the safe (computational) ones itself and drafting the wet-lab one for
 * approval, per the lab's safety gate.
 *
 * Like `runAgent`, this is a scripted, grounded stand-in so "Run" is fully alive
 * without a backend. Experiment traces reuse the same `AgentEvent` shape the
 * Composer emits, so `AgentTurn` renders them unchanged. Everything is cited from
 * the shared corpus (mockData) — no fabricated attribution.
 */
import type { AgentEvent } from './agent'
import { analysisFor } from './agent'
import type { Citation, PendingAction, SourcePlatform } from './types'
import { connectors, CIT } from './mockData'

export interface IngestRow {
  platform: SourcePlatform
  label: string
  episodes: number
}

export interface Candidate {
  id: string
  title: string
  rationale: string
  citations: Citation[]
  /** 'run' = executed automatically (computational); 'gated' = drafted for approval (wet-lab). */
  disposition: 'run' | 'gated'
}

export type AutopilotEvent =
  | { type: 'ingest:start' }
  | { type: 'ingest:source'; row: IngestRow }
  | { type: 'ingest:done'; episodes: number; sources: number }
  | { type: 'think'; text: string }
  | { type: 'candidates'; items: Candidate[] }
  | { type: 'exp:start'; id: string; title: string; subtitle: string }
  | { type: 'exp:event'; id: string; event: AgentEvent }
  | { type: 'exp:done'; id: string }
  | { type: 'summary'; text: string; citations: Citation[]; pendingAction?: PendingAction | null }
  | { type: 'done' }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

/** The experiments Claymore proposes after reading the lab — grounded + cited. */
function plan(): Candidate[] {
  return [
    {
      id: 'dock',
      title: 'Dock the CBX2 fragment library into the allosteric pocket',
      rationale:
        'Lucas proposed probing the allosteric pocket last week; the Tuesday sync made it the priority; Philip prepped the grid box but no run is logged.',
      citations: [CIT.lucasSlack2, CIT.granola, CIT.philipCommit],
      disposition: 'run',
    },
    {
      id: 'fold',
      title: 'Predict the CBX2 chromodomain structure (OpenFold3)',
      rationale:
        'No structure is on file for the allosteric pocket — needed to interpret the docking poses.',
      citations: [CIT.lucasSlack],
      disposition: 'run',
    },
    {
      id: 'yctrl',
      title: 'Run the Y-hypothesis control on CBX2',
      rationale:
        'Rikhin asked yesterday whether it was ever run — it wasn’t. This needs wet-lab work, so it goes to approval rather than running automatically.',
      citations: [CIT.rikhinImsg, CIT.lucasSlack2],
      disposition: 'gated',
    },
  ]
}

const FILE_ISSUE: PendingAction = {
  token: 'A2',
  kind: 'file_issue',
  description: 'File an issue on claymore/docking-pipeline',
  target: 'claymore/docking-pipeline',
  preview:
    'Run Y-hypothesis control on CBX2 allosteric site\n\nNever executed (confirmed via memory). Use the prepped grid box from 3f2c1ab and the <2% DMSO buffer (Assay Buffer v3). Requested by Rikhin, originally proposed by Lucas.',
}

/** Emit one experiment's trace as ordinary AgentEvents so AgentTurn renders it. */
async function* experiment(
  id: string,
  toolLabel: string,
  thought: string,
  analysisQuery: string,
  answer: string,
  citations: Citation[],
  signal?: AbortSignal,
): AsyncGenerator<AutopilotEvent> {
  const ev = (event: AgentEvent): AutopilotEvent => ({ type: 'exp:event', id, event })
  yield ev({ type: 'thought', text: thought })
  await sleep(650, signal)
  const tid = `${id}-run`
  yield ev({ type: 'toolStart', id: tid, tool: 'run_analysis', label: toolLabel })
  await sleep(1500, signal)
  const result = analysisFor(analysisQuery)
  yield ev({ type: 'toolEnd', id: tid, ok: true, summary: result.summary })
  yield ev({ type: 'analysis', analysis: result })
  await sleep(350, signal)
  yield ev({ type: 'answer', text: answer, citations })
}

/** The full autopilot run as an event stream. */
export async function* runAutopilot(signal?: AbortSignal): AsyncGenerator<AutopilotEvent> {
  // --- ingest every connected source ---
  yield { type: 'ingest:start' }
  const connected = connectors.filter((c) => c.connected)
  let total = 0
  for (const c of connected) {
    await sleep(430, signal)
    total += c.episodes ?? 0
    yield {
      type: 'ingest:source',
      row: { platform: c.platform, label: c.account ?? c.name, episodes: c.episodes ?? 0 },
    }
  }
  await sleep(300, signal)
  yield { type: 'ingest:done', episodes: total, sources: connected.length }

  // --- synthesize what the lab is working on ---
  await sleep(500, signal)
  yield {
    type: 'think',
    text: `Read ${total.toLocaleString()} episodes across ${connected.length} sources. Resolving people and threads…`,
  }
  await sleep(900, signal)
  yield {
    type: 'think',
    text: 'The lab’s active focus is CBX2 — an allosteric-pocket hypothesis, a docking pipeline, and one question that never got tested.',
  }
  await sleep(850, signal)
  yield { type: 'candidates', items: plan() }
  await sleep(750, signal)

  // --- run the safe (computational) experiments ---
  yield {
    type: 'exp:start',
    id: 'dock',
    title: 'Docking · CBX2 allosteric site',
    subtitle: 'From Lucas’s suggestion + the Tuesday-sync priority',
  }
  yield* experiment(
    'dock',
    'Docking the CBX2 fragment library (Boltz-2 · Modal A100)',
    'This is computational and sandbox-safe — dispatching to a Modal GPU sandbox.',
    'dock the fragment library into the allosteric pocket',
    'Docked the fragment library into the CBX2 allosteric pocket; 12 fragments pass the ΔG threshold. Ingested back into memory as an Experiment node, linked to Lucas’s suggestion and the Tuesday decision.',
    [CIT.lucasSlack2, CIT.granola],
    signal,
  )
  yield { type: 'exp:done', id: 'dock' }
  await sleep(450, signal)

  yield {
    type: 'exp:start',
    id: 'fold',
    title: 'Structure · CBX2 chromodomain',
    subtitle: 'So the docking poses are interpretable',
  }
  yield* experiment(
    'fold',
    'OpenFold3 · CBX2 chromodomain (Modal A100)',
    'No structure on file — predicting it so the poses are interpretable.',
    'fold the structure with openfold plddt',
    'Predicted the CBX2 chromodomain with high confidence across the allosteric pocket. Linked to the docking run in memory.',
    [CIT.lucasSlack],
    signal,
  )
  yield { type: 'exp:done', id: 'fold' }
  await sleep(500, signal)

  // --- wrap up: gate the wet-lab experiment for approval ---
  yield {
    type: 'summary',
    text: 'Ran two experiments straight off what the lab already said — a docking pass on the CBX2 allosteric site and an OpenFold3 structure prediction — and ingested both back into memory as Experiment nodes, each linked to the messages that motivated them. The third, the Y-hypothesis control, needs wet-lab work, so per the lab’s safety gate I’ve drafted it for your approval instead of running it.',
    citations: [CIT.lucasSlack2, CIT.granola, CIT.rikhinImsg],
    pendingAction: FILE_ISSUE,
  }
  yield { type: 'done' }
}

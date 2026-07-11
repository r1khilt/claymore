/**
 * ProjectDetail — the whole Projects flow for one project.
 *
 * Owns the phase machine + graph state and consumes `buildGraph` exactly like
 * RunView.consume (AbortController, for-await over the async generator). Composes:
 * the 3D graph (center), the source dropzone → build stream → gap panel (right),
 * and the run → resolve → Slack close. Selecting a gap highlights its subgraph in
 * 3D; running it streams a trace, flips its edge, and drafts the Slack message.
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, RotateCcw, Sparkles, Loader2, FileText, GitFork, Play, Check, Maximize2 } from 'lucide-react'
import type { AgentEvent } from '@/lib/agent'
import type { Person } from '@/lib/types'
import type { Gap, GraphEdge, GraphNode, PaperSource, Project } from '@/lib/projectTypes'
import { buildGraph, runGap, resolveEdges, type GapRunResult } from '@/lib/projectStore'
import { DEMO_GAP_COUNT } from '@/lib/projectMock'
import { AgentTurn } from '@/components/ask/AgentTurn'
import { Avatar } from '@/components/ui/Avatar'
import { SourceDropzone } from './SourceDropzone'
import { BuildStream, type BuildProgress } from './BuildStream'
import { GapPanel } from './GapPanel'
import { RunResultCard } from './RunResultCard'
import { SlackDraftBubble } from './SlackDraftBubble'

// Lazy-load the r3f graph so three.js only ships when a graph is actually rendered
// (same rule as Deck3D — keeps the initial bundle light).
const KnowledgeGraph3D = lazy(() => import('./KnowledgeGraph3D').then((m) => ({ default: m.KnowledgeGraph3D })))

type Phase = 'setup' | 'building' | 'built'

const emptyProgress = (): BuildProgress => ({
  phase: 'checking',
  sufficiency: null,
  augment: [],
  augmentDone: false,
  extract: [],
  nodeCount: 0,
  edgeCount: 0,
  settled: false,
  narration: [],
})

/** Which nodes/edges to highlight for a selected gap (its subgraph + the edges
 *  that already connect its nodes, so the bridging path lights up too). */
function subgraphSets(gap: Gap | null, edges: GraphEdge[]): { nodes: Set<string> | null; edges: Set<string> | null } {
  if (!gap) return { nodes: null, edges: null }
  const nodes = new Set(gap.subgraph.nodes)
  const eset = new Set(gap.subgraph.edges)
  for (const e of edges) if (nodes.has(e.source) && nodes.has(e.target)) eset.add(e.id)
  return { nodes, edges: eset }
}

export function ProjectDetail({ project, onBack }: { project: Project; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>('setup')
  const [sources, setSources] = useState<PaperSource[]>(project.sources)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [gaps, setGaps] = useState<Gap[]>([])
  const [progress, setProgress] = useState<BuildProgress>(emptyProgress())

  const [selectedGap, setSelectedGap] = useState<Gap | null>(null)
  const [runningGapId, setRunningGapId] = useState<string | null>(null)
  const [runEvents, setRunEvents] = useState<AgentEvent[]>([])
  const [runResult, setRunResult] = useState<GapRunResult | null>(null)
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set())
  const [buildToken, setBuildToken] = useState(0)
  // Bumped by the "Recenter" control to re-engage the graph's auto-fit after the
  // user has dragged the camera away.
  const [recenterNonce, setRecenterNonce] = useState(0)

  const buildAc = useRef<AbortController | null>(null)
  const runAc = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const started = useRef(false)

  // Consume the build stream when a build is kicked off (buildToken bumps).
  useEffect(() => {
    if (buildToken === 0) return
    const ac = new AbortController()
    buildAc.current = ac
    void consumeBuild(ac.signal)
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildToken])

  useEffect(() => () => { buildAc.current?.abort(); runAc.current?.abort() }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [runEvents, runResult, gaps.length])

  function startBuild() {
    if (started.current && phase === 'building') return
    started.current = true
    runAc.current?.abort() // don't let an in-flight gap run leak into the new build
    setPhase('building')
    setNodes([])
    setEdges([])
    setGaps([])
    setSelectedGap(null)
    setRunEvents([])
    setRunResult(null)
    setRunningGapId(null)
    setResolvedIds(new Set())
    setProgress(emptyProgress())
    setBuildToken((t) => t + 1)
  }

  async function consumeBuild(signal: AbortSignal) {
    try {
      for await (const ev of buildGraph({ ...project, sources }, signal)) {
        if (signal.aborted) return
        switch (ev.type) {
          case 'sufficiency':
            setProgress((p) => ({ ...p, sufficiency: { have: ev.have, need: ev.need, floor: ev.floor, ok: ev.ok }, phase: ev.ok ? 'extracting' : 'augmenting' }))
            break
          case 'augment:start':
            setProgress((p) => ({ ...p, phase: 'augmenting' }))
            break
          case 'augment:source':
            setSources((s) => (s.some((x) => x.id === ev.source.id) ? s : [...s, ev.source]))
            setProgress((p) => ({ ...p, augment: [...p.augment, ev.source] }))
            break
          case 'augment:done':
            setProgress((p) => ({ ...p, augmentDone: true, phase: 'extracting' }))
            break
          case 'extract:paper':
            setProgress((p) => ({ ...p, phase: 'extracting', extract: [...p.extract, { sourceId: ev.sourceId, title: ev.title, nodes: ev.nodes }] }))
            break
          case 'graph:node':
            setNodes((n) => (n.some((x) => x.id === ev.node.id) ? n : [...n, ev.node]))
            setProgress((p) => ({ ...p, nodeCount: p.nodeCount + 1 }))
            break
          case 'graph:edge':
            setEdges((e) => (e.some((x) => x.id === ev.edge.id) ? e : [...e, ev.edge]))
            setProgress((p) => ({ ...p, edgeCount: p.edgeCount + 1 }))
            break
          case 'graph:settled':
            setProgress((p) => ({ ...p, settled: true, phase: 'settling', nodeCount: ev.nodes, edgeCount: ev.edges }))
            break
          case 'think':
            setProgress((p) => ({ ...p, narration: [...p.narration, ev.text] }))
            break
          case 'gaps':
            setGaps(ev.items)
            setProgress((p) => ({ ...p, phase: 'gaps' }))
            setPhase('built')
            break
          case 'done':
            setProgress((p) => ({ ...p, phase: 'done' }))
            break
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') throw err
    }
  }

  function selectGap(g: Gap) {
    setSelectedGap((cur) => (cur?.id === g.id ? null : g))
  }

  function runGapNow(g: Gap) {
    runAc.current?.abort()
    const ac = new AbortController()
    runAc.current = ac
    setSelectedGap(g)
    setRunningGapId(g.id)
    setRunEvents([])
    setRunResult(null)
    void consumeRun(g, ac.signal)
  }

  async function consumeRun(g: Gap, signal: AbortSignal) {
    try {
      for await (const rv of runGap(g, signal)) {
        if (signal.aborted) return
        if (rv.type === 'event') setRunEvents((e) => [...e, rv.event])
        else if (rv.type === 'resolve') {
          setEdges((es) => resolveEdges(es, rv.result))
          setRunResult(rv.result)
          // a gated (wet-lab, unapproved) run is NOT a completed run — never mark it "Ran".
          if (rv.result.verdict !== 'gated') setResolvedIds((s) => new Set(s).add(g.id))
        } else if (rv.type === 'done') setRunningGapId(null)
      }
    } catch (err) {
      // An aborted run was superseded by a newer run (or unmount) — that run owns
      // the state now, so don't clear its runningGapId. Only clear on a real error.
      if ((err as { name?: string })?.name === 'AbortError') return
      setRunningGapId(null)
    }
  }

  function addSource(p: PaperSource) {
    setSources((s) => [...s, p])
  }

  const { nodes: activeNodes, edges: activeEdges } = subgraphSets(selectedGap, edges)

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
          >
            <ArrowLeft className="size-3.5" strokeWidth={2} />
            Projects
          </button>
          <div className="min-w-0">
            <h2 className="truncate font-serif text-[22px] leading-none tracking-tight text-ink">{project.title}</h2>
            <p className="mt-1 truncate text-[12.5px] text-muted">{project.question}</p>
          </div>
        </div>
        {phase === 'built' && (
          <button
            onClick={startBuild}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
          >
            <RotateCcw className="size-3.5" strokeWidth={2} />
            Rebuild
          </button>
        )}
      </div>

      {/* body: LEFT panel (corpus → build → gaps → run) + RIGHT graph (animates in) */}
      <div className="flex min-h-0 flex-1 gap-5 px-6 pb-6 pt-4">
        {/* LEFT panel */}
        <div className="flex w-[400px] shrink-0 flex-col overflow-y-auto pr-1">
          <div className="flex flex-col gap-4 pb-6">
            {phase === 'setup' && (
              <SourceDropzone sources={sources} createdBy={project.createdBy} onAdd={addSource} onCreate={startBuild} building={false} />
            )}

            {phase !== 'setup' && gaps.length === 0 && <BuildStream progress={progress} />}

            {gaps.length > 0 && (
              <GapPanel
                gaps={gaps}
                selectedId={selectedGap?.id ?? null}
                runningId={runningGapId}
                resolvedIds={resolvedIds}
                onSelect={selectGap}
                onRun={runGapNow}
              />
            )}

            <AnimatePresence>
              {runEvents.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col gap-3 border-t border-line/70 pt-4"
                >
                  <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-faint">Running the gap</div>
                  <AgentTurn events={runEvents} running={runningGapId !== null} onOpenProtocol={() => {}} />
                </motion.div>
              )}
            </AnimatePresence>

            {runResult && selectedGap && <RunResultCard gap={selectedGap} result={runResult} />}
            {/* a gated (unapproved wet-lab) run never surfaces a "result" Slack post. */}
            {runResult && runResult.verdict !== 'gated' && <SlackDraftBubble action={runResult.slack} />}

            <div ref={endRef} />
          </div>
        </div>

        {/* RIGHT: project overview before build; the graph box zooms in on Create Graph */}
        <div className="relative min-w-0 flex-1">
          {phase === 'setup' ? (
            <ProjectOverview project={project} sources={sources} />
          ) : (
            <motion.div
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="relative h-full overflow-hidden rounded-2xl glass"
            >
              {nodes.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
                  <Loader2 className="size-5 animate-spin text-sage-500" strokeWidth={2} />
                  <span className="text-[12.5px]">assembling the graph…</span>
                </div>
              ) : (
                <>
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-muted">
                        <Loader2 className="size-5 animate-spin" strokeWidth={2} />
                      </div>
                    }
                  >
                    <KnowledgeGraph3D
                      nodes={nodes}
                      edges={edges}
                      activeNodes={activeNodes}
                      activeEdges={activeEdges}
                      recenterSignal={recenterNonce}
                      onSelectNode={() => setSelectedGap(null)}
                    />
                  </Suspense>

                  {/* top-left: what's on screen — the whole graph, or a focused gap */}
                  <div className="pointer-events-none absolute left-4 top-4 flex max-w-[60%] items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/70 px-2.5 py-1 text-[11.5px] font-medium text-muted backdrop-blur">
                    <Sparkles className="size-3 shrink-0 text-sage-500" strokeWidth={2} />
                    {selectedGap ? (
                      <span className="truncate">
                        Focused · <span className="text-ink">{selectedGap.title}</span>
                      </span>
                    ) : (
                      <span>
                        {nodes.length} nodes · {edges.length} edges
                      </span>
                    )}
                  </div>

                  {/* top-right: re-fit the camera after a manual drag */}
                  <button
                    onClick={() => setRecenterNonce((n) => n + 1)}
                    title="Recenter"
                    className="absolute right-4 top-4 flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/70 px-2.5 py-1 text-[11.5px] font-medium text-muted backdrop-blur transition-colors hover:bg-white hover:text-ink"
                  >
                    <Maximize2 className="size-3" strokeWidth={2.25} />
                    Recenter
                  </button>

                  <GraphLegend />
                </>
              )}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A compact legend for the edge semantics — the states a run flips. Node colour
 *  encodes entity type (hover a node for detail), so it stays out of the legend. */
function GraphLegend() {
  const items = [
    { label: 'asserted', color: '#5a5b52', dash: false },
    { label: 'predicted', color: '#c98a3c', dash: true },
    { label: 'confirmed', color: '#3f7d5c', dash: false },
    { label: 'conflict', color: '#c65744', dash: false },
  ]
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-3 rounded-full border border-black/[0.06] bg-white/70 px-3 py-1.5 text-[11px] text-muted backdrop-blur">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span
            className="h-[2px] w-4 shrink-0 rounded-full"
            style={
              it.dash
                ? { backgroundImage: `repeating-linear-gradient(90deg, ${it.color} 0 4px, transparent 4px 7px)` }
                : { background: it.color }
            }
          />
          {it.label}
        </span>
      ))}
    </div>
  )
}

/** The project page shown before a graph exists — question, method, and stats,
 *  so a project is "more than just the graph" on load. */
function ProjectOverview({ project, sources }: { project: Project; sources: PaperSource[] }) {
  const byId = new Map<string, Person>()
  for (const s of sources) if (s.addedBy.kind === 'human') byId.set(s.addedBy.person.id, s.addedBy.person)
  const contributors = [...byId.values()]
  const steps = [
    { icon: FileText, label: 'Extract', text: 'Papers → a causal graph of genes, proteins, hypotheses and results.' },
    { icon: GitFork, label: 'Find gaps', text: 'Open triads, contradictions and predicted links — ranked and cited.' },
    { icon: Play, label: 'Run', text: 'Dispatch a gap to the compute path; the wet-lab stays gated.' },
    { icon: Check, label: 'Resolve', text: 'The edge resolves and Claymore drafts the message to the lab.' },
  ]
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass flex h-full flex-col overflow-y-auto rounded-2xl p-7"
    >
      <div className="text-[12px] font-medium uppercase tracking-[0.12em] text-faint">Research question</div>
      <h1 className="mt-2 max-w-[560px] font-serif text-[28px] leading-tight tracking-tight text-ink">
        {project.question}
      </h1>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
        <span className="flex items-center gap-1.5">
          <FileText className="size-4 text-faint" strokeWidth={2} /> {sources.length} papers
        </span>
        <span className="flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {contributors.slice(0, 4).map((p) => (
              <Avatar key={p.id} name={p.name} accent={p.accent} size={22} photo={p.avatar} className="ring-2 ring-white/70" />
            ))}
          </span>
          {contributors.length} contributors
        </span>
        <span className="rounded-full bg-sage-500/12 px-2.5 py-0.5 font-medium text-sage-700">
          {DEMO_GAP_COUNT} gaps ready
        </span>
      </div>

      <div className="mt-7 grid max-w-[620px] grid-cols-1 gap-3 sm:grid-cols-2">
        {steps.map((s) => (
          <div key={s.label} className="flex items-start gap-3 rounded-xl bg-white/45 p-3.5 ring-1 ring-inset ring-black/[0.04]">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-sage-500/12 text-sage-600">
              <s.icon className="size-4" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">{s.label}</div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{s.text}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto pt-6 text-[12.5px] text-faint">
        Add papers on the left, then <span className="font-medium text-muted">Create Graph</span> to build the live
        knowledge graph and mine what to test next.
      </div>
    </motion.div>
  )
}

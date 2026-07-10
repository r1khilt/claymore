import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  RotateCcw,
  Database,
  Check,
  Loader2,
  Sparkles,
  FlaskConical,
  ShieldAlert,
} from 'lucide-react'
import type { AgentEvent } from '@/lib/agent'
import type { Protocol } from '@/lib/protocol'
import { runAutopilot, type Candidate, type IngestRow } from '@/lib/autopilot'
import { PLATFORM, PlatformIcon } from '@/lib/sources'
import { shortDate } from '@/lib/utils'
import { AgentTurn } from '@/components/ask/AgentTurn'
import { AnswerView } from '@/components/ask/AnswerView'

interface ExpState {
  id: string
  title: string
  subtitle: string
  events: AgentEvent[]
  running: boolean
}

type Phase = 'ingesting' | 'thinking' | 'running' | 'done'

function IngestPanel({ rows, totals }: { rows: IngestRow[]; totals: { episodes: number; sources: number } | null }) {
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-ink text-white">
          <Database className="size-[17px]" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Ingesting your lab</div>
          <div className="text-[12px] text-muted">Slack · Gmail · Notion · GitHub · Granola · iMessage</div>
        </div>
        {totals ? (
          <Check className="ml-auto size-4 shrink-0 text-sage-600" strokeWidth={2.5} />
        ) : (
          <Loader2 className="ml-auto size-4 shrink-0 animate-spin text-sage-500" strokeWidth={2.25} />
        )}
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {rows.map((row) => (
          <motion.div
            key={row.platform}
            layout
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2.5 rounded-xl bg-white/45 px-3 py-2 ring-1 ring-inset ring-black/[0.04]"
          >
            <PlatformIcon platform={row.platform} size={20} />
            <span className="text-[13px] text-ink">{PLATFORM[row.platform].label}</span>
            <span className="truncate text-[12px] text-faint">{row.label}</span>
            <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">
              {row.episodes.toLocaleString()} episodes
            </span>
            <Check className="size-3.5 shrink-0 text-sage-600" strokeWidth={2.5} />
          </motion.div>
        ))}
        {!totals && rows.length > 0 && (
          <div className="flex items-center gap-1.5 pl-1 pt-0.5 text-[12.5px] text-faint">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} /> syncing…
          </div>
        )}
      </div>

      {totals && (
        <div className="mt-3 border-t border-line/70 pt-3 text-[12.5px] text-muted">
          {totals.episodes.toLocaleString()} episodes · {totals.sources} sources · provenance preserved,
          no tagging needed
        </div>
      )}
    </motion.section>
  )
}

function CandidateCard({ c }: { c: Candidate }) {
  const gated = c.disposition === 'gated'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-xl p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1 text-[14px] font-medium text-ink">{c.title}</div>
        <span
          className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            gated ? 'bg-amber-400/18 text-amber-500' : 'bg-sage-500/14 text-sage-700'
          }`}
        >
          {gated && <ShieldAlert className="size-3" strokeWidth={2.25} />}
          {gated ? 'needs approval' : 'auto-run'}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink/75">{c.rationale}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {c.citations.map((cit, i) => (
          <span key={i} className="flex items-center gap-1.5 text-[12px] text-muted">
            <PlatformIcon platform={cit.sourcePlatform} size={14} />
            <span className="font-medium text-ink/75">{cit.author}</span>
            <span className="text-faint">{shortDate(cit.timestamp)}</span>
          </span>
        ))}
      </div>
    </motion.div>
  )
}

/** "Run" mode: Claymore ingests everything, decides what's worth running, and runs
 *  the safe experiments itself — a self-driving version of the Composer. Lives in
 *  the middle section only; sidebar + source rail are unchanged around it. */
export function RunView({
  onOpenProtocol,
  onBack,
}: {
  onOpenProtocol: (p: Protocol) => void
  onBack: () => void
}) {
  const [runToken, setRunToken] = useState(0)
  const [ingestRows, setIngestRows] = useState<IngestRow[]>([])
  const [totals, setTotals] = useState<{ episodes: number; sources: number } | null>(null)
  const [narration, setNarration] = useState<string[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [experiments, setExperiments] = useState<ExpState[]>([])
  const [summary, setSummary] = useState<{
    text: string
    citations: Candidate['citations']
    pendingAction: Parameters<typeof AnswerView>[0]['reply']['pendingAction']
  } | null>(null)
  const [phase, setPhase] = useState<Phase>('ingesting')
  const endRef = useRef<HTMLDivElement>(null)

  // Start on mount; restart only when the user hits "Run again" (runToken bumps).
  // Deliberately not keyed on visibility, so an in-flight run survives navigation.
  useEffect(() => {
    const ac = new AbortController()
    void consume(ac.signal)
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [ingestRows, narration, candidates, experiments, summary])

  async function consume(signal: AbortSignal) {
    setIngestRows([])
    setTotals(null)
    setNarration([])
    setCandidates([])
    setExperiments([])
    setSummary(null)
    setPhase('ingesting')
    try {
      for await (const ev of runAutopilot(signal)) {
        if (signal.aborted) return
        switch (ev.type) {
          case 'ingest:source':
            setIngestRows((r) => [...r, ev.row])
            break
          case 'ingest:done':
            setTotals({ episodes: ev.episodes, sources: ev.sources })
            setPhase('thinking')
            break
          case 'think':
            setNarration((n) => [...n, ev.text])
            break
          case 'candidates':
            setCandidates(ev.items)
            setPhase('running')
            break
          case 'exp:start':
            setExperiments((x) => [
              ...x,
              { id: ev.id, title: ev.title, subtitle: ev.subtitle, events: [], running: true },
            ])
            break
          case 'exp:event':
            setExperiments((x) =>
              x.map((e) => (e.id === ev.id ? { ...e, events: [...e.events, ev.event] } : e)),
            )
            break
          case 'exp:done':
            setExperiments((x) => x.map((e) => (e.id === ev.id ? { ...e, running: false } : e)))
            break
          case 'summary':
            setSummary({ text: ev.text, citations: ev.citations, pendingAction: ev.pendingAction ?? null })
            break
          case 'done':
            setPhase('done')
            break
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') throw err
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
          >
            <ArrowLeft className="size-3.5" strokeWidth={2} />
            Back
          </button>
          <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-faint">Autopilot</span>
        </div>
        <button
          onClick={() => setRunToken((t) => t + 1)}
          disabled={phase !== 'done'}
          className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
        >
          <RotateCcw className="size-3.5" strokeWidth={2} />
          Run again
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-7">
          <IngestPanel rows={ingestRows} totals={totals} />

          {narration.length > 0 && (
            <div className="flex flex-col gap-2">
              {narration.map((t, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 text-[13.5px] text-muted"
                >
                  <Sparkles className="size-3.5 shrink-0 text-sage-500" strokeWidth={2} />
                  <span className="italic">{t}</span>
                </motion.div>
              ))}
            </div>
          )}

          {candidates.length > 0 && (
            <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2.5">
              <div className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.1em] text-faint">
                The plan · {candidates.length} experiments
              </div>
              {candidates.map((c) => (
                <CandidateCard key={c.id} c={c} />
              ))}
            </motion.section>
          )}

          {experiments.map((exp) => (
            <div key={exp.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <FlaskConical className="size-4 self-center text-sage-500" strokeWidth={2} />
                <h3 className="text-[17px] font-medium tracking-tight text-ink">{exp.title}</h3>
                <span className="text-[12.5px] text-faint">{exp.subtitle}</span>
              </div>
              <AgentTurn events={exp.events} running={exp.running} onOpenProtocol={onOpenProtocol} />
            </div>
          ))}

          {summary && (
            <div className="flex flex-col gap-3 border-t border-line/70 pt-6">
              <div className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.1em] text-faint">
                <Check className="size-3.5 text-sage-600" strokeWidth={2.5} />
                Run complete
              </div>
              <AnswerView
                reply={{ text: summary.text, citations: summary.citations, pendingAction: summary.pendingAction }}
              />
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>
    </div>
  )
}

/**
 * GapPanel — the ranked, cited gaps the engine found. Each gap says its method
 * out loud (open triad · link-pred · contradiction · fragile), shows its
 * novelty×plausibility×testability score, cites the bridging papers, and offers
 * "Run this now". Clicking a gap highlights its subgraph in the 3D graph.
 */
import { motion } from 'framer-motion'
import { FlaskConical, ShieldAlert, GitFork, Sparkles, Scale, ShieldQuestion, Play, Check, Loader2, FileText, type LucideIcon } from 'lucide-react'
import type { Gap, GapKind } from '@/lib/projectTypes'

const KIND_META: Record<GapKind, { label: string; icon: LucideIcon; cls: string }> = {
  open_triad: { label: 'open triad', icon: GitFork, cls: 'bg-sage-500/14 text-sage-700' },
  link_prediction: { label: 'link prediction', icon: Sparkles, cls: 'bg-amber-400/18 text-amber-500' },
  contradiction: { label: 'contradiction', icon: Scale, cls: 'bg-clay-500/14 text-clay-500' },
  fragile: { label: 'fragile edge', icon: ShieldQuestion, cls: 'bg-amber-400/18 text-amber-500' },
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-black/[0.06]">
        <div className="h-full rounded-full bg-sage-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-medium tabular-nums text-muted">{(score).toFixed(2)}</span>
    </div>
  )
}

function GapCard({
  gap,
  selected,
  running,
  resolved,
  onSelect,
  onRun,
}: {
  gap: Gap
  selected: boolean
  running: boolean
  resolved: boolean
  onSelect: () => void
  onRun: () => void
}) {
  const meta = KIND_META[gap.kind]
  const Icon = meta.icon
  const wet = gap.proposedRun.mode === 'wetlab'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onSelect}
      className={`glass cursor-pointer rounded-xl p-3.5 transition-shadow ${
        selected ? 'ring-2 ring-inset ring-sage-500/40' : 'hover:shadow-[0_14px_40px_-16px_rgba(28,29,24,0.22)]'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${meta.cls}`}>
          <Icon className="size-3" strokeWidth={2.25} />
          {meta.label}
        </span>
        {resolved && (
          <span className="flex items-center gap-1 rounded-full bg-sage-500/14 px-2 py-0.5 text-[10.5px] font-medium text-sage-700">
            <Check className="size-3" strokeWidth={2.5} />
            resolved
          </span>
        )}
        <div className="ml-auto">
          <ScoreBar score={gap.score} />
        </div>
      </div>

      <div className="mt-2 text-[14px] font-medium leading-snug text-ink">{gap.title}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-faint">
        <FlaskConical className="size-3 shrink-0" strokeWidth={2} />
        <span className="italic">{gap.method}</span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink/70">{gap.rationale}</p>

      {gap.citations.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {gap.citations.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5 text-[11.5px] text-muted">
              <FileText className="size-3 shrink-0 text-faint" strokeWidth={2} />
              <span className="font-medium text-ink/75">{c.author}</span>
              <span className="text-faint">{c.sourceLabel}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRun()
          }}
          disabled={running || resolved}
          className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {running ? (
            <>
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2.5} /> Running
            </>
          ) : resolved ? (
            <>
              <Check className="size-3.5" strokeWidth={2.5} /> Ran
            </>
          ) : (
            <>
              <Play className="size-3.5" strokeWidth={2.5} /> Run
            </>
          )}
        </button>
        {wet ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-500">
            <ShieldAlert className="size-3" strokeWidth={2.25} /> wet-lab · gated
          </span>
        ) : (
          <span className="text-[11px] text-faint">{gap.proposedRun.label}</span>
        )}
      </div>
    </motion.div>
  )
}

export function GapPanel({
  gaps,
  selectedId,
  runningId,
  resolvedIds,
  onSelect,
  onRun,
}: {
  gaps: Gap[]
  selectedId: string | null
  runningId: string | null
  resolvedIds: Set<string>
  onSelect: (g: Gap) => void
  onRun: (g: Gap) => void
}) {
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.1em] text-faint">
        <GitFork className="size-3.5" strokeWidth={2} />
        {gaps.length} gap{gaps.length === 1 ? '' : 's'} found · ranked
      </div>
      {gaps.map((g) => (
        <GapCard
          key={g.id}
          gap={g}
          selected={selectedId === g.id}
          running={runningId === g.id}
          resolved={resolvedIds.has(g.id)}
          onSelect={() => onSelect(g)}
          onRun={() => onRun(g)}
        />
      ))}
    </motion.section>
  )
}

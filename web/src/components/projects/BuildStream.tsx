/**
 * BuildStream — the streamed "building the graph" panel (mirrors RunView's
 * IngestPanel). Presentational: ProjectDetail owns the phase machine + graph
 * state and feeds this the running progress. Shows the sufficiency gate, Exa
 * augmentation (auto-sourced, marked distinct), per-paper extraction, the settle
 * summary, and the synthesis narration — in the exact ingest-panel look.
 */
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Waypoints, Check, Loader2, Sparkles, ShieldAlert, FileText } from 'lucide-react'
import type { PaperSource } from '@/lib/projectTypes'

export type BuildPhase = 'checking' | 'augmenting' | 'extracting' | 'settling' | 'gaps' | 'done'

export interface BuildProgress {
  phase: BuildPhase
  sufficiency: { have: number; need: number; floor: number; ok: boolean } | null
  augment: PaperSource[]
  augmentDone: boolean
  extract: { sourceId: string; title: string; nodes: number }[]
  nodeCount: number
  edgeCount: number
  settled: boolean
  narration: string[]
}

function Row({ children, done }: { children: ReactNode; done?: boolean }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-2.5 rounded-xl bg-white/45 px-3 py-2 ring-1 ring-inset ring-black/[0.04]"
    >
      {children}
      {done && <Check className="ml-auto size-3.5 shrink-0 text-sage-600" strokeWidth={2.5} />}
    </motion.div>
  )
}

export function BuildStream({ progress }: { progress: BuildProgress }) {
  const { sufficiency, augment, augmentDone, extract, settled, narration, nodeCount, edgeCount } = progress
  const complete = progress.phase === 'done' || progress.phase === 'gaps'

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-ink text-white">
          <Waypoints className="size-[17px]" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Building the graph</div>
          <div className="text-[12px] text-muted">extraction · causal relations · gap engine</div>
        </div>
        {complete ? (
          <Check className="ml-auto size-4 shrink-0 text-sage-600" strokeWidth={2.5} />
        ) : (
          <Loader2 className="ml-auto size-4 shrink-0 animate-spin text-sage-500" strokeWidth={2.25} />
        )}
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {sufficiency && (
          <Row done>
            {sufficiency.ok ? (
              <Check className="size-4 shrink-0 text-sage-600" strokeWidth={2.5} />
            ) : (
              <ShieldAlert className="size-4 shrink-0 text-amber-500" strokeWidth={2.25} />
            )}
            <span className="text-[13px] text-ink">Sufficiency gate</span>
            <span className="truncate text-[12px] text-faint">
              {sufficiency.ok
                ? `${sufficiency.have} sources · sufficient`
                : `${sufficiency.have} < ${sufficiency.floor} — sourcing ${sufficiency.need} via Exa`}
            </span>
          </Row>
        )}

        {augment.map((s) => (
          <Row key={s.id} done>
            <Sparkles className="size-4 shrink-0 text-amber-500" strokeWidth={2.25} />
            <span className="truncate text-[13px] text-ink">{s.paperAuthors}</span>
            <span className="truncate text-[12px] text-faint">
              {s.venue} {s.year}
            </span>
            <span className="ml-auto shrink-0 rounded-full bg-amber-400/18 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-500">
              exa
            </span>
          </Row>
        ))}
        {augment.length > 0 && !augmentDone && (
          <div className="flex items-center gap-1.5 pl-1 text-[12.5px] text-faint">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} /> sourcing…
          </div>
        )}

        {extract.map((e) => (
          <Row key={e.sourceId} done>
            <FileText className="size-4 shrink-0 text-muted" strokeWidth={2} />
            <span className="truncate text-[13px] text-ink">{e.title}</span>
            <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">{e.nodes} nodes</span>
          </Row>
        ))}
      </div>

      {settled && (
        <div className="mt-3 border-t border-line/70 pt-3 text-[12.5px] text-muted">
          {nodeCount} entities · {edgeCount} relations · provenance preserved
        </div>
      )}

      {narration.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {narration.map((t, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 text-[13px] text-muted"
            >
              <Sparkles className="size-3.5 shrink-0 text-sage-500" strokeWidth={2} />
              <span className="italic">{t}</span>
            </motion.div>
          ))}
        </div>
      )}
    </motion.section>
  )
}

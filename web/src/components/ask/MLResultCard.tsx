import { motion } from 'framer-motion'
import { Check, X, Minus, Database, Cpu, User, type LucideIcon } from 'lucide-react'
import type { MLResult, Verdict } from '@/lib/agent'

const VERDICT: Record<Verdict, { label: string; icon: LucideIcon; badge: string }> = {
  supported: { label: 'Supported', icon: Check, badge: 'bg-sage-500/10 text-sage-700' },
  refuted: { label: 'Refuted', icon: X, badge: 'bg-clay-500/10 text-clay-500' },
  inconclusive: { label: 'Inconclusive', icon: Minus, badge: 'bg-amber-400/15 text-amber-500' },
}

function Chip({ icon: Icon, children }: { icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/50 px-2 py-1 text-faint ring-1 ring-inset ring-black/[0.05]">
      {Icon && <Icon className="size-3 shrink-0" strokeWidth={2} />}
      {children}
    </span>
  )
}

/**
 * The result card for a data-driven ML analysis: the grounded verdict on a hypothesis, the metrics
 * behind it, the *attribution* of the dataset it trained on (who referenced it, where — hard rule
 * 1), the model, and inline SVG charts. Charts arrive as self-contained SVG (untrusted labels
 * escaped server-side in execute/charts.py) and are embedded directly.
 */
export function MLResultCard({ result }: { result: MLResult }) {
  const v = VERDICT[result.verdict] ?? VERDICT.inconclusive
  const VIcon = v.icon
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-raised rounded-2xl p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-white">
          <Cpu className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{result.title}</div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.badge}`}>
          <VIcon className="size-3" strokeWidth={2.75} />
          {v.label}
        </span>
      </div>

      <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink/85">
        <span className="text-faint">Hypothesis · </span>
        {result.hypothesis}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{result.rationale}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        <Chip icon={Database}>
          {result.datasetName} · {result.nRows} rows × {result.nFeatures} features
        </Chip>
        <Chip icon={User}>
          {result.datasetAuthor} · {result.datasetSource}
        </Chip>
        <Chip icon={Cpu}>{result.modelKind}</Chip>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {result.metrics.map((m) => (
          <div key={m.label} className="rounded-xl bg-white/50 p-2.5 ring-1 ring-inset ring-black/[0.05]">
            <div className="truncate font-serif text-[17px] leading-none text-ink">{m.value}</div>
            <div className="mt-1 truncate text-[11px] text-faint">{m.label}</div>
          </div>
        ))}
      </div>

      {result.charts.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {result.charts.map((c, i) => (
            <div key={i} className="rounded-xl bg-white/45 p-2.5 ring-1 ring-inset ring-black/[0.05]">
              <div className="mb-1.5 text-[11px] font-medium text-muted">{c.title}</div>
              <div
                className="overflow-x-auto [&_svg]:block [&_svg]:w-full"
                // Self-contained SVG built by us; untrusted labels are escaped in execute/charts.py.
                dangerouslySetInnerHTML={{ __html: c.svg }}
              />
            </div>
          ))}
        </div>
      )}
    </motion.div>
  )
}

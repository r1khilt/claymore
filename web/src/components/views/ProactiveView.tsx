import { motion } from 'framer-motion'
import { Lightbulb, GitCompareArrows, Newspaper, ArrowRight, X, type LucideIcon } from 'lucide-react'
import type { LabNotification, NotificationKind } from '@/lib/types'
import { notifications } from '@/lib/mockData'
import { PlatformIcon } from '@/lib/sources'
import { ViewShell } from './ViewShell'
import { shortDate } from '@/lib/utils'

const KIND: Record<
  NotificationKind,
  { icon: LucideIcon; label: string; tint: string; fg: string }
> = {
  never_tested: { icon: Lightbulb, label: 'Never tested', tint: 'bg-sage-500/14', fg: 'text-sage-700' },
  contradiction: {
    icon: GitCompareArrows,
    label: 'Contradiction',
    tint: 'bg-clay-500/14',
    fg: 'text-clay-500',
  },
  digest: { icon: Newspaper, label: 'Digest', tint: 'bg-amber-400/18', fg: 'text-amber-500' },
}

const PRIORITY: Record<LabNotification['priority'], string> = {
  high: 'text-clay-500',
  normal: 'text-muted',
  low: 'text-faint',
}

function Card({ n }: { n: LabNotification }) {
  const k = KIND[n.kind]
  const Icon = k.icon
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-2xl p-4"
    >
      <div className="flex items-center gap-2.5">
        <span className={`grid size-8 place-items-center rounded-lg ${k.tint} ${k.fg}`}>
          <Icon className="size-[17px]" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{n.title}</div>
          <div className={`text-[11.5px] font-medium uppercase tracking-wide ${PRIORITY[n.priority]}`}>
            {k.label} · {n.priority} priority
          </div>
        </div>
        <button className="ml-auto grid size-7 place-items-center rounded-lg text-faint transition-colors hover:bg-black/5 hover:text-ink">
          <X className="size-4" strokeWidth={2} />
        </button>
      </div>

      <p className="mt-3 text-[14px] leading-relaxed text-ink/80">{n.body}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {n.citations.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5 text-[12px] text-muted">
            <PlatformIcon platform={c.sourcePlatform} size={15} />
            <span className="font-medium text-ink/75">{c.author}</span>
            <span className="text-faint">{shortDate(c.timestamp)}</span>
          </span>
        ))}
      </div>

      <div className="mt-3.5 flex items-center gap-2 border-t border-line/70 pt-3">
        <button className="flex items-center gap-1.5 rounded-lg bg-sage-500 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-sage-600">
          Ask about this
          <ArrowRight className="size-3.5" strokeWidth={2.25} />
        </button>
        <button className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-black/5 hover:text-ink">
          Dismiss
        </button>
      </div>
    </motion.div>
  )
}

export function ProactiveView() {
  return (
    <ViewShell
      title="Proactive"
      subtitle="Claymore reaches out first — surfacing untested ideas, contradicted decisions, and briefs before you ask."
    >
      <div className="flex flex-col gap-3">
        {notifications.map((n) => (
          <Card key={n.id} n={n} />
        ))}
      </div>
    </ViewShell>
  )
}

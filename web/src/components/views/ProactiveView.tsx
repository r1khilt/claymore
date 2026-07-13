import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Lightbulb, GitCompareArrows, Newspaper, ArrowRight, BellOff, X, type LucideIcon } from 'lucide-react'
import type { LabNotification, NotificationKind } from '@/lib/types'
import { notifications } from '@/lib/mockData'
import { PlatformIcon } from '@/lib/sources'
import { ViewShell } from './ViewShell'
import { shortDate } from '@/lib/utils'

/** The question "Ask about this" pre-fills into the composer for each nudge kind.
 *  Phrased to route to a grounded, cited answer (see mockData CANNED). */
function askPrompt(n: LabNotification): string {
  if (n.kind === 'never_tested')
    return "The allosteric-pocket idea from last week was never tested — what would it take to run it, and what's blocking?"
  if (n.kind === 'contradiction')
    return 'A lab decision may have been superseded — reconcile Tuesday’s roundup with Sofia’s email and tell me which is current.'
  return 'Expand on the Thursday brief — what moved on CBX2 this week?'
}

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

function Card({ n, onAsk, onDismiss }: { n: LabNotification; onAsk: (q: string) => void; onDismiss: (id: string) => void }) {
  const k = KIND[n.kind]
  const Icon = k.icon
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
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
        <button
          onClick={() => onDismiss(n.id)}
          aria-label="Dismiss"
          className="ml-auto grid size-7 place-items-center rounded-lg text-faint transition-colors hover:bg-black/5 hover:text-ink"
        >
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
        <button
          onClick={() => onAsk(askPrompt(n))}
          className="flex items-center gap-1.5 rounded-lg bg-sage-500 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-sage-600 active:scale-[0.97]"
        >
          Ask about this
          <ArrowRight className="size-3.5" strokeWidth={2.25} />
        </button>
        <button
          onClick={() => onDismiss(n.id)}
          className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-black/5 hover:text-ink"
        >
          Dismiss
        </button>
      </div>
    </motion.div>
  )
}

/** The Proactive content (nudge cards), shell-free so the merged Inbox tab can compose it.
 *  `ProactiveView` below keeps the standalone page intact. */
export function ProactiveSection({
  onAsk = () => {},
  onCountChange,
}: {
  onAsk?: (q: string) => void
  onCountChange?: (n: number) => void
}) {
  const [items, setItems] = useState<LabNotification[]>(notifications)
  useEffect(() => {
    onCountChange?.(items.length)
  }, [items.length, onCountChange])
  const dismiss = (id: string) => setItems((xs) => xs.filter((n) => n.id !== id))

  return (
    <>
      {items.length === 0 ? (
        <div className="glass flex items-center justify-center gap-2 rounded-2xl px-4 py-8 text-[13px] text-muted">
          <BellOff className="size-4 text-faint" strokeWidth={1.85} />
          Nothing to surface right now — you’re current.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {items.map((n) => (
              <Card key={n.id} n={n} onAsk={onAsk} onDismiss={dismiss} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </>
  )
}

export function ProactiveView({
  onAsk,
  onCountChange,
}: {
  onAsk?: (q: string) => void
  onCountChange?: (n: number) => void
}) {
  return (
    <ViewShell
      title="Proactive"
      subtitle="Claymore reaches out first — surfacing untested ideas, contradicted decisions, and briefs before you ask."
    >
      <ProactiveSection onAsk={onAsk} onCountChange={onCountChange} />
    </ViewShell>
  )
}

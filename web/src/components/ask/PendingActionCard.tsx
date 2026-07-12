import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  CornerUpLeft,
  CircleDot,
  FileText,
  Calendar,
  Cpu,
  FlaskConical,
  Send,
  Bot,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ActionKind, PendingAction } from '@/lib/types'

const KIND_ICON: Record<ActionKind, LucideIcon> = {
  draft_reply: CornerUpLeft,
  file_issue: CircleDot,
  create_page: FileText,
  make_link: Calendar,
  post_result: Send,
  run_compute: Cpu,
  propose_protocol: FlaskConical,
  physical_run: Bot,
}

const KIND_LABEL: Record<ActionKind, string> = {
  draft_reply: 'Draft reply',
  file_issue: 'File issue',
  create_page: 'Create page',
  make_link: 'Calendar link',
  post_result: 'Post result',
  run_compute: 'Run compute',
  propose_protocol: 'Propose protocol',
  physical_run: 'Physical run',
}

export function PendingActionCard({
  action,
  onApprove,
  onDismiss,
}: {
  action: PendingAction
  /** Called once the approved action finishes "executing" — parent moves it to Recently executed. */
  onApprove?: (a: PendingAction) => void
  onDismiss?: (token: string) => void
}) {
  const [state, setState] = useState<'pending' | 'approved' | 'done' | 'dismissed'>('pending')
  const Icon = KIND_ICON[action.kind]

  // Approve → brief "executing…" → terminal "Done", then hand the item up to the parent.
  useEffect(() => {
    if (state !== 'approved') return
    const t = window.setTimeout(() => {
      setState('done')
      onApprove?.(action)
    }, 1300)
    return () => window.clearTimeout(t)
  }, [state, action, onApprove])

  if (state === 'dismissed') return null

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-raised overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span className="grid size-7 place-items-center rounded-lg bg-amber-400/18 text-amber-500">
          <Icon className="size-[16px]" strokeWidth={2} />
        </span>
        <div className="text-[13px] font-medium text-ink">{action.description}</div>
        <span className="ml-auto rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">
          {action.token}
        </span>
      </div>

      <div className="px-4 pb-2 pt-2">
        <div className="rounded-xl bg-white/50 p-3 text-[13px] leading-relaxed text-ink/80 ring-1 ring-inset ring-black/[0.05]">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            <span>{KIND_LABEL[action.kind]}</span>
            <span className="text-faint/60">→</span>
            <span className="font-mono normal-case text-muted">{action.target}</span>
          </div>
          <p className="whitespace-pre-wrap">{action.preview}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-1">
        <AnimatePresence mode="wait" initial={false}>
          {state === 'done' ? (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 rounded-lg bg-sage-500/14 px-3 py-1.5 text-[13px] font-medium text-sage-700"
            >
              <Check className="size-4" strokeWidth={2.5} />
              Executed
            </motion.div>
          ) : state === 'approved' ? (
            <motion.div
              key="approved"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 rounded-lg bg-sage-500/14 px-3 py-1.5 text-[13px] font-medium text-sage-700"
            >
              <Loader2 className="size-4 animate-spin" strokeWidth={2.5} />
              Executing…
            </motion.div>
          ) : (
            <motion.div key="actions" className="flex items-center gap-2">
              <button
                onClick={() => setState('approved')}
                className="flex items-center gap-1.5 rounded-lg bg-sage-500 px-3.5 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-sage-600 active:scale-[0.97]"
              >
                <Check className="size-4" strokeWidth={2.5} />
                Approve
              </button>
              <button
                onClick={() => {
                  setState('dismissed')
                  onDismiss?.(action.token)
                }}
                className="grid size-8 place-items-center rounded-lg text-faint transition-colors hover:bg-black/5 hover:text-ink"
                title="Dismiss"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <span className="ml-auto text-[11.5px] text-faint">You just approve — nothing runs until you do.</span>
      </div>
    </motion.div>
  )
}

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Inbox } from 'lucide-react'
import type { PendingAction } from '@/lib/types'
import { ViewShell } from './ViewShell'
import { PendingActionCard } from '@/components/ask/PendingActionCard'
import { PlatformIcon } from '@/lib/sources'

type ExecutedItem = { platform: 'notion' | 'github'; text: string; when: string }

const PENDING: PendingAction[] = [
  {
    token: 'A1',
    kind: 'draft_reply',
    description: 'Reply to Lucas in #protein-eng',
    target: '#protein-eng',
    preview:
      "Following up on your allosteric idea — Philip already prepped the CBX2 allosteric site + grid box in docking-pipeline, and the Tuesday sync prioritized this pass. Want me to queue the run with Maya's <2% DMSO buffer?",
  },
  {
    token: 'A2',
    kind: 'file_issue',
    description: 'File an issue on claymore/docking-pipeline',
    target: 'claymore/docking-pipeline',
    preview:
      'Run Y-hypothesis control on CBX2 allosteric site\n\nNever executed (confirmed via memory). Use the prepped grid box from 3f2c1ab and the <2% DMSO buffer (Assay Buffer v3). Requested by Rikhin, originally proposed by Lucas.',
  },
]

const EXECUTED: ExecutedItem[] = [
  { platform: 'notion', text: 'Created “CBX2 allosteric — run log” page', when: 'yesterday' },
  { platform: 'github', text: 'Filed issue #212 · buffer DMSO ceiling', when: '2 days ago' },
]

/** Where an approved action lands in "Recently executed" — a plausible line per action kind. */
function executedLine(a: PendingAction): ExecutedItem {
  if (a.kind === 'file_issue') return { platform: 'github', text: `Filed issue · ${a.target}`, when: 'just now' }
  if (a.kind === 'create_page') return { platform: 'notion', text: `Created page · ${a.target}`, when: 'just now' }
  return { platform: 'notion', text: a.description, when: 'just now' }
}

/** The Approvals content (pending cards + recently executed), shell-free so the merged
 *  Inbox tab can compose it. `ApprovalsView` below keeps the standalone page intact. */
export function ApprovalsSection({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [pending, setPending] = useState<PendingAction[]>(PENDING)
  const [executed, setExecuted] = useState<ExecutedItem[]>(EXECUTED)

  useEffect(() => {
    onCountChange?.(pending.length)
  }, [pending.length, onCountChange])

  const resolve = (token: string) => setPending((p) => p.filter((a) => a.token !== token))

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
        Pending · {pending.length}
      </div>
      {pending.length === 0 ? (
        <div className="glass flex items-center justify-center gap-2 rounded-2xl px-4 py-8 text-[13px] text-muted">
          <Inbox className="size-4 text-faint" strokeWidth={1.85} />
          You’re all caught up — nothing waiting on you.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {pending.map((a) => (
              <PendingActionCard
                key={a.token}
                action={a}
                onApprove={(act) => {
                  setExecuted((e) => [executedLine(act), ...e])
                  resolve(act.token)
                }}
                onDismiss={resolve}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="mb-3 mt-8 flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
        Recently executed
      </div>
      <div className="glass flex flex-col divide-y divide-line/70 rounded-2xl">
        {executed.map((e, i) => (
          <motion.div
            key={`${e.text}-${i}`}
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 px-4 py-3"
          >
            <span className="grid size-6 place-items-center rounded-full bg-sage-500/14 text-sage-700">
              <Check className="size-3.5" strokeWidth={2.5} />
            </span>
            <PlatformIcon platform={e.platform} size={18} />
            <span className="text-[13.5px] text-ink/85">{e.text}</span>
            <span className="ml-auto text-[12px] text-faint">{e.when}</span>
          </motion.div>
        ))}
      </div>
    </>
  )
}

export function ApprovalsView({ onCountChange }: { onCountChange?: (n: number) => void }) {
  return (
    <ViewShell
      title="Approvals"
      subtitle="Claymore drafts the work — a reply, an issue, a page. Nothing runs until you approve it."
    >
      <ApprovalsSection onCountChange={onCountChange} />
    </ViewShell>
  )
}

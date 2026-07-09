import { Check } from 'lucide-react'
import type { PendingAction } from '@/lib/types'
import { ViewShell } from './ViewShell'
import { PendingActionCard } from '@/components/ask/PendingActionCard'
import { PlatformIcon } from '@/lib/sources'

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

const EXECUTED = [
  { platform: 'notion' as const, text: 'Created “CBX2 allosteric — run log” page', when: 'yesterday' },
  { platform: 'github' as const, text: 'Filed issue #212 · buffer DMSO ceiling', when: '2 days ago' },
]

export function ApprovalsView() {
  return (
    <ViewShell
      title="Approvals"
      subtitle="Claymore drafts the work — a reply, an issue, a page. Nothing runs until you approve it."
    >
      <div className="mb-3 flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
        Pending · {PENDING.length}
      </div>
      <div className="flex flex-col gap-3">
        {PENDING.map((a) => (
          <PendingActionCard key={a.token} action={a} />
        ))}
      </div>

      <div className="mb-3 mt-8 flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
        Recently executed
      </div>
      <div className="glass flex flex-col divide-y divide-line/70 rounded-2xl">
        {EXECUTED.map((e, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <span className="grid size-6 place-items-center rounded-full bg-sage-500/14 text-sage-700">
              <Check className="size-3.5" strokeWidth={2.5} />
            </span>
            <PlatformIcon platform={e.platform} size={18} />
            <span className="text-[13.5px] text-ink/85">{e.text}</span>
            <span className="ml-auto text-[12px] text-faint">{e.when}</span>
          </div>
        ))}
      </div>
    </ViewShell>
  )
}

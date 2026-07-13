import { ViewShell } from './ViewShell'
import { ProactiveSection } from './ProactiveView'
import { ApprovalsSection } from './ApprovalsView'

/** The merged Proactive + Approvals tab: nudges Claymore surfaced on top, then the
 *  actions waiting on approval. The standalone views still exist for their own routes. */
export function InboxView({
  onAsk,
  onApprovalsCountChange,
  onProactiveCountChange,
}: {
  onAsk?: (q: string) => void
  onApprovalsCountChange?: (n: number) => void
  onProactiveCountChange?: (n: number) => void
}) {
  return (
    <ViewShell
      title="Inbox"
      subtitle="Claymore reaches out first and drafts the work — nudges it surfaced, and actions waiting on your approval."
    >
      <div className="mb-3 flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
        Surfaced for you
      </div>
      <ProactiveSection onAsk={onAsk} onCountChange={onProactiveCountChange} />
      <div className="mt-8">
        <ApprovalsSection onCountChange={onApprovalsCountChange} />
      </div>
    </ViewShell>
  )
}

import { Plus, Check } from 'lucide-react'
import type { Connector } from '@/lib/types'
import { connectors } from '@/lib/mockData'
import { PlatformIcon } from '@/lib/sources'
import { ViewShell } from './ViewShell'
import { timeAgo } from '@/lib/utils'

function ConnectorCard({ c }: { c: Connector }) {
  return (
    <div className="glass flex flex-col rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={c.platform} size={38} />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold text-ink">{c.name}</div>
          <div className="truncate text-[12px] text-faint">{c.account ?? 'Not connected'}</div>
        </div>
        {c.connected ? (
          <span className="flex items-center gap-1 rounded-full bg-sage-500/14 px-2 py-1 text-[11.5px] font-medium text-sage-700">
            <Check className="size-3" strokeWidth={2.5} />
            Connected
          </span>
        ) : (
          <button className="flex items-center gap-1 rounded-full border border-black/[0.08] bg-white/50 px-2.5 py-1 text-[11.5px] font-medium text-muted transition-colors hover:text-ink">
            <Plus className="size-3" strokeWidth={2.5} />
            Connect
          </button>
        )}
      </div>
      {c.connected && (
        <div className="mt-3.5 flex items-center justify-between border-t border-line/70 pt-3 text-[12px] text-muted">
          <span>
            <span className="font-medium text-ink/80">{c.episodes?.toLocaleString()}</span> episodes
          </span>
          <span className="text-faint">synced {c.lastSync ? `${timeAgo(c.lastSync)} ago` : ''}</span>
        </div>
      )}
    </div>
  )
}

export function ConnectorsView() {
  const connected = connectors.filter((c) => c.connected)
  const total = connected.reduce((n, c) => n + (c.episodes ?? 0), 0)
  return (
    <ViewShell
      title="Connectors"
      subtitle="Managed OAuth via Composio. Every message, email, doc and commit becomes attributed memory — no tagging."
      action={
        <div className="text-right">
          <div className="font-serif text-[28px] leading-none text-sage-600">
            {total.toLocaleString()}
          </div>
          <div className="mt-1 text-[12px] text-faint">episodes in memory</div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {connectors.map((c) => (
          <ConnectorCard key={c.platform} c={c} />
        ))}
      </div>
    </ViewShell>
  )
}

import { Layers } from 'lucide-react'
import { connectors, feeds } from '@/lib/mockData'
import { SourcePanel } from './SourcePanel'

export function SourceRail() {
  const connected = connectors.filter((c) => c.connected).length
  return (
    <aside className="flex h-full w-[352px] shrink-0 flex-col border-l border-line/70">
      <div className="flex items-center justify-between px-4 pb-3 pt-5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
          <Layers className="size-3.5" strokeWidth={2} />
          Live sources
        </div>
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="size-1.5 rounded-full bg-sage-500" />
          {connected} connected
        </span>
      </div>
      <div className="no-scrollbar flex-1 overflow-y-auto px-3 pb-8">
        <div className="flex flex-col gap-3">
          {feeds.map((f) => (
            <SourcePanel key={f.platform} feed={f} />
          ))}
        </div>
      </div>
    </aside>
  )
}

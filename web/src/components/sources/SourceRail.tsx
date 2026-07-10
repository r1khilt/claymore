import { Layers, PanelRightClose } from 'lucide-react'
import { isLive } from '@/lib/api'
import { connectors, feeds } from '@/lib/mockData'
import { SourcePanel } from './SourcePanel'

export function SourceRail({ onCollapse }: { onCollapse: () => void }) {
  const connected = connectors.filter((c) => c.connected).length
  return (
    <aside className="flex h-full w-[352px] shrink-0 flex-col border-l border-line/70">
      <div className="flex items-center gap-2 px-4 pb-3 pt-5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
          <Layers className="size-3.5" strokeWidth={2} />
          {isLive ? 'Source preview' : 'Demo sources'}
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="size-1.5 rounded-full bg-sage-500" />
          {connected} connected
        </span>
        <button
          onClick={onCollapse}
          title="Hide sources"
          className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-black/5 hover:text-muted"
        >
          <PanelRightClose className="size-4" strokeWidth={1.75} />
        </button>
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

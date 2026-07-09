import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { View } from '@/lib/types'
import { isLive } from '@/lib/api'
import { defaultProtocol, type Protocol } from '@/lib/protocol'
import { Background } from '@/components/Background'
import { Sidebar } from '@/components/Sidebar'
import { AskView } from '@/components/ask/AskView'
import { SourceRail } from '@/components/sources/SourceRail'
import { ProtocolWorkspace } from '@/components/bench/ProtocolWorkspace'
import { MemoryView } from '@/components/views/MemoryView'
import { ApprovalsView } from '@/components/views/ApprovalsView'
import { ConnectorsView } from '@/components/views/ConnectorsView'
import { ProactiveView } from '@/components/views/ProactiveView'

export default function App() {
  const [view, setView] = useState<View>('ask')
  const [protocol, setProtocol] = useState<Protocol>(defaultProtocol())
  const showRail = view === 'ask'

  function openProtocol(p: Protocol) {
    setProtocol(p)
    setView('bench')
  }

  function renderView() {
    switch (view) {
      case 'ask':
        return <AskView onOpenProtocol={openProtocol} />
      case 'bench':
        return <ProtocolWorkspace protocol={protocol} />
      case 'memory':
        return <MemoryView />
      case 'approvals':
        return <ApprovalsView />
      case 'connectors':
        return <ConnectorsView />
      case 'proactive':
        return <ProactiveView />
    }
  }

  return (
    <div className="relative flex h-screen w-full overflow-hidden text-ink">
      <Background />
      <Sidebar view={view} onNavigate={setView} badges={{ approvals: 2, proactive: 3 }} />

      <div className="relative flex min-w-0 flex-1">
        <main className="relative min-w-0 flex-1">
          {view === 'ask' && (
            <div className="pointer-events-none absolute right-5 top-5 z-10">
              <span className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/50 px-2.5 py-1 text-[11.5px] font-medium text-muted backdrop-blur">
                <span className={`size-1.5 rounded-full ${isLive ? 'bg-sage-500' : 'bg-amber-400'}`} />
                {isLive ? 'Live · /api/ask' : 'Demo data'}
              </span>
            </div>
          )}

          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="h-full"
            >
              {renderView()}
            </motion.div>
          </AnimatePresence>
        </main>

        {showRail && <SourceRail />}
      </div>
    </div>
  )
}

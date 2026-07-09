import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { View } from '@/lib/types'
import { isLive } from '@/lib/api'
import { cn } from '@/lib/utils'
import { defaultProtocol, type Protocol } from '@/lib/protocol'
import {
  loadState,
  getChat,
  saveChat,
  newChatId,
  type LocalState,
  type Profile,
} from '@/lib/local'
import { Background } from '@/components/Background'
import { Sidebar } from '@/components/Sidebar'
import { AskView, type PersistTurn } from '@/components/ask/AskView'
import { SourceRail } from '@/components/sources/SourceRail'
import { ProtocolWorkspace } from '@/components/bench/ProtocolWorkspace'
import { MemoryView } from '@/components/views/MemoryView'
import { ApprovalsView } from '@/components/views/ApprovalsView'
import { ConnectorsView } from '@/components/views/ConnectorsView'
import { ProactiveView } from '@/components/views/ProactiveView'
import { SettingsView } from '@/components/views/SettingsView'

const DEFAULT_PROFILE: Profile = {
  name: 'Rikhil T',
  lab: 'Claymore Lab',
  email: '',
  avatarColor: '#3f7d5c',
  avatarDataUrl: null,
}

export default function App() {
  const [view, setView] = useState<View>('ask')
  const [protocol, setProtocol] = useState<Protocol>(defaultProtocol())
  const [local, setLocal] = useState<LocalState | null>(null)
  // The chat the Composer is bound to. `activeChatId` is always set so a completed turn has an id
  // to persist under; `loadedTurns` seeds the Composer when restoring a saved chat. The Composer is
  // keyed by `activeChatId`, so switching views never remounts it (an in-flight run survives nav),
  // but opening a different chat does — restoring that conversation's turns.
  const [activeChatId, setActiveChatId] = useState<string>(() => newChatId())
  const [loadedTurns, setLoadedTurns] = useState<PersistTurn[] | undefined>(undefined)
  const showRail = view === 'ask'

  const refresh = useCallback(async () => {
    setLocal(await loadState())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function openProtocol(p: Protocol) {
    setProtocol(p)
    setView('bench')
  }

  async function openChat(id: string) {
    const chat = await getChat(id)
    setLoadedTurns(chat?.turns ?? [])
    setActiveChatId(id)
    setView('ask')
  }

  function newChat() {
    setLoadedTurns(undefined)
    setActiveChatId(newChatId())
    setView('ask')
  }

  async function persistChat(turns: PersistTurn[]) {
    if (turns.length === 0) return
    // Keep the seed in sync so leaving Ask (e.g. to Settings) and returning restores this chat.
    // The key is unchanged, so this never disrupts the live turn.
    setLoadedTurns(turns)
    await saveChat({ id: activeChatId, title: '', createdAt: null, updatedAt: null, turns })
    await refresh()
  }

  const profile = local?.profile ?? DEFAULT_PROFILE

  function renderOther() {
    switch (view) {
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
      case 'settings':
        return local ? <SettingsView state={local} onChange={refresh} /> : null
      default:
        return null
    }
  }

  return (
    <div className="relative flex h-screen w-full overflow-hidden text-ink">
      <Background />
      <Sidebar
        view={view}
        onNavigate={setView}
        badges={{ approvals: 2, proactive: 3 }}
        profile={profile}
        chats={local?.chats ?? []}
        activeChatId={activeChatId}
        onOpenChat={openChat}
        onNewChat={newChat}
      />

      <div className="relative flex min-w-0 flex-1">
        <main className="relative min-w-0 flex-1">
          {view === 'ask' && (
            <div className="pointer-events-none absolute right-5 top-5 z-10">
              <span className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/50 px-2.5 py-1 text-[11.5px] font-medium text-muted backdrop-blur">
                <span className={`size-1.5 rounded-full ${isLive ? 'bg-sage-500' : 'bg-amber-400'}`} />
                {isLive ? 'Live · agent' : 'Demo data'}
              </span>
            </div>
          )}

          {/* Composer stays mounted so the conversation (and any in-flight run) survives nav.
              Keyed by the active chat so opening a different one restores its turns. */}
          <div className={cn('h-full', view !== 'ask' && 'hidden')}>
            <AskView
              key={activeChatId}
              onOpenProtocol={openProtocol}
              initialTurns={loadedTurns}
              onPersist={persistChat}
              onNewChat={newChat}
            />
          </div>

          {view !== 'ask' && (
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="h-full"
              >
                {renderOther()}
              </motion.div>
            </AnimatePresence>
          )}
        </main>

        {showRail && <SourceRail />}
      </div>
    </div>
  )
}

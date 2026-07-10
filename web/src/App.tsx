import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { PanelLeftOpen, PanelRightOpen, Plus } from 'lucide-react'
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
import { RunChatLanding } from '@/components/run/RunChatLanding'
import { RunView } from '@/components/run/RunView'
import { SourceRail } from '@/components/sources/SourceRail'
import { ProtocolWorkspace } from '@/components/bench/ProtocolWorkspace'
import { MemoryView } from '@/components/views/MemoryView'
import { ApprovalsView } from '@/components/views/ApprovalsView'
import { ConnectorsView } from '@/components/views/ConnectorsView'
import { ProactiveView } from '@/components/views/ProactiveView'

const DEFAULT_PROFILE: Profile = {
  name: 'Rikhil T',
  lab: 'Claymore Lab',
  email: '',
  avatarColor: '#3f7d5c',
  avatarDataUrl: null,
}

/** Within the Ask area, which of the two entry modes is showing. `landing` is the
 *  start screen (Run · Chat); the sidebar and source rail are identical across all
 *  three — only this middle section swaps. */
type AskMode = 'landing' | 'chat' | 'run'

/** Collapsible panel open/closed, remembered across sessions. */
function usePanel(key: string): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) !== '0'
    } catch {
      return true
    }
  })
  const set = useCallback(
    (v: boolean) => {
      setOpen(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        /* private mode — best effort */
      }
    },
    [key],
  )
  return [open, set]
}

const PANEL_SPRING = { type: 'spring', stiffness: 320, damping: 36 } as const

/** Floating round glass button that brings a collapsed panel back. */
function PanelButton({
  onClick,
  title,
  children,
  className,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      onClick={onClick}
      title={title}
      className={cn(
        'glass grid size-8 place-items-center rounded-full text-muted transition-colors hover:text-ink',
        className,
      )}
    >
      {children}
    </motion.button>
  )
}

export default function App() {
  const [view, setView] = useState<View>('ask')
  const [askMode, setAskMode] = useState<AskMode>('landing')
  // RunView mounts once the user first enters Run, then stays mounted (hidden) so an
  // in-flight autopilot survives navigation — same rule as the Composer below.
  const [hasEnteredRun, setHasEnteredRun] = useState(false)
  const [protocol, setProtocol] = useState<Protocol>(defaultProtocol())
  const [local, setLocal] = useState<LocalState | null>(null)
  // The chat the Composer is bound to. `activeChatId` is always set so a completed turn has an id
  // to persist under; `loadedTurns` seeds the Composer when restoring a saved chat. The Composer is
  // keyed by `activeChatId`, so switching views never remounts it (an in-flight run survives nav),
  // but opening a different chat does — restoring that conversation's turns.
  const [activeChatId, setActiveChatId] = useState<string>(() => newChatId())
  const [loadedTurns, setLoadedTurns] = useState<PersistTurn[] | undefined>(undefined)
  const [navOpen, setNavOpen] = usePanel('claymore.ui.nav')
  const [railOpen, setRailOpen] = usePanel('claymore.ui.rail')
  const showRail = view === 'ask'
  // A turn can finish streaming after the user has already opened another chat; this ref
  // lets that late persist know whether it may still seed `loadedTurns`.
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId

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
    setAskMode('chat')
    setView('ask')
  }

  function newChat() {
    setLoadedTurns(undefined)
    setActiveChatId(newChatId())
    setAskMode('chat')
    setView('ask')
  }

  function chooseRun() {
    setHasEnteredRun(true)
    setAskMode('run')
    setView('ask')
  }

  /** Back to the Run · Chat chooser (sidebar brand + Run's Back button). */
  function goHome() {
    setAskMode('landing')
    setView('ask')
  }

  async function persistChat(id: string, turns: PersistTurn[]) {
    if (turns.length === 0) return
    // Keep the seed in sync so leaving Ask (e.g. to Memory) and returning restores this chat —
    // but only while it's still the active one; a stale stream must not seed a newer chat.
    if (id === activeChatIdRef.current) setLoadedTurns(turns)
    await saveChat({ id, title: '', createdAt: null, updatedAt: null, turns })
    await refresh()
  }

  const profile = local?.profile ?? DEFAULT_PROFILE
  const firstName = (profile.name || '').trim().split(/\s+/)[0] || undefined

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
      default:
        return null
    }
  }

  return (
    <div className="relative flex h-screen w-full overflow-hidden text-ink">
      <Background />

      {/* left rail — collapses to nothing; a floating button brings it back */}
      <motion.div
        initial={false}
        animate={{ width: navOpen ? 220 : 0, opacity: navOpen ? 1 : 0 }}
        transition={PANEL_SPRING}
        className="relative h-full shrink-0 overflow-hidden"
      >
        <div className="h-full w-[220px]">
          <Sidebar
            view={view}
            onNavigate={setView}
            onHome={goHome}
            onCollapse={() => setNavOpen(false)}
            badges={{ approvals: 2, proactive: 3 }}
            profile={profile}
            local={local}
            onRefresh={refresh}
            chats={local?.chats ?? []}
            activeChatId={askMode === 'chat' ? activeChatId : null}
            onOpenChat={openChat}
            onNewChat={newChat}
          />
        </div>
      </motion.div>

      <div className="relative flex min-w-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <AnimatePresence>
            {!navOpen && (
              <PanelButton
                key="open-nav"
                onClick={() => setNavOpen(true)}
                title="Show sidebar"
                className="absolute left-4 top-4 z-20"
              >
                <PanelLeftOpen className="size-4" strokeWidth={1.75} />
              </PanelButton>
            )}
          </AnimatePresence>

          {view === 'ask' && (
            <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
              {askMode === 'chat' && (
                <button
                  onClick={newChat}
                  className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/50 px-3 py-1.5 text-[12.5px] font-medium text-muted backdrop-blur transition-colors hover:bg-white/75 hover:text-ink"
                >
                  <Plus className="size-3.5" strokeWidth={2} />
                  New chat
                </button>
              )}
              <span className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/50 px-2.5 py-1.5 text-[11.5px] font-medium text-muted backdrop-blur">
                <span className={`size-1.5 rounded-full ${isLive ? 'bg-sage-500' : 'bg-amber-400'}`} />
                {isLive ? 'Live · agent' : 'Demo data'}
              </span>
              <AnimatePresence>
                {!railOpen && (
                  <PanelButton key="open-rail" onClick={() => setRailOpen(true)} title="Show sources">
                    <PanelRightOpen className="size-4" strokeWidth={1.75} />
                  </PanelButton>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Ask area — stays mounted so an in-flight Chat or Run survives nav. Only this
              middle section swaps between the landing chooser, the Composer, and autopilot;
              the sidebar and source rail are identical across all three. */}
          <div className={cn('h-full', view !== 'ask' && 'hidden')}>
            <div className={cn('h-full', askMode !== 'landing' && 'hidden')}>
              <RunChatLanding onRun={chooseRun} onChat={newChat} />
            </div>

            {/* Composer, keyed by the active chat so opening a different one restores its turns. */}
            <div className={cn('h-full', askMode !== 'chat' && 'hidden')}>
              <AskView
                key={activeChatId}
                onOpenProtocol={openProtocol}
                initialTurns={loadedTurns}
                onPersist={(turns) => persistChat(activeChatId, turns)}
                userName={firstName}
              />
            </div>

            {hasEnteredRun && (
              <div className={cn('h-full', askMode !== 'run' && 'hidden')}>
                <RunView onOpenProtocol={openProtocol} onBack={goHome} />
              </div>
            )}
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

        {/* right rail — same collapse treatment as the left */}
        {showRail && (
          <motion.div
            initial={false}
            animate={{ width: railOpen ? 352 : 0, opacity: railOpen ? 1 : 0 }}
            transition={PANEL_SPRING}
            className="h-full shrink-0 overflow-hidden"
          >
            <div className="h-full w-[352px]">
              <SourceRail onCollapse={() => setRailOpen(false)} />
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}

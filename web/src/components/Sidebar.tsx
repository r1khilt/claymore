import { motion } from 'framer-motion'
import {
  Sparkles,
  FlaskConical,
  Waypoints,
  CheckCheck,
  Plug,
  Radar,
  PanelLeftClose,
  ChevronsUpDown,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import type { View } from '@/lib/types'
import type { ChatSummary, Profile } from '@/lib/local'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'

const NAV: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'ask', label: 'Ask', icon: Sparkles },
  { view: 'bench', label: 'Bench', icon: FlaskConical },
  { view: 'memory', label: 'Memory', icon: Waypoints },
  { view: 'approvals', label: 'Approvals', icon: CheckCheck },
  { view: 'connectors', label: 'Connectors', icon: Plug },
  { view: 'proactive', label: 'Proactive', icon: Radar },
]

function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <rect width="64" height="64" rx="16" fill="#3f7d5c" />
      <path d="M32 12 L37 34 L32 52 L27 34 Z" fill="#f4f2ec" fillOpacity="0.96" />
      <rect x="22" y="33" width="20" height="2.6" rx="1.3" fill="#f4f2ec" fillOpacity="0.9" />
      <circle cx="32" cy="34" r="3.4" fill="#3f7d5c" />
    </svg>
  )
}

export function Sidebar({
  view,
  onNavigate,
  badges,
  profile,
  chats,
  activeChatId,
  onOpenChat,
  onNewChat,
}: {
  view: View
  onNavigate: (v: View) => void
  badges?: Partial<Record<View, number>>
  profile: Profile
  chats: ChatSummary[]
  activeChatId: string | null
  onOpenChat: (id: string) => void
  onNewChat: () => void
}) {
  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col px-3 py-4">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-2.5 pb-5">
        <BrandMark />
        <span className="font-serif text-[22px] leading-none tracking-tight text-ink">claymore</span>
        <button
          className="ml-auto grid size-7 place-items-center rounded-lg text-faint transition-colors hover:bg-black/5 hover:text-muted"
          title="Collapse"
        >
          <PanelLeftClose className="size-[17px]" strokeWidth={1.75} />
        </button>
      </div>

      {/* nav */}
      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ view: v, label, icon: Icon }) => {
          const active = v === view
          return (
            <button
              key={v}
              onClick={() => onNavigate(v)}
              className={cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2 text-[14.5px] transition-colors',
                active ? 'text-sage-700' : 'text-muted hover:text-ink',
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 -z-10 rounded-xl bg-sage-500/12 ring-1 ring-inset ring-sage-500/15"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
              <Icon className="size-[18px]" strokeWidth={active ? 2.1 : 1.85} />
              <span className={cn(active && 'font-medium')}>{label}</span>
              {badges?.[v] ? (
                <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-sage-500/15 px-1.5 text-[11px] font-semibold text-sage-700">
                  {badges[v]}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>

      {/* recent chats — persisted locally */}
      <div className="mt-6 flex min-h-0 flex-1 flex-col px-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.13em] text-faint">Recent</span>
          <button
            onClick={onNewChat}
            title="New chat"
            className="grid size-5 place-items-center rounded-md text-faint transition-colors hover:bg-black/5 hover:text-muted"
          >
            <Plus className="size-3.5" strokeWidth={2} />
          </button>
        </div>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto text-[13.5px] text-muted">
          {chats.length === 0 ? (
            <span className="px-2 py-1 text-[12.5px] text-faint">No chats yet</span>
          ) : (
            chats.map((c) => {
              const active = view === 'ask' && c.id === activeChatId
              return (
                <button
                  key={c.id}
                  onClick={() => onOpenChat(c.id)}
                  className={cn(
                    'truncate rounded-lg px-2 py-1 text-left transition-colors hover:bg-black/5 hover:text-ink',
                    active && 'bg-black/5 text-ink',
                  )}
                  title={c.title}
                >
                  {c.title}
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* user — opens Settings */}
      <div className="mt-2">
        <button
          onClick={() => onNavigate('settings')}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-black/5',
            view === 'settings' && 'bg-black/5',
          )}
        >
          {profile.avatarDataUrl ? (
            <img src={profile.avatarDataUrl} alt="" className="size-[30px] shrink-0 rounded-full object-cover ring-1 ring-black/10" />
          ) : (
            <Avatar name={profile.name || 'You'} accent={profile.avatarColor} size={30} />
          )}
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-ink">{profile.name || 'You'}</div>
            <div className="truncate text-[12px] text-faint">{profile.lab || 'Claymore Lab'}</div>
          </div>
          <ChevronsUpDown className="ml-auto size-4 text-faint" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  )
}

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
  type LucideIcon,
} from 'lucide-react'
import type { View } from '@/lib/types'
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
}: {
  view: View
  onNavigate: (v: View) => void
  badges?: Partial<Record<View, number>>
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

      <div className="mt-6 px-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.13em] text-faint">Recent</div>
        <div className="mt-2 flex flex-col gap-1.5 text-[13.5px] text-muted">
          {['CBX2 allosteric idea', 'Assay buffer DMSO', 'Docking pipeline status'].map((t) => (
            <button
              key={t}
              className="truncate rounded-lg px-2 py-1 text-left transition-colors hover:bg-black/5 hover:text-ink"
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* user */}
      <div className="mt-auto">
        <button className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-black/5">
          <Avatar name="Rikhil T" accent="#3f7d5c" size={30} />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-ink">Rikhil T</div>
            <div className="truncate text-[12px] text-faint">Claymore Lab</div>
          </div>
          <ChevronsUpDown className="ml-auto size-4 text-faint" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  )
}

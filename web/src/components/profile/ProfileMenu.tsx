import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronsUpDown,
  Check,
  Database,
  Download,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react'
import { isLive } from '@/lib/api'
import type { LocalSettings, LocalState, Profile, ReasoningLevel } from '@/lib/local'
import {
  clearAll,
  clearErrors,
  logClientError,
  patchProfile,
  patchSettings,
  resetMetrics,
} from '@/lib/local'
import { Avatar } from '@/components/ui/Avatar'
import { cn, timeAgo } from '@/lib/utils'

type PanelId = 'usage' | 'customize' | 'keys' | 'preferences' | 'data'

const MENU: { id: PanelId; icon: LucideIcon; label: string }[] = [
  { id: 'usage', icon: Gauge, label: 'Usage' },
  { id: 'customize', icon: Palette, label: 'Customize' },
  { id: 'keys', icon: KeyRound, label: 'API keys' },
  { id: 'preferences', icon: SlidersHorizontal, label: 'Preferences' },
  { id: 'data', icon: Database, label: 'Data' },
]

const PANEL_TITLE: Record<PanelId, string> = {
  usage: 'Usage',
  customize: 'Customize',
  keys: 'API keys',
  preferences: 'Preferences',
  data: 'Data',
}

const ACCENTS = ['#3f7d5c', '#4a6fa5', '#b4623f', '#7a5ea8', '#c67f3d', '#0f766e']
const REASONING: { value: ReasoningLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: '3 steps · fastest' },
  { value: 'medium', label: 'Medium', hint: '6 steps · default' },
  { value: 'high', label: 'High', hint: '8 steps · deepest' },
]

const DEFAULT_SETTINGS: LocalSettings = {
  anthropicApiKey: '',
  voyageApiKey: '',
  reasoningLevel: 'medium',
  debug: false,
  liveMode: false,
}

const inputCls =
  'w-full rounded-xl border border-black/[0.07] bg-white/60 px-3 py-2 text-[13.5px] text-ink placeholder:text-faint focus:border-sage-500/40 focus:outline-none focus:ring-2 focus:ring-sage-500/15'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}

function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-black/[0.06] bg-white/50 px-3.5 py-2.5">
      <div>
        <div className="text-[13.5px] text-ink">{label}</div>
        {hint && <div className="text-[12px] text-faint">{hint}</div>}
      </div>
      <button
        onClick={onClick}
        role="switch"
        aria-checked={on}
        className={cn('relative h-6 w-10 shrink-0 rounded-full transition-colors', on ? 'bg-sage-500' : 'bg-black/15')}
      >
        <span className={cn('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-white/50 p-3 ring-1 ring-inset ring-black/[0.05]">
      <div className="font-serif text-[22px] leading-none text-ink">{value}</div>
      <div className="mt-1.5 text-[11.5px] text-faint">{label}</div>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** The profile notch at the bottom of the sidebar: click → a small popover with
 *  Usage · Customize · API keys · Preferences · Data, each opening a compact modal.
 *  Popover + modal render through a portal so the collapsing sidebar never clips them. */
export function ProfileMenu({
  profile,
  state,
  onRefresh,
}: {
  profile: Profile
  state: LocalState | null
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<PanelId | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [saved, setSaved] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const settings = state?.settings ?? DEFAULT_SETTINGS
  const [draftProfile, setDraftProfile] = useState<Profile>(profile)
  const [draftSettings, setDraftSettings] = useState<LocalSettings>(settings)

  function toggle() {
    if (!open) {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 8 })
    }
    setOpen((v) => !v)
  }

  function openPanel(id: PanelId) {
    setDraftProfile(profile)
    setDraftSettings(settings)
    setShowKeys(false)
    setOpen(false)
    setPanel(id)
  }

  // outside click closes the popover; Escape closes whichever layer is on top
  useEffect(() => {
    if (!open) return
    function onDown(e: PointerEvent) {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('resize', onDown as unknown as () => void)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', onDown as unknown as () => void)
    }
  }, [open])

  useEffect(() => {
    if (!open && !panel) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (panel) setPanel(null)
      else setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, panel])

  function flash() {
    setSaved(true)
    setTimeout(() => setSaved(false), 1400)
  }

  async function commitProfile(patch: Partial<Profile>) {
    setDraftProfile((p) => ({ ...p, ...patch }))
    await patchProfile(patch)
    flash()
    onRefresh()
  }

  async function commitSettings(patch: Partial<LocalSettings>) {
    setDraftSettings((s) => ({ ...s, ...patch }))
    await patchSettings(patch)
    flash()
    onRefresh()
  }

  function onAvatarPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 1_500_000) {
      logClientError('avatar image too large (max 1.5MB)', 'settings.avatar')
      onRefresh()
      return
    }
    const reader = new FileReader()
    reader.onload = () => commitProfile({ avatarDataUrl: String(reader.result) })
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const m = state?.metrics
  const toolRows = Object.entries(m?.toolCounts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  const errorCount = state?.errorLog.length ?? 0

  function renderPanel(id: PanelId): ReactNode {
    switch (id) {
      case 'customize':
        return (
          <>
            <div className="flex items-center gap-3.5">
              {draftProfile.avatarDataUrl ? (
                <img src={draftProfile.avatarDataUrl} alt="avatar" className="size-12 shrink-0 rounded-full object-cover ring-1 ring-black/10" />
              ) : (
                <Avatar name={draftProfile.name || 'You'} accent={draftProfile.avatarColor} size={48} />
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white/60 px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
                >
                  <Upload className="size-3.5" strokeWidth={2} /> Upload picture
                </button>
                {draftProfile.avatarDataUrl && (
                  <button onClick={() => commitProfile({ avatarDataUrl: null })} className="text-[12px] text-faint hover:text-clay-500">
                    Remove
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPick} />
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Display name">
                <input
                  className={inputCls}
                  value={draftProfile.name}
                  onChange={(e) => setDraftProfile({ ...draftProfile, name: e.target.value })}
                  onBlur={(e) => commitProfile({ name: e.target.value })}
                />
              </Field>
              <Field label="Lab">
                <input
                  className={inputCls}
                  value={draftProfile.lab}
                  onChange={(e) => setDraftProfile({ ...draftProfile, lab: e.target.value })}
                  onBlur={(e) => commitProfile({ lab: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <input
                  className={inputCls}
                  value={draftProfile.email}
                  placeholder="you@lab.org"
                  onChange={(e) => setDraftProfile({ ...draftProfile, email: e.target.value })}
                  onBlur={(e) => commitProfile({ email: e.target.value })}
                />
              </Field>
              <Field label="Accent">
                <div className="flex items-center gap-2 pt-1.5">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      onClick={() => commitProfile({ avatarColor: c })}
                      className={cn(
                        'size-6 rounded-full ring-2 ring-offset-2 ring-offset-transparent transition-all',
                        draftProfile.avatarColor === c ? 'ring-ink/40' : 'ring-transparent',
                      )}
                      style={{ background: c }}
                      aria-label={c}
                    />
                  ))}
                </div>
              </Field>
            </div>
          </>
        )
      case 'keys':
        return (
          <>
            <p className="text-[12.5px] leading-relaxed text-muted">
              Used only to run the live Composer. Stored in a local file, never logged, never pushed.
            </p>
            <div className="mt-3.5 grid gap-3">
              <Field label="Anthropic API key">
                <div className="relative">
                  <input
                    className={cn(inputCls, 'pr-10 font-mono')}
                    type={showKeys ? 'text' : 'password'}
                    value={draftSettings.anthropicApiKey}
                    placeholder="sk-ant-..."
                    onChange={(e) => setDraftSettings({ ...draftSettings, anthropicApiKey: e.target.value })}
                    onBlur={(e) => commitSettings({ anthropicApiKey: e.target.value })}
                  />
                  <button onClick={() => setShowKeys((s) => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-muted">
                    {showKeys ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>
              <Field label="Voyage API key (embeddings)">
                <input
                  className={cn(inputCls, 'font-mono')}
                  type={showKeys ? 'text' : 'password'}
                  value={draftSettings.voyageApiKey}
                  placeholder="pa-..."
                  onChange={(e) => setDraftSettings({ ...draftSettings, voyageApiKey: e.target.value })}
                  onBlur={(e) => commitSettings({ voyageApiKey: e.target.value })}
                />
              </Field>
            </div>
          </>
        )
      case 'preferences':
        return (
          <>
            <div className="mb-1 text-[12px] font-medium text-muted">Reasoning</div>
            <div className="grid grid-cols-3 gap-2">
              {REASONING.map((r) => (
                <button
                  key={r.value}
                  onClick={() => commitSettings({ reasoningLevel: r.value })}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left transition-all',
                    draftSettings.reasoningLevel === r.value
                      ? 'border-sage-500/40 bg-sage-500/10 ring-2 ring-sage-500/15'
                      : 'border-black/[0.07] bg-white/50 hover:bg-white/70',
                  )}
                >
                  <div className="text-[13.5px] font-medium text-ink">{r.label}</div>
                  <div className="mt-0.5 text-[11.5px] text-faint">{r.hint}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-2">
              <Toggle
                on={draftSettings.liveMode}
                onClick={() => commitSettings({ liveMode: !draftSettings.liveMode })}
                label="Live mode"
                hint="Prefer the real agent loop when the backend is reachable."
              />
              <Toggle
                on={draftSettings.debug}
                onClick={() => commitSettings({ debug: !draftSettings.debug })}
                label="Debug"
                hint="Verbose agent events + error surfacing."
              />
            </div>
          </>
        )
      case 'usage':
        return (
          <>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {m?.lastRunAt
                ? `Recorded from real agent runs · last run ${timeAgo(m.lastRunAt)} ago.`
                : 'Recorded from real agent runs — run the live Composer to populate.'}
            </p>
            <div className="mt-3.5 grid grid-cols-2 gap-2.5">
              <Stat value={fmt(m?.totalRuns ?? 0)} label="agent runs" />
              <Stat value={fmt(m?.toolCalls ?? 0)} label="tool calls" />
              <Stat value={fmt(m?.inputTokens ?? 0)} label="input tokens" />
              <Stat value={fmt(m?.outputTokens ?? 0)} label="output tokens" />
            </div>
            {toolRows.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Top tools</div>
                <div className="grid gap-1.5">
                  {toolRows.map(([name, n]) => (
                    <div key={name} className="flex items-center justify-between rounded-lg bg-white/50 px-3 py-1.5 text-[12.5px]">
                      <span className="font-mono text-ink">{name}</span>
                      <span className="text-muted">{fmt(n)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button
              onClick={async () => {
                await resetMetrics()
                onRefresh()
              }}
              className="mt-4 flex items-center gap-1.5 text-[12.5px] text-faint hover:text-clay-500"
            >
              <RotateCcw className="size-3.5" strokeWidth={2} /> Reset metrics
            </button>
          </>
        )
      case 'data':
        return (
          <>
            <div className="rounded-xl bg-white/50 px-3.5 py-2.5 text-[12.5px]">
              <span className="text-muted">Everything lives in </span>
              <span className="font-mono text-ink">{state?.meta?.path ?? '~/.claymore/local.json'}</span>
              <span className="text-muted"> — on this machine only.</span>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-xl border border-black/[0.06] bg-white/50 px-3.5 py-2.5 text-[13px]">
              <span className="text-ink">
                {errorCount === 0 ? 'No errors logged' : `${errorCount} error${errorCount === 1 ? '' : 's'} logged`}
              </span>
              {errorCount > 0 && (
                <button
                  onClick={async () => {
                    await clearErrors()
                    onRefresh()
                  }}
                  className="text-[12.5px] text-faint hover:text-clay-500"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                disabled={!state}
                onClick={() => {
                  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = 'claymore-local.json'
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                className="flex items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white/60 px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                <Download className="size-3.5" strokeWidth={2} /> Export JSON
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Clear all local chats, metrics and errors on this machine? Profile and keys are kept.')) return
                  await clearAll()
                  onRefresh()
                }}
                className="flex items-center gap-1.5 rounded-lg border border-clay-500/20 bg-clay-500/[0.06] px-3 py-1.5 text-[12.5px] text-clay-500 transition-colors hover:bg-clay-500/10"
              >
                <Trash2 className="size-3.5" strokeWidth={2} /> Clear local data
              </button>
            </div>
          </>
        )
    }
  }

  const PanelIcon = MENU.find((i) => i.id === panel)?.icon

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-black/5',
          open && 'bg-black/5',
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

      {createPortal(
        <AnimatePresence>
          {open && anchor && (
            <motion.div
              ref={popRef}
              role="menu"
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              style={{ position: 'fixed', left: anchor.left, bottom: anchor.bottom, transformOrigin: 'bottom left' }}
              className="glass-raised z-40 w-[236px] rounded-2xl p-1.5"
            >
              <div className="flex items-center gap-2.5 px-2.5 pb-2 pt-1.5">
                {profile.avatarDataUrl ? (
                  <img src={profile.avatarDataUrl} alt="" className="size-8 shrink-0 rounded-full object-cover ring-1 ring-black/10" />
                ) : (
                  <Avatar name={profile.name || 'You'} accent={profile.avatarColor} size={32} />
                )}
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{profile.name || 'You'}</div>
                  <div className="truncate text-[11.5px] text-faint">{profile.lab || 'Claymore Lab'}</div>
                </div>
              </div>
              <div className="mx-1 border-t border-line/70" />
              <div className="py-1">
                {MENU.map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    role="menuitem"
                    onClick={() => openPanel(id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] text-ink/85 transition-colors hover:bg-black/[0.05]"
                  >
                    <Icon className="size-4 text-muted" strokeWidth={1.85} />
                    {label}
                  </button>
                ))}
              </div>
              <div className="mx-1 border-t border-line/70" />
              <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11.5px] text-faint">
                <span className={cn('size-1.5 rounded-full', isLive ? 'bg-sage-500' : 'bg-amber-400')} />
                {isLive ? 'Live · agent connected' : 'Demo data'}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {createPortal(
        <AnimatePresence>
          {panel && (
            <div className="fixed inset-0 z-50 grid place-items-center p-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setPanel(null)}
                className="absolute inset-0 bg-ink/10 backdrop-blur-[3px]"
              />
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label={PANEL_TITLE[panel]}
                initial={{ opacity: 0, scale: 0.96, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 6 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="glass-raised relative w-full max-w-[440px] rounded-3xl p-5"
              >
                <div className="mb-4 flex items-center gap-2.5">
                  {PanelIcon && (
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sage-500/12 text-sage-700">
                      <PanelIcon className="size-4" strokeWidth={2} />
                    </span>
                  )}
                  <h2 className="text-[15px] font-medium text-ink">{PANEL_TITLE[panel]}</h2>
                  {saved && (
                    <span className="flex items-center gap-1 rounded-full bg-sage-500/12 px-2 py-0.5 text-[11.5px] font-medium text-sage-700">
                      <Check className="size-3" strokeWidth={2.5} /> Saved
                    </span>
                  )}
                  <button
                    onClick={() => setPanel(null)}
                    className="ml-auto grid size-7 place-items-center rounded-lg text-faint transition-colors hover:bg-black/5 hover:text-muted"
                    title="Close"
                  >
                    <X className="size-4" strokeWidth={2} />
                  </button>
                </div>
                {renderPanel(panel)}
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

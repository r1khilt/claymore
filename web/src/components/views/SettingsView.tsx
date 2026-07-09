import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import {
  User as UserIcon,
  KeyRound,
  Gauge,
  Bug,
  Database,
  Eye,
  EyeOff,
  Upload,
  Trash2,
  RotateCcw,
  Check,
  type LucideIcon,
} from 'lucide-react'
import type { LocalState, LocalSettings, Profile, ReasoningLevel } from '@/lib/local'
import {
  patchProfile,
  patchSettings,
  clearErrors,
  resetMetrics,
  clearAll,
  logClientError,
} from '@/lib/local'
import { Avatar } from '@/components/ui/Avatar'
import { ViewShell } from './ViewShell'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/utils'

const ACCENTS = ['#3f7d5c', '#4a6fa5', '#b4623f', '#7a5ea8', '#c67f3d', '#0f766e']
const REASONING: { value: ReasoningLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: '3 steps · 1k tokens · fastest' },
  { value: 'medium', label: 'Medium', hint: '6 steps · 2k tokens · default' },
  { value: 'high', label: 'High', hint: '8 steps · 3k tokens · deepest' },
]

function Section({ icon: Icon, title, desc, children }: { icon: LucideIcon; title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="glass mb-4 rounded-2xl p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sage-500/12 text-sage-700">
          <Icon className="size-4" strokeWidth={2} />
        </span>
        <div>
          <h2 className="text-[15px] font-medium text-ink">{title}</h2>
          {desc && <p className="mt-0.5 text-[12.5px] text-muted">{desc}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-xl border border-black/[0.07] bg-white/60 px-3 py-2 text-[13.5px] text-ink placeholder:text-faint focus:border-sage-500/40 focus:outline-none focus:ring-2 focus:ring-sage-500/15'

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-white/50 p-3 ring-1 ring-inset ring-black/[0.05]">
      <div className="font-serif text-[24px] leading-none text-ink">{value}</div>
      <div className="mt-1.5 text-[11.5px] text-faint">{label}</div>
    </div>
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

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export function SettingsView({ state, onChange }: { state: LocalState; onChange: () => void }) {
  const [profile, setProfile] = useState<Profile>(state.profile)
  const [settings, setSettings] = useState<LocalSettings>(state.settings)
  const [showKeys, setShowKeys] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function flash() {
    setSavedAt('saved')
    setTimeout(() => setSavedAt(null), 1400)
  }

  async function commitProfile(patch: Partial<Profile>) {
    const next = { ...profile, ...patch }
    setProfile(next)
    await patchProfile(patch)
    flash()
    onChange()
  }

  async function commitSettings(patch: Partial<LocalSettings>) {
    const next = { ...settings, ...patch }
    setSettings(next)
    await patchSettings(patch)
    flash()
    onChange()
  }

  function onAvatarPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 1_500_000) {
      logClientError('avatar image too large (max 1.5MB)', 'settings.avatar')
      onChange()
      return
    }
    const reader = new FileReader()
    reader.onload = () => commitProfile({ avatarDataUrl: String(reader.result) })
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const m = state.metrics
  const toolRows = Object.entries(m.toolCounts).sort((a, b) => b[1] - a[1])

  return (
    <ViewShell
      title="Settings"
      subtitle="Everything here lives only on this machine — your profile, keys, chats and metrics are saved to a local file that never leaves your folder."
      action={
        savedAt ? (
          <span className="flex items-center gap-1.5 rounded-full bg-sage-500/12 px-3 py-1.5 text-[12.5px] font-medium text-sage-700">
            <Check className="size-3.5" strokeWidth={2.5} /> Saved
          </span>
        ) : null
      }
    >
      {/* Profile */}
      <Section icon={UserIcon} title="Profile" desc="How you appear in the sidebar.">
        <div className="flex items-center gap-4">
          {profile.avatarDataUrl ? (
            <img src={profile.avatarDataUrl} alt="avatar" className="size-14 shrink-0 rounded-full object-cover ring-1 ring-black/10" />
          ) : (
            <Avatar name={profile.name || 'You'} accent={profile.avatarColor} size={56} />
          )}
          <div className="flex flex-col gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white/60 px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
            >
              <Upload className="size-3.5" strokeWidth={2} /> Upload picture
            </button>
            {profile.avatarDataUrl && (
              <button onClick={() => commitProfile({ avatarDataUrl: null })} className="text-left text-[12px] text-faint hover:text-clay-500">
                Remove picture
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPick} />
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Display name">
            <input className={inputCls} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} onBlur={(e) => commitProfile({ name: e.target.value })} />
          </Field>
          <Field label="Lab">
            <input className={inputCls} value={profile.lab} onChange={(e) => setProfile({ ...profile, lab: e.target.value })} onBlur={(e) => commitProfile({ lab: e.target.value })} />
          </Field>
          <Field label="Email">
            <input className={inputCls} value={profile.email} placeholder="you@lab.org" onChange={(e) => setProfile({ ...profile, email: e.target.value })} onBlur={(e) => commitProfile({ email: e.target.value })} />
          </Field>
          <Field label="Accent">
            <div className="flex items-center gap-2 pt-1.5">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  onClick={() => commitProfile({ avatarColor: c })}
                  className={cn('size-6 rounded-full ring-2 ring-offset-2 ring-offset-transparent transition-all', profile.avatarColor === c ? 'ring-ink/40' : 'ring-transparent')}
                  style={{ background: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </Field>
        </div>
      </Section>

      {/* API keys + model behavior */}
      <Section icon={KeyRound} title="API keys" desc="Used only to run the live Composer. Stored locally, never logged, never pushed.">
        <div className="grid gap-3">
          <Field label="Anthropic API key">
            <div className="relative">
              <input
                className={cn(inputCls, 'pr-10 font-mono')}
                type={showKeys ? 'text' : 'password'}
                value={settings.anthropicApiKey}
                placeholder="sk-ant-..."
                onChange={(e) => setSettings({ ...settings, anthropicApiKey: e.target.value })}
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
              value={settings.voyageApiKey}
              placeholder="pa-..."
              onChange={(e) => setSettings({ ...settings, voyageApiKey: e.target.value })}
              onBlur={(e) => commitSettings({ voyageApiKey: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      <Section icon={Gauge} title="Reasoning & mode" desc="How hard the agent thinks, and whether the Composer hits the live backend.">
        <div className="mb-3 grid grid-cols-3 gap-2">
          {REASONING.map((r) => (
            <button
              key={r.value}
              onClick={() => commitSettings({ reasoningLevel: r.value })}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-left transition-all',
                settings.reasoningLevel === r.value ? 'border-sage-500/40 bg-sage-500/10 ring-2 ring-sage-500/15' : 'border-black/[0.07] bg-white/50 hover:bg-white/70',
              )}
            >
              <div className="text-[13.5px] font-medium text-ink">{r.label}</div>
              <div className="mt-0.5 text-[11.5px] text-faint">{r.hint}</div>
            </button>
          ))}
        </div>
        <div className="grid gap-2">
          <Toggle on={settings.liveMode} onClick={() => commitSettings({ liveMode: !settings.liveMode })} label="Live mode" hint="Prefer the real /api/agent loop when the backend is reachable." />
          <Toggle on={settings.debug} onClick={() => commitSettings({ debug: !settings.debug })} label="Debug" hint="Show raw agent events + verbose error surfacing in the Composer." />
        </div>
      </Section>

      {/* Usage / metrics */}
      <Section icon={Gauge} title="Usage & metrics" desc={m.lastRunAt ? `Last run ${timeAgo(m.lastRunAt)} ago · recorded from real agent runs.` : 'Recorded from real agent runs — run the live Composer to populate.'}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat value={fmt(m.totalRuns)} label="agent runs" />
          <Stat value={fmt(m.toolCalls)} label="tool calls" />
          <Stat value={fmt(m.inputTokens)} label="input tokens" />
          <Stat value={fmt(m.outputTokens)} label="output tokens" />
        </div>
        {toolRows.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">By tool</div>
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
          onClick={async () => { await resetMetrics(); onChange() }}
          className="mt-4 flex items-center gap-1.5 text-[12.5px] text-faint hover:text-clay-500"
        >
          <RotateCcw className="size-3.5" strokeWidth={2} /> Reset metrics
        </button>
      </Section>

      {/* Error log / debug */}
      <Section icon={Bug} title="Error log" desc={`${state.errorLog.length} recent error${state.errorLog.length === 1 ? '' : 's'} · ${fmt(m.totalErrors)} total.`}>
        {state.errorLog.length === 0 ? (
          <div className="rounded-xl bg-white/50 px-3.5 py-3 text-[13px] text-faint">No errors logged. Agent + client failures land here.</div>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-xl bg-ink/[0.03] p-1">
            {[...state.errorLog].reverse().map((err) => (
              <div key={err.id} className="border-b border-black/[0.05] px-2.5 py-2 last:border-0">
                <div className="flex items-center gap-2 text-[11px] text-faint">
                  <span className="rounded bg-clay-500/12 px-1.5 py-0.5 font-medium text-clay-500">{err.level}</span>
                  <span>{err.context || 'web'}</span>
                  <span className="ml-auto">{timeAgo(err.ts)} ago</span>
                </div>
                <div className="mt-1 font-mono text-[12px] leading-snug text-ink/80">{err.message}</div>
              </div>
            ))}
          </div>
        )}
        {state.errorLog.length > 0 && (
          <button onClick={async () => { await clearErrors(); onChange() }} className="mt-3 flex items-center gap-1.5 text-[12.5px] text-faint hover:text-clay-500">
            <Trash2 className="size-3.5" strokeWidth={2} /> Clear log
          </button>
        )}
      </Section>

      {/* Data */}
      <Section icon={Database} title="Data" desc="Where your local data lives — and how to wipe it.">
        <div className="rounded-xl bg-white/50 px-3.5 py-2.5 text-[12.5px]">
          <span className="text-muted">Saved to </span>
          <span className="font-mono text-ink">{state.meta?.path ?? '~/.claymore/local.json'}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = 'claymore-local.json'
              a.click()
              URL.revokeObjectURL(url)
            }}
            className="rounded-lg border border-black/[0.07] bg-white/60 px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
          >
            Export JSON
          </button>
          <button
            onClick={async () => {
              if (!confirm('Clear all local chats, metrics and errors on this machine? Profile and keys are kept.')) return
              await clearAll()
              onChange()
            }}
            className="flex items-center gap-1.5 rounded-lg border border-clay-500/20 bg-clay-500/[0.06] px-3 py-1.5 text-[12.5px] text-clay-500 transition-colors hover:bg-clay-500/10"
          >
            <Trash2 className="size-3.5" strokeWidth={2} /> Clear local data
          </button>
        </div>
      </Section>
    </ViewShell>
  )
}

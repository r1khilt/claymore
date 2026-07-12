import { useMemo, useState } from 'react'
import { Search, Waypoints } from 'lucide-react'
import type { Entity } from '@/lib/types'
import { entities } from '@/lib/mockData'
import { ViewShell } from './ViewShell'
import { timeAgo } from '@/lib/utils'

// All on the warm design-system palette — no off-brand blue/purple accents.
const KIND_COLOR: Record<Entity['kind'], string> = {
  Protein: '#3f7d5c',
  Assay: '#6ba079',
  Hypothesis: '#b4623f',
  Protocol: '#2a543d',
  Experiment: '#c67f3d',
  Person: '#0f766e',
  Dataset: '#6f7268',
}

function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="glass rounded-2xl px-5 py-4" title={hint}>
      <div className="font-serif text-[30px] leading-none text-ink">{value}</div>
      <div className={`mt-1.5 text-[12.5px] text-muted ${hint ? 'cursor-help decoration-dotted underline-offset-2 hover:underline' : ''}`}>
        {label}
      </div>
    </div>
  )
}

function EntityRow({ e }: { e: Entity }) {
  const color = KIND_COLOR[e.kind]
  return (
    <button className="glass group flex items-center gap-3 rounded-xl p-3 text-left transition-all hover:-translate-y-0.5">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg text-[12px] font-semibold"
        style={{
          background: `color-mix(in oklab, ${color} 16%, white)`,
          color: `color-mix(in oklab, ${color} 78%, black)`,
        }}
      >
        {e.name.slice(0, 2)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{e.name}</div>
        <div className="text-[12px] text-faint">
          <span style={{ color }}>{e.kind}</span> · {e.mentions} mentions
        </div>
      </div>
      <span className="text-[12px] text-faint">{timeAgo(e.lastTouched)} ago</span>
    </button>
  )
}

export function MemoryView() {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entities
    return entities.filter((e) => e.name.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q))
  }, [query])

  return (
    <ViewShell
      title="Memory"
      subtitle="A temporal knowledge graph of everything the lab has said, written and run — every fact carries its source."
    >
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat
          value="3,180"
          label="episodes ingested"
          hint="An episode is one ingested unit of lab memory — a Slack message, an email, a commit, a meeting transcript — each kept with its source."
        />
        <Stat value="214" label="entities" hint="Proteins, assays, people, protocols and other things the graph tracks across sources." />
        <Stat value="5,940" label="attributed facts" hint="Individual claims extracted from episodes, each carrying who said it and when." />
      </div>

      <div className="glass mb-5 flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 transition-shadow focus-within:ring-2 focus-within:ring-sage-500/40">
        <Search className="size-4 text-faint" strokeWidth={1.85} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search entities"
          placeholder="Search entities — proteins, assays, hypotheses…"
          className="w-full bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
        />
      </div>

      <div className="mb-3 flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
        <Waypoints className="size-3.5" strokeWidth={2} />
        {query.trim() ? `${shown.length} match${shown.length === 1 ? '' : 'es'}` : 'Top entities'}
      </div>
      {shown.length === 0 ? (
        <div className="glass rounded-xl px-4 py-6 text-center text-[13px] text-muted">
          No entities match “{query.trim()}”.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {shown.map((e) => (
            <EntityRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </ViewShell>
  )
}

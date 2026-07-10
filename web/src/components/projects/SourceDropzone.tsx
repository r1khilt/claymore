/**
 * SourceDropzone — the corpus + attribution + sufficiency gate + "Create Graph".
 *
 * Each source shows who added it: a human contributor (avatar + name) or Exa's
 * auto-sourcing (amber "auto-sourced" ring) — visibly distinct, never conflated
 * (CLAUDE.md §2.1, honest attribution). Below 6 validated sources, the gate warns
 * that Exa will source the difference before the graph is built.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { FileText, Plus, Sparkles, ShieldAlert, Check, Play } from 'lucide-react'
import type { PaperSource } from '@/lib/projectTypes'
import type { Person } from '@/lib/types'
import { Avatar } from '@/components/ui/Avatar'
import { sufficiencyGate } from '@/lib/exaAugment'

function AddedBy({ source }: { source: PaperSource }) {
  if (source.addedBy.kind === 'exa') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-amber-400/18 px-2 py-0.5 text-[11px] font-medium text-amber-500 ring-1 ring-inset ring-amber-400/30">
        <Sparkles className="size-3" strokeWidth={2.25} />
        auto-sourced
      </span>
    )
  }
  const p = source.addedBy.person
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
      <Avatar name={p.name} accent={p.accent} size={18} photo={p.avatar} />
      {p.name.split(' ')[0]}
    </span>
  )
}

export function PaperCard({ source }: { source: PaperSource }) {
  const exa = source.addedBy.kind === 'exa'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass rounded-xl p-3 ${exa ? 'ring-1 ring-inset ring-amber-400/30' : ''}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${
            exa ? 'bg-amber-400/18 text-amber-500' : 'bg-ink/[0.06] text-muted'
          }`}
        >
          <FileText className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-snug text-ink">{source.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
            <span className="text-ink/60">{source.paperAuthors}</span>
            {source.venue && <span>· {source.venue}</span>}
            {source.year && <span>· {source.year}</span>}
            {source.doi && <span className="font-mono text-[10.5px]">· {source.doi}</span>}
          </div>
        </div>
        <AddedBy source={source} />
      </div>
    </motion.div>
  )
}

export function SourceDropzone({
  sources,
  createdBy,
  onAdd,
  onCreate,
  building,
}: {
  sources: PaperSource[]
  createdBy: Person
  onAdd: (p: PaperSource) => void
  onCreate: () => void
  building: boolean
}) {
  const [title, setTitle] = useState('')
  const gate = sufficiencyGate(sources)

  function add() {
    const t = title.trim()
    if (!t) return
    onAdd({
      id: `human-${Date.now().toString(36)}`,
      title: t,
      paperAuthors: 'Added manually',
      addedBy: { kind: 'human', person: createdBy },
      validated: true,
    })
    setTitle('')
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-ink text-white">
          <FileText className="size-[17px]" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Corpus</div>
          <div className="text-[12px] text-muted">{sources.length} papers · each attributed to who added it</div>
        </div>
        <span
          className={`ml-auto flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            gate.ok ? 'bg-sage-500/14 text-sage-700' : 'bg-amber-400/18 text-amber-500'
          }`}
        >
          {gate.ok ? (
            <>
              <Check className="size-3" strokeWidth={2.5} /> sufficient
            </>
          ) : (
            <>
              <ShieldAlert className="size-3" strokeWidth={2.25} /> {gate.have}/{gate.floor} · Exa will add {gate.need}
            </>
          )}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {sources.map((s) => (
          <PaperCard key={s.id} source={s} />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add a paper — title or DOI"
          className="min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-white/55 px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-sage-500/40 focus:outline-none"
        />
        <button
          onClick={add}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-black/[0.06] bg-white/50 px-3 py-2 text-[13px] text-muted transition-colors hover:bg-white/80 hover:text-ink"
        >
          <Plus className="size-3.5" strokeWidth={2} />
          Add
        </button>
      </div>

      <button
        onClick={onCreate}
        disabled={building || sources.length === 0}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-sage-500 px-4 py-2.5 text-[14px] font-medium text-white shadow-sm transition-colors hover:bg-sage-600 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Play className="size-4" strokeWidth={2.5} />
        {building ? 'Building…' : 'Create Graph'}
      </button>
    </motion.section>
  )
}

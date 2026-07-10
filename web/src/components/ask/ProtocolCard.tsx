import { motion } from 'framer-motion'
import { FlaskConical, ArrowRight, Layers } from 'lucide-react'
import { primaryPipette, type Protocol } from '@/lib/protocol'
import { Deck2D } from '@/components/bench/Deck2D'
import { cn } from '@/lib/utils'

export function ProtocolCard({ protocol, onOpen }: { protocol: Protocol; onOpen: () => void }) {
  const general = protocol.mode === 'general'
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="glass-raised overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span
          className={cn(
            'grid size-7 place-items-center rounded-lg',
            general ? 'bg-amber-400/16 text-amber-500' : 'bg-sage-500/14 text-sage-700',
          )}
        >
          <FlaskConical className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{protocol.name}</div>
          <div className="truncate text-[12px] text-muted">
            {protocol.platformLabel} · {primaryPipette(protocol).display} · {protocol.steps.length} steps
          </div>
        </div>
        <span
          className={cn(
            'ml-auto flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium',
            general ? 'bg-amber-400/12 text-amber-500' : 'bg-sage-500/12 text-sage-700',
          )}
        >
          <span className={cn('size-1.5 rounded-full', general ? 'bg-amber-400' : 'bg-sage-500')} />
          {general ? 'off-deck' : 'dry-run'}
        </span>
      </div>

      {/* mini deck preview */}
      <div className="mx-4 mt-3 rounded-xl bg-white/45 p-3 ring-1 ring-inset ring-black/[0.05]">
        <div className="mx-auto h-[176px]">
          <Deck2D protocol={protocol} preview />
        </div>
      </div>

      {protocol.groundedNote && (
        <p className="px-4 pt-3 text-[12.5px] italic text-sage-700/80">{protocol.groundedNote}</p>
      )}
      {protocol.fallbackNote && <p className="px-4 pt-3 text-[12.5px] text-amber-500/90">{protocol.fallbackNote}</p>}

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-3">
        <button
          onClick={onOpen}
          className="flex items-center gap-1.5 rounded-lg bg-sage-500 px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-sage-600"
        >
          Open in Bench
          <ArrowRight className="size-4" strokeWidth={2.25} />
        </button>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-faint">
          <Layers className="size-3.5" strokeWidth={2} />
          {protocol.deck.labware.length} labware
        </span>
      </div>
    </motion.div>
  )
}

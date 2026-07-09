import { motion } from 'framer-motion'
import { Clock, BookOpen, SearchX } from 'lucide-react'
import type { Reply } from '@/lib/types'
import { CitationCard } from './CitationCard'
import { PendingActionCard } from './PendingActionCard'

export function AnswerView({ reply }: { reply: Reply }) {
  const grounded = reply.citations.length > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-4"
    >
      {reply.scopeLabel && grounded && (
        <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Clock className="size-3.5" strokeWidth={1.85} />
          <span>
            Answered from <span className="font-medium text-ink">{reply.scopeLabel}</span>
          </span>
        </div>
      )}

      {grounded ? (
        <p className="text-[16.5px] leading-[1.72] text-ink/90">{reply.text}</p>
      ) : (
        <div className="glass flex items-start gap-3 rounded-2xl p-4">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-black/[0.05] text-muted">
            <SearchX className="size-[18px]" strokeWidth={1.85} />
          </span>
          <p className="text-[15px] leading-relaxed text-ink/80">{reply.text}</p>
        </div>
      )}

      {grounded && (
        <div className="mt-1">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.1em] text-faint">
            <BookOpen className="size-3.5" strokeWidth={2} />
            {reply.citations.length} {reply.citations.length === 1 ? 'source' : 'sources'}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {reply.citations.map((c, i) => (
              <CitationCard key={`${c.sourceId}-${i}`} citation={c} index={i + 1} />
            ))}
          </div>
        </div>
      )}

      {reply.pendingAction && (
        <div className="mt-1">
          <PendingActionCard action={reply.pendingAction} />
        </div>
      )}
    </motion.div>
  )
}

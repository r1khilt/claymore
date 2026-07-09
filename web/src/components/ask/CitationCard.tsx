import { ArrowUpRight } from 'lucide-react'
import type { Citation } from '@/lib/types'
import { PLATFORM, PlatformIcon } from '@/lib/sources'
import { shortDate } from '@/lib/utils'

export function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const meta = PLATFORM[citation.sourcePlatform]
  return (
    <button className="glass group flex w-full items-start gap-3 rounded-xl p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-[0_14px_40px_-16px_rgba(28,29,24,0.28)]">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-sage-500/14 text-[11px] font-semibold text-sage-700">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <PlatformIcon platform={citation.sourcePlatform} size={16} />
          <span className="font-medium text-ink">{citation.author}</span>
          <span className="text-faint">·</span>
          <span className="truncate">{citation.sourceLabel || meta.label}</span>
          <span className="text-faint">·</span>
          <span className="shrink-0 whitespace-nowrap">{shortDate(citation.timestamp)}</span>
          <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        {citation.quote && (
          <p className="mt-1.5 line-clamp-2 text-[13.5px] leading-snug text-ink/70">
            “{citation.quote}”
          </p>
        )}
      </div>
    </button>
  )
}

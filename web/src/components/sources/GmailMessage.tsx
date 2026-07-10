import { Star, CornerUpLeft, CornerUpRight, MoreVertical, ChevronDown, X } from 'lucide-react'
import type { SourceFeed } from '@/lib/types'
import { Avatar } from '@/components/ui/Avatar'
import { photoForAuthor } from '@/lib/mockData'
import { clockTime, shortDate } from '@/lib/utils'
import { MemoryChip } from './MemoryChip'

/**
 * The open-email reading pane, recreated from the Gmail web UI: a subject line
 * with its label chip, the sender identity row (avatar, name, address,
 * Unsubscribe, timestamp + star/reply/overflow), the "to me" collapser, the
 * body, Gmail's blue smart-reply pills, and the Reply / Forward buttons.
 *
 * Contextual smart replies are Gmail-generated chrome (not lab memory), so they
 * live here rather than in the source data.
 */
const SMART_REPLIES = ['Sounds great — thank you!', 'Yes, let’s co-author.', 'Will confirm the docking.']

function IconButton({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid size-6 place-items-center rounded-full text-gm-label transition-colors hover:bg-black/[0.06]">
      {children}
    </span>
  )
}

export function GmailMessage({ feed }: { feed: SourceFeed }) {
  const m = feed.messages[0]
  if (!m) return null
  const subject = feed.subtitle ?? feed.title

  return (
    <div className="font-gm text-gm-text">
      {/* subject + label chip */}
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 truncate text-[16px] font-normal leading-tight">{subject}</h3>
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-gm-chip px-1.5 py-0.5 text-[11px] text-gm-label">
          Inbox
          <X className="size-2.5" strokeWidth={2} />
        </span>
      </div>

      {/* sender identity row */}
      <div className="mt-3 flex gap-2.5">
        <Avatar name={m.author} accent={m.accent} size={34} photo={photoForAuthor(m.author)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1">
                <span className="shrink-0 text-[13px] font-semibold">{m.author}</span>
                {m.handle && (
                  <span className="truncate text-[12px] text-gm-label">&lt;{m.handle}&gt;</span>
                )}
              </div>
              {m.handle && (
                <a className="text-[12px] text-gm-label underline decoration-gm-line underline-offset-2">
                  Unsubscribe
                </a>
              )}
            </div>
            <span className="shrink-0 text-[11.5px] text-gm-label">
              {shortDate(m.timestamp)}, {clockTime(m.timestamp)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="flex items-center gap-0.5 text-[12px] text-gm-label">
              to me
              <ChevronDown className="size-3" strokeWidth={2} />
            </span>
            <div className="flex items-center gap-0.5">
              <IconButton>
                <Star className="size-3.5" strokeWidth={2} />
              </IconButton>
              <IconButton>
                <CornerUpLeft className="size-3.5" strokeWidth={2} />
              </IconButton>
              <IconButton>
                <MoreVertical className="size-3.5" strokeWidth={2} />
              </IconButton>
            </div>
          </div>
        </div>
      </div>

      {/* body */}
      <p className="mt-3 text-[13px] leading-relaxed text-gm-text/90">{m.text}</p>

      {/* smart replies */}
      <div className="mt-4 flex flex-wrap gap-2">
        {SMART_REPLIES.map((r) => (
          <button
            key={r}
            className="rounded-full border border-gm-line px-3 py-1 text-[12px] font-medium text-gm-blue transition-colors hover:bg-gm-blue/5"
          >
            {r}
          </button>
        ))}
      </div>

      {/* reply / forward */}
      <div className="mt-3 flex gap-2 border-t border-gm-line pt-3">
        <button className="inline-flex items-center gap-1.5 rounded-md border border-gm-line px-3 py-1.5 text-[12.5px] font-medium text-gm-label transition-colors hover:bg-black/[0.03]">
          <CornerUpLeft className="size-3.5" strokeWidth={2} />
          Reply
        </button>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-gm-line px-3 py-1.5 text-[12.5px] font-medium text-gm-label transition-colors hover:bg-black/[0.03]">
          <CornerUpRight className="size-3.5" strokeWidth={2} />
          Forward
        </button>
      </div>

      {m.extracted && (
        <div className="mt-3">
          <MemoryChip />
        </div>
      )}
    </div>
  )
}

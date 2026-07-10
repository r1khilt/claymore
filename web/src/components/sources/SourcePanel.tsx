import type { ReactNode } from 'react'
import { Paperclip, MessageSquare, Star, MoreHorizontal, ChevronRight } from 'lucide-react'
import type { SourceFeed, SourceMessage } from '@/lib/types'
import { PLATFORM, PlatformIcon } from '@/lib/sources'
import { Avatar } from '@/components/ui/Avatar'
import { cn, clockTime, timeAgo } from '@/lib/utils'
import { IMessageThread } from './IMessageThread'
import { SlackThread } from './SlackThread'
import { GmailMessage } from './GmailMessage'
import { MemoryChip } from './MemoryChip'

function Attachment({ label }: { label: string }) {
  return (
    <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-1 font-mono text-[11px] text-muted ring-1 ring-inset ring-black/[0.05]">
      <Paperclip className="size-3" strokeWidth={2} />
      {label}
    </span>
  )
}

/* -------- per-platform message bodies -------- */

function GenericRow({ m }: { m: SourceMessage }) {
  return (
    <div className={cn('flex gap-2.5 px-1', m.extracted && 'rounded-lg bg-sage-500/[0.05] py-1')}>
      <Avatar name={m.author} accent={m.accent} size={30} className="mt-0.5 rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold text-ink">{m.author}</span>
          <span className="text-[11px] text-faint">{clockTime(m.timestamp)}</span>
          {m.extracted && <span className="ml-auto"><MemoryChip /></span>}
        </div>
        <p className="text-[13px] leading-snug text-ink/80">{m.text}</p>
        {m.attachment && <Attachment label={m.attachment.label} />}
      </div>
    </div>
  )
}

/* -------- Notion (real light-mode page) --------
 * Notion's own palette, not the warm Claymore theme: white page, ink
 * rgb(55,53,47), grey chrome. Reads like an embedded Notion doc. */

const N_INK = 'text-[#37352f]'
const N_GREY = 'text-[#37352f]/45'

function NotionPropertyRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-2 py-[3px] text-[12px]">
      <div className={cn('flex w-[92px] shrink-0 items-center gap-1.5', N_GREY)}>
        {icon}
        <span className="font-normal">{label}</span>
      </div>
      <div className={cn('min-w-0 flex-1 truncate', N_INK)}>{children}</div>
    </div>
  )
}

function NotionFileBlock({ label }: { label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-[3px] px-1.5 py-1.5 transition-colors hover:bg-[#37352f]/[0.04]">
      <span className="text-[15px] leading-none">📎</span>
      <span className={cn('truncate text-[13px] underline decoration-[#37352f]/20 underline-offset-2', N_INK)}>
        {label}
      </span>
    </div>
  )
}

function NotionDoc({ feed }: { feed: SourceFeed }) {
  const m = feed.messages[0]
  const crumbs = feed.subtitle ? feed.subtitle.split('/').map((s) => s.trim()) : []
  return (
    <div className="overflow-hidden rounded-[6px] bg-white ring-1 ring-inset ring-[#37352f]/[0.09] shadow-[0_1px_2px_rgba(15,15,15,0.05)]">
      {/* Notion top bar: breadcrumb + collaborator + chrome icons */}
      <div className="flex items-center gap-1 border-b border-[#37352f]/[0.06] px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1 text-[11.5px]">
          <span className="text-[12px] leading-none">🧪</span>
          {crumbs.map((c, i) => (
            <span key={c} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-2.5 text-[#37352f]/30" strokeWidth={2.5} />}
              <span className={cn('truncate', i === crumbs.length - 1 ? N_INK : N_GREY)}>{c}</span>
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2.5 text-[#37352f]/40">
          {m && <Avatar name={m.author} accent={m.accent} size={18} className="ring-2 ring-white" />}
          <MessageSquare className="size-3.5" strokeWidth={1.75} />
          <Star className="size-3.5" strokeWidth={1.75} />
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </div>
      </div>

      {/* Page body */}
      <div className="px-4 pb-3.5 pt-3">
        <div className="text-[26px] leading-none">🧪</div>
        <h3 className={cn('mt-2 text-[19px] font-bold leading-tight tracking-[-0.01em]', N_INK)}>
          {feed.title}
        </h3>

        {/* properties */}
        <div className="mt-2.5">
          {m && (
            <NotionPropertyRow
              icon={<span className="grid size-[15px] place-items-center text-[10px]">👤</span>}
              label="Edited by"
            >
              <span className="flex items-center gap-1.5">
                <Avatar name={m.author} accent={m.accent} size={16} />
                {m.author}
              </span>
            </NotionPropertyRow>
          )}
          <NotionPropertyRow
            icon={<span className="grid size-[15px] place-items-center text-[10px]">🕘</span>}
            label="Last edited"
          >
            {m ? `${timeAgo(m.timestamp)} ago` : '—'}
          </NotionPropertyRow>
        </div>

        <div className="my-2.5 h-px bg-[#37352f]/[0.08]" />

        {m && <p className={cn('text-[13.5px] leading-[1.6]', N_INK)}>{m.text}</p>}
        {m?.attachment && <NotionFileBlock label={m.attachment.label} />}

        {m?.extracted && (
          <div className="mt-2.5 border-t border-[#37352f]/[0.06] pt-2.5">
            <MemoryChip />
          </div>
        )}
      </div>
    </div>
  )
}

function GithubRow({ m }: { m: SourceMessage }) {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-black/[0.05] text-[10px]">
        <Avatar name={m.author} accent={m.accent} size={24} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink/85">{m.text}</p>
        <div className="flex items-center gap-1.5 text-[11px] text-faint">
          <span>{m.author}</span>
          <span>·</span>
          <span>{timeAgo(m.timestamp)}</span>
          {m.extracted && <span className="ml-1"><MemoryChip /></span>}
        </div>
      </div>
      {m.attachment && (
        <span className="shrink-0 rounded-md bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-muted ring-1 ring-inset ring-black/[0.05]">
          {m.attachment.label}
        </span>
      )}
    </div>
  )
}

function Body({ feed }: { feed: SourceFeed }) {
  switch (feed.platform) {
    case 'imessage':
      return <IMessageThread messages={feed.messages} />
    case 'notion':
      return <NotionDoc feed={feed} />
    case 'gmail':
      return <GmailMessage feed={feed} />
    case 'github':
      return (
        <div className="flex flex-col gap-2.5">
          {feed.messages.map((m) => (
            <GithubRow key={m.id} m={m} />
          ))}
        </div>
      )
    case 'slack':
      return <SlackThread messages={feed.messages} />
    default:
      return (
        <div className="flex flex-col gap-2.5">
          {feed.messages.map((m) => (
            <GenericRow key={m.id} m={m} />
          ))}
        </div>
      )
  }
}

export function SourcePanel({ feed }: { feed: SourceFeed }) {
  const meta = PLATFORM[feed.platform]
  return (
    <div className="glass rounded-2xl p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <PlatformIcon platform={feed.platform} size={24} />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold leading-tight text-ink">
            {feed.title}
          </div>
          <div className="truncate text-[11.5px] text-faint">
            {meta.label}
            {feed.subtitle ? ` · ${feed.subtitle}` : ''}
          </div>
        </div>
        {feed.connected && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-sage-400 opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-sage-500" />
            </span>
            {feed.lastSync ? timeAgo(feed.lastSync) : 'synced'}
          </span>
        )}
      </div>
      <Body feed={feed} />
    </div>
  )
}

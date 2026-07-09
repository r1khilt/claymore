import { Sparkles, Paperclip } from 'lucide-react'
import type { SourceFeed, SourceMessage } from '@/lib/types'
import { PLATFORM, PlatformIcon } from '@/lib/sources'
import { Avatar } from '@/components/ui/Avatar'
import { cn, clockTime, timeAgo } from '@/lib/utils'
import { IMessageThread } from './IMessageThread'

function MemoryChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sage-500/12 px-1.5 py-[3px] text-[10px] font-medium text-sage-700">
      <Sparkles className="size-2.5" strokeWidth={2.25} />
      in memory
    </span>
  )
}

function Attachment({ label }: { label: string }) {
  return (
    <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-1 font-mono text-[11px] text-muted ring-1 ring-inset ring-black/[0.05]">
      <Paperclip className="size-3" strokeWidth={2} />
      {label}
    </span>
  )
}

/* -------- per-platform message bodies -------- */

function SlackRow({ m }: { m: SourceMessage }) {
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

function NotionDoc({ feed }: { feed: SourceFeed }) {
  const m = feed.messages[0]
  return (
    <div className="rounded-xl bg-white/45 p-3 ring-1 ring-inset ring-black/[0.05]">
      <div className="flex items-center gap-2 text-[15px]">
        <span className="text-[17px]">📄</span>
        <span className="font-semibold text-ink">{feed.title}</span>
        {m?.extracted && <span className="ml-auto"><MemoryChip /></span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
        <span>Edited by {m?.author}</span>
        <span>{m ? timeAgo(m.timestamp) : ''} ago</span>
      </div>
      {m && <p className="mt-2.5 text-[13px] leading-relaxed text-ink/80">{m.text}</p>}
      {m?.attachment && <Attachment label={m.attachment.label} />}
    </div>
  )
}

function GmailRow({ feed }: { feed: SourceFeed }) {
  const m = feed.messages[0]
  if (!m) return null
  return (
    <div className={cn('rounded-xl p-2.5', m.extracted && 'bg-sage-500/[0.05]')}>
      <div className="flex items-center gap-2">
        <Avatar name={m.author} accent={m.accent} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink">{m.author}</span>
            <span className="ml-auto shrink-0 text-[11px] text-faint">{timeAgo(m.timestamp)}</span>
          </div>
          <div className="truncate text-[12px] font-medium text-muted">{feed.subtitle}</div>
        </div>
      </div>
      <p className="mt-2 line-clamp-3 text-[13px] leading-snug text-ink/75">{m.text}</p>
      {m.extracted && <div className="mt-2"><MemoryChip /></div>}
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
      return <GmailRow feed={feed} />
    case 'github':
      return (
        <div className="flex flex-col gap-2.5">
          {feed.messages.map((m) => (
            <GithubRow key={m.id} m={m} />
          ))}
        </div>
      )
    default:
      return (
        <div className="flex flex-col gap-2.5">
          {feed.messages.map((m) => (
            <SlackRow key={m.id} m={m} />
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

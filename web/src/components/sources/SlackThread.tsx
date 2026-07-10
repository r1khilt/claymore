import { Fragment } from 'react'
import { ChevronDown, ChevronRight, SmilePlus } from 'lucide-react'
import type { SourceMessage } from '@/lib/types'
import { Avatar } from '@/components/ui/Avatar'
import { cn, clockTime } from '@/lib/utils'

/** Consecutive messages from one author within this window collapse into a run. */
const GROUP_GAP_MS = 5 * 60 * 1000

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function ordinal(n: number): string {
  const rem = n % 100
  if (rem >= 11 && rem <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** "Today" | "Yesterday" | "Thursday, July 3rd" — Slack's date-divider label. */
function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
  const month = d.toLocaleDateString('en-US', { month: 'long' })
  return `${weekday}, ${month} ${ordinal(d.getDate())}`
}

/** Gutter time on a grouped row — hour:minute, no AM/PM, as Slack shows on hover. */
function gutterTime(iso: string): string {
  return clockTime(iso).replace(/\s?[AP]M$/i, '')
}

/** A centered, pill-capped date divider with a hairline rule behind it. */
function DayDivider({ iso, now }: { iso: string; now: Date }) {
  return (
    <div className="relative py-2.5">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-line/70" />
      <div className="relative mx-auto flex w-fit items-center gap-1 rounded-full border border-line bg-white/80 px-2.5 py-[3px] text-[11px] font-bold text-ink shadow-[0_1px_2px_rgba(28,29,24,0.06)]">
        {dayLabel(iso, now)}
        <ChevronDown className="size-3 text-faint" strokeWidth={2.5} />
      </div>
    </div>
  )
}

/** Split on @mentions, capturing them so they render as Slack's blue pill. */
const MENTION = /(@[A-Za-z][\w.-]*)/

function renderText(text: string) {
  return text.split(MENTION).map((part, i) =>
    i % 2 === 1 ? (
      <span
        key={i}
        className="rounded-[3px] bg-slack-blue/10 px-[3px] py-px font-medium text-slack-blue"
      >
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

function Reactions({ items }: { items: NonNullable<SourceMessage['reactions']> }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {items.map((r, i) => (
        <span
          key={i}
          className="flex items-center gap-1 rounded-full border border-slack-blue/35 bg-slack-blue/10 px-1.5 py-[1px] text-[11px] font-semibold text-slack-blue"
        >
          <span className="text-[12px] leading-none">{r.emoji}</span>
          {r.count}
        </span>
      ))}
      <span className="grid h-[18px] place-items-center rounded-full border border-line bg-white/50 px-1.5 text-faint">
        <SmilePlus className="size-3.5" strokeWidth={1.75} />
      </span>
    </div>
  )
}

function ThreadReplies({ replies }: { replies: NonNullable<SourceMessage['replies']> }) {
  return (
    <button
      type="button"
      className="mt-1 flex w-full items-center gap-2 rounded-lg border border-line/80 bg-white/40 px-2 py-1 text-left transition hover:border-line-strong hover:bg-white/70 hover:shadow-sm"
    >
      <span className="flex -space-x-1">
        {replies.by.slice(0, 3).map((p, i) => (
          <Avatar
            key={i}
            name={p.name}
            accent={p.accent}
            size={20}
            className="rounded-[5px] ring-2 ring-white"
          />
        ))}
      </span>
      <span className="text-[12px] font-bold text-slack-blue">
        {replies.count} {replies.count === 1 ? 'reply' : 'replies'}
      </span>
      <span className="text-[11.5px] text-faint">View thread</span>
      <ChevronRight className="ml-auto size-3.5 text-faint" strokeWidth={2} />
    </button>
  )
}

function Body({ m }: { m: SourceMessage }) {
  return (
    <>
      <div className="text-[13.5px] leading-[1.46] text-ink">{renderText(m.text)}</div>
      {m.reactions?.length ? <Reactions items={m.reactions} /> : null}
      {m.replies ? <ThreadReplies replies={m.replies} /> : null}
    </>
  )
}

/**
 * A Slack channel feed per the Slack UI kit: rounded-square avatars with an
 * active-presence dot, a bold name + timestamp, blue @mention pills, reaction
 * pills, and a "N replies · View thread" affordance. Consecutive messages from
 * one author within GROUP_GAP_MS collapse into a compact run (Slack's grouping);
 * a day change gets a centered, pill-capped divider.
 */
export function SlackThread({
  messages,
  now = new Date(),
}: {
  messages: SourceMessage[]
  now?: Date
}) {
  const at = (m: SourceMessage) => new Date(m.timestamp).getTime()

  return (
    <div className="flex flex-col">
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const newDay =
          !prev || startOfDay(new Date(prev.timestamp)) !== startOfDay(new Date(m.timestamp))
        const grouped =
          !newDay && !!prev && prev.author === m.author && at(m) - at(prev) < GROUP_GAP_MS

        return (
          <Fragment key={m.id}>
            {newDay && <DayDivider iso={m.timestamp} now={now} />}
            {grouped ? (
              <div className="group flex gap-2 px-1">
                <div className="w-[30px] shrink-0 pt-[3px] text-right text-[10px] leading-none text-faint opacity-0 transition-opacity group-hover:opacity-100">
                  {gutterTime(m.timestamp)}
                </div>
                <div className="min-w-0 flex-1">
                  <Body m={m} />
                </div>
              </div>
            ) : (
              <div className={cn('flex items-start gap-2 px-1', !newDay && 'mt-2.5')}>
                <div className="relative mt-0.5 shrink-0">
                  <Avatar name={m.author} accent={m.accent} size={30} className="rounded-[7px]" />
                  <span className="absolute -bottom-[3px] -right-[3px] size-[10px] rounded-full bg-slack-active ring-2 ring-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[13.5px] font-bold leading-tight text-ink">
                      {m.author}
                    </span>
                    <span className="text-[11px] text-muted">{clockTime(m.timestamp)}</span>
                  </div>
                  <Body m={m} />
                </div>
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

import { Fragment } from 'react'
import type { SourceMessage } from '@/lib/types'
import { cn, clockTime } from '@/lib/utils'

/** Messages further apart than this get a timestamp header above them. */
const DIVIDER_GAP_MS = 60 * 60 * 1000

/** How far the tail's tip juts past the bubble's side edge. */
const TAIL_OVERHANG = 6

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today" | "Yesterday" | "Monday" | "Jul 3" */
function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * The curl on the last bubble of a run.
 *
 * The usual CSS recipe paints an opaque background-colored wedge to carve the
 * hook out of a rounded box. That assumes an opaque backdrop; these panels are
 * frosted glass over a photo, so the wedge would read as a solid blob. Same two
 * shapes, expressed as a mask instead — bulge minus carve — so only the tail
 * itself is ever painted.
 */
function Tail({ side, className }: { side: 'in' | 'out'; className?: string }) {
  const id = `imsg-tail-${side}`
  return (
    <svg
      aria-hidden
      width="16"
      height="20"
      viewBox="0 0 20 25"
      className={cn(
        'pointer-events-none absolute bottom-0',
        side === 'out' ? '-right-[6px]' : '-left-[6px] -scale-x-100',
        className,
      )}
    >
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="25">
        {/* bulge: box with an elliptical bottom-left corner, sweeping into the bubble */}
        <path d="M20,0 L20,25 L16,25 A16,14 0 0 1 0,11 L0,0 Z" fill="#fff" />
        {/* carve: the rounded corner that hooks the outer edge back in */}
        <path d="M39,0 L39,25 L23,25 A10,10 0 0 1 13,15 L13,0 Z" fill="#000" />
      </mask>
      <rect width="20" height="25" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  )
}

function TimeDivider({ iso, now }: { iso: string; now: Date }) {
  return (
    <div className="py-2 text-center text-[11px] leading-none text-imsg-label">
      <span className="font-semibold">{dayLabel(iso, now)}</span> {clockTime(iso)}
    </div>
  )
}

function Bubble({ m, tail }: { m: SourceMessage; tail: boolean }) {
  const out = m.bubble === 'out'
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'relative max-w-[85%] rounded-[15px] px-[11px] py-[6px] text-[13.5px] leading-[18px]',
          out ? 'bg-imsg-blue text-white' : 'bg-imsg-gray text-black',
        )}
      >
        {m.text}
        {tail && <Tail side={out ? 'out' : 'in'} className={out ? 'text-imsg-blue' : 'text-imsg-gray'} />}
      </div>
    </div>
  )
}

/**
 * A 1:1 iMessage thread, per the iOS 17 kit: bubbles grouped into runs with a
 * tail on the last of each, centred day/time dividers across gaps, and a
 * "Delivered" receipt under the most recent outgoing message. Sender names and
 * avatars are deliberately absent — iOS only shows those in group threads.
 */
export function IMessageThread({
  messages,
  now = new Date(),
}: {
  messages: SourceMessage[]
  now?: Date
}) {
  const lastOut = messages.reduce((acc, m, i) => (m.bubble === 'out' ? i : acc), -1)
  const at = (m: SourceMessage) => new Date(m.timestamp).getTime()

  return (
    <div className="font-imsg flex flex-col" style={{ paddingInline: TAIL_OVERHANG }}>
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const next = messages[i + 1]

        const dividerBefore = !prev || at(m) - at(prev) > DIVIDER_GAP_MS
        const dividerAfter = !!next && at(next) - at(m) > DIVIDER_GAP_MS
        const startsRun = !prev || prev.bubble !== m.bubble
        const endsRun = !next || next.bubble !== m.bubble || dividerAfter

        return (
          <Fragment key={m.id}>
            {dividerBefore && <TimeDivider iso={m.timestamp} now={now} />}
            <div className={cn(!dividerBefore && (startsRun ? 'mt-2.5' : 'mt-0.5'))}>
              <Bubble m={m} tail={endsRun} />
            </div>
            {i === lastOut && (
              <div className="mt-1 text-right text-[11px] text-imsg-label">Delivered</div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

import { useEffect, useRef } from 'react'
import { Check, Droplet, ArrowDownToLine, Trash2, MousePointer2, type LucideIcon } from 'lucide-react'
import type { Protocol, StepKind } from '@/lib/protocol'
import { cn } from '@/lib/utils'

const ICON: Record<StepKind, LucideIcon> = {
  pick_up_tip: MousePointer2,
  aspirate: ArrowDownToLine,
  dispense: Droplet,
  drop_tip: Trash2,
  move: MousePointer2,
}

export function RunLog({ protocol, index }: { protocol: Protocol; index: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current?.querySelector('[data-current="true"]')
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [index])

  return (
    <div ref={ref} className="no-scrollbar flex h-full flex-col gap-0.5 overflow-y-auto p-1">
      {protocol.steps.map((s, i) => {
        const done = i < index
        const current = i === index
        const Icon = ICON[s.kind]
        return (
          <div
            key={i}
            data-current={current}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors',
              current
                ? 'bg-sage-500/12 text-sage-700'
                : done
                  ? 'text-faint'
                  : 'text-muted',
            )}
          >
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-md',
                current ? 'bg-sage-500 text-white' : done ? 'bg-sage-500/15 text-sage-600' : 'bg-black/[0.05] text-faint',
              )}
            >
              {done ? <Check className="size-3" strokeWidth={2.5} /> : <Icon className="size-3" strokeWidth={2} />}
            </span>
            <span className={cn('flex-1 truncate', current && 'font-medium')}>{s.label}</span>
            <span className="shrink-0 tabular-nums text-[11px] text-faint">{i + 1}</span>
          </div>
        )
      })}
    </div>
  )
}

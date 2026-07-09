import { useEffect, useRef } from 'react'
import { ArrowUp, FlaskConical, Layers, Clock, ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

function Pill({ icon: Icon, label }: { icon: typeof Layers; label: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-2.5 py-1 text-[12.5px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
    >
      <Icon className="size-[14px]" strokeWidth={1.85} />
      {label}
      <ChevronDown className="size-3 text-faint" strokeWidth={2} />
    </button>
  )
}

export function AskBox({
  value,
  onChange,
  onSubmit,
  loading,
  autoFocus,
  placeholder = "Ask your lab's memory…",
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  loading?: boolean
  autoFocus?: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // auto-grow
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const canSend = value.trim().length > 0 && !loading

  return (
    <div className="glass-raised rounded-[26px] p-2.5 transition-shadow focus-within:shadow-[0_28px_70px_-24px_rgba(28,29,24,0.3)]">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (canSend) onSubmit()
          }
        }}
        placeholder={placeholder}
        className="max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-2.5 text-[16px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
      />
      <div className="flex items-center gap-2 px-1.5 pb-0.5 pt-1.5">
        <Pill icon={FlaskConical} label="Whole lab" />
        <Pill icon={Layers} label="All sources" />
        <Pill icon={Clock} label="Any time" />
        <button
          onClick={() => canSend && onSubmit()}
          disabled={!canSend}
          className={cn(
            'ml-auto grid size-9 place-items-center rounded-full text-white transition-all',
            canSend
              ? 'bg-sage-500 hover:bg-sage-600 hover:scale-105'
              : 'cursor-not-allowed bg-black/10 text-white/70',
          )}
          title="Ask"
        >
          {loading ? (
            <Loader2 className="size-[18px] animate-spin" strokeWidth={2.25} />
          ) : (
            <ArrowUp className="size-[19px]" strokeWidth={2.25} />
          )}
        </button>
      </div>
    </div>
  )
}

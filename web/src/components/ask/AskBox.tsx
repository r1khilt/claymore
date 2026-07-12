import { useEffect, useRef } from 'react'
import { ArrowUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

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
    <div className="glass-raised relative rounded-[24px] transition-shadow focus-within:shadow-[0_28px_70px_-24px_rgba(28,29,24,0.3)] focus-within:ring-2 focus-within:ring-sage-500/40">
      <textarea
        ref={ref}
        rows={1}
        aria-label="Ask your lab's memory"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (canSend) onSubmit()
          }
        }}
        placeholder={placeholder}
        className="max-h-[200px] w-full resize-none bg-transparent py-[15px] pl-5 pr-[54px] text-[15.5px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
      />
      <button
        onClick={() => canSend && onSubmit()}
        disabled={!canSend}
        className={cn(
          'absolute bottom-[9px] right-[9px] grid size-9 place-items-center rounded-full text-white transition-all',
          canSend
            ? 'bg-sage-500 hover:scale-105 hover:bg-sage-600'
            : 'cursor-not-allowed bg-black/10 text-white/70',
        )}
        title="Send"
      >
        {loading ? (
          <Loader2 className="size-[18px] animate-spin" strokeWidth={2.25} />
        ) : (
          <ArrowUp className="size-[19px]" strokeWidth={2.25} />
        )}
      </button>
    </div>
  )
}

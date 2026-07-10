import { Sparkles } from 'lucide-react'

/** Badge marking a source episode that Claymore has extracted into memory. */
export function MemoryChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sage-500/12 px-1.5 py-[3px] text-[10px] font-medium text-sage-700">
      <Sparkles className="size-2.5" strokeWidth={2.25} />
      in memory
    </span>
  )
}

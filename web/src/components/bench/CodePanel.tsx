import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function CodePanel({
  code,
  lang,
  insetLeft = false,
}: {
  code: string
  lang: string
  /** Reserve space on the left of the header for an overlaid control (the inline bench's toggle). */
  insetLeft?: boolean
}) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex items-center justify-between border-b border-line/70 py-2 pr-3.5',
          insetLeft ? 'pl-[132px]' : 'pl-3.5',
        )}
      >
        <span className="font-mono text-[11px] text-muted">protocol.py · {lang}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:bg-black/5 hover:text-ink"
        >
          {copied ? (
            <>
              <Check className="size-3.5 text-sage-600" strokeWidth={2.5} /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" strokeWidth={2} /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="no-scrollbar flex-1 overflow-auto p-3.5 font-mono text-[12px] leading-relaxed text-ink/85">
        {code}
      </pre>
    </div>
  )
}

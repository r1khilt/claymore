import { motion } from 'framer-motion'
import { Zap, MessageSquare, ArrowRight } from 'lucide-react'
import type { SourcePlatform } from '@/lib/types'
import { PlatformIcon } from '@/lib/sources'

const INGEST_SOURCES: SourcePlatform[] = ['slack', 'gmail', 'notion', 'github', 'granola', 'imessage']

const CARD_IN = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

/** The start screen: two ways in — Run (autopilot) or Chat (Composer). Sits in the
 *  middle section only; the sidebar and source rail stay put around it. */
export function RunChatLanding({ onRun, onChat }: { onRun: () => void; onChat: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-[6vh]">
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="font-serif text-[52px] leading-none tracking-tight text-ink"
      >
        Start with memory.
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.12 }}
        className="mt-3.5 max-w-md text-center text-[15px] leading-relaxed text-muted text-balance"
      >
        Claymore has read everything your lab said, wrote, and committed. Pick how to put it to work.
      </motion.p>

      <div className="mt-9 grid w-full max-w-[760px] grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Run — autopilot */}
        <motion.button
          {...CARD_IN}
          transition={{ delay: 0.14, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          onClick={onRun}
          className="glass-raised group flex flex-col rounded-2xl p-5 text-left ring-1 ring-inset ring-sage-500/20 transition-all hover:-translate-y-1"
        >
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-sage-500 text-white shadow-sm">
              <Zap className="size-[18px]" strokeWidth={2.1} />
            </span>
            <span className="font-serif text-[26px] leading-none text-ink">Run</span>
            <ArrowRight className="ml-auto size-[18px] text-faint transition-all group-hover:translate-x-0.5 group-hover:text-sage-600" strokeWidth={2} />
          </div>
          <p className="mt-3.5 text-[13.5px] leading-relaxed text-ink/75">
            Ingest every source, then let Claymore surface the experiments your team should be
            running — and run the safe ones itself.
          </p>
          <div className="mt-auto flex items-center gap-1.5 pt-4">
            {INGEST_SOURCES.map((p) => (
              <PlatformIcon key={p} platform={p} size={19} />
            ))}
            <span className="ml-1 text-[11.5px] font-medium text-faint">autonomous</span>
          </div>
        </motion.button>

        {/* Chat — the Composer */}
        <motion.button
          {...CARD_IN}
          transition={{ delay: 0.2, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          onClick={onChat}
          className="glass group flex flex-col rounded-2xl p-5 text-left transition-all hover:-translate-y-1 hover:bg-white/70"
        >
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-ink/[0.06] text-ink">
              <MessageSquare className="size-[18px]" strokeWidth={2} />
            </span>
            <span className="font-serif text-[26px] leading-none text-ink">Chat</span>
            <ArrowRight className="ml-auto size-[18px] text-faint transition-all group-hover:translate-x-0.5 group-hover:text-ink" strokeWidth={2} />
          </div>
          <p className="mt-3.5 text-[13.5px] leading-relaxed text-ink/75">
            Talk to Claymore to understand what the team’s working on, then run any experiment on
            demand.
          </p>
          <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
            {['What did Lucas suggest?', 'Dock the CBX2 library'].map((chip) => (
              <span
                key={chip}
                className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[11.5px] text-muted ring-1 ring-inset ring-black/[0.04]"
              >
                {chip}
              </span>
            ))}
          </div>
        </motion.button>
      </div>
    </div>
  )
}

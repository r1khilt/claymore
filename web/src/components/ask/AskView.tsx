import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, ArrowUpRight } from 'lucide-react'
import type { AgentEvent } from '@/lib/agent'
import { agentStream } from '@/lib/agent'
import type { Protocol } from '@/lib/protocol'
import { AskBox } from './AskBox'
import { AgentTurn } from './AgentTurn'

interface Turn {
  q: string
  events: AgentEvent[]
  running: boolean
}

const SUGGESTIONS = [
  'Fill a 96-well plate with buffer',
  'Set up a PCR plate on the thermocycler',
  'Did we ever test the Y hypothesis?',
  'Dock the CBX2 fragment library',
]

function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map((q, i) => (
        <motion.button
          key={q}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 + i * 0.05 }}
          onClick={() => onPick(q)}
          className="glass group flex items-center gap-2 rounded-xl px-3.5 py-3 text-left text-[13.5px] text-ink/80 transition-all hover:-translate-y-0.5 hover:text-ink"
        >
          <span className="flex-1">{q}</span>
          <ArrowUpRight className="size-4 shrink-0 text-faint transition-colors group-hover:text-sage-500" />
        </motion.button>
      ))}
    </div>
  )
}

export function AskView({ onOpenProtocol }: { onOpenProtocol: (p: Protocol) => void }) {
  const [value, setValue] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  async function submit(raw?: string) {
    const q = (raw ?? value).trim()
    if (!q || busy) return
    setValue('')
    const idx = turns.length
    setTurns((t) => [...t, { q, events: [], running: true }])
    setBusy(true)
    try {
      for await (const ev of agentStream(q)) {
        setTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, events: [...turn.events, ev] } : turn)))
      }
    } finally {
      setTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, running: false } : turn)))
      setBusy(false)
    }
  }

  const empty = turns.length === 0

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 pb-[10vh]">
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="font-serif text-[68px] leading-none tracking-tight text-ink"
        >
          claymore
        </motion.h1>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.12 }}
          className="mt-3.5 max-w-md text-center text-[15px] leading-relaxed text-muted text-balance"
        >
          Ask the lab, run an analysis, or drive the robot — one agent, working across every source,
          every answer cited.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mt-9 w-full max-w-[660px]"
        >
          <AskBox value={value} onChange={setValue} onSubmit={() => submit()} loading={busy} autoFocus />
          <Suggestions onPick={submit} />
        </motion.div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 pt-5">
        <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-faint">Composer</span>
        <button
          onClick={() => {
            if (busy) return
            setTurns([])
            setValue('')
          }}
          className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
        >
          <Plus className="size-3.5" strokeWidth={2} />
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-9 px-6 py-7">
          {turns.map((turn, i) => (
            <div key={i} className="flex flex-col gap-4">
              <h2 className="text-[22px] font-medium leading-snug tracking-tight text-ink text-balance">
                {turn.q}
              </h2>
              <AgentTurn events={turn.events} running={turn.running} onOpenProtocol={onOpenProtocol} />
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-line/70 px-6 py-4">
        <div className="mx-auto max-w-[720px]">
          <AskBox
            value={value}
            onChange={setValue}
            onSubmit={() => submit()}
            loading={busy}
            placeholder="Ask a follow-up, or give the agent a task…"
          />
        </div>
      </div>
    </div>
  )
}

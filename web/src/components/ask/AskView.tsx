import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Plus, ArrowUpRight } from 'lucide-react'
import type { Reply } from '@/lib/types'
import { ask } from '@/lib/api'
import { exampleQueries } from '@/lib/mockData'
import { protocolFor, type Protocol } from '@/lib/protocol'
import { AskBox } from './AskBox'
import { AnswerView } from './AnswerView'
import { ProtocolCard } from './ProtocolCard'

interface Turn {
  q: string
  reply?: Reply
  protocol?: Protocol
}

function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {exampleQueries.map((q, i) => (
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

function Thinking() {
  return (
    <div className="flex items-center gap-2.5 text-[14px] text-muted">
      <Loader2 className="size-4 animate-spin text-sage-500" strokeWidth={2.25} />
      <span className="relative overflow-hidden">
        Searching the lab’s memory
        <span className="ml-0.5 inline-flex">
          <span className="animate-pulse">…</span>
        </span>
      </span>
    </div>
  )
}

export function AskView({ onOpenProtocol }: { onOpenProtocol: (p: Protocol) => void }) {
  const [value, setValue] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns, loading])

  async function submit(raw?: string) {
    const q = (raw ?? value).trim()
    if (!q || loading) return

    // Opentrons intent -> generate a protocol instead of a text answer.
    const proto = protocolFor(q)
    if (proto) {
      setValue('')
      setTurns((t) => [...t, { q, protocol: proto }])
      return
    }

    setValue('')
    setTurns((t) => [...t, { q }])
    setLoading(true)
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const reply = await ask(q, ac.signal)
      setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, reply } : turn)))
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setTurns((t) =>
          t.map((turn, i) =>
            i === t.length - 1
              ? { ...turn, reply: { text: 'Something went wrong reaching memory.', citations: [] } }
              : turn,
          ),
        )
      }
    } finally {
      setLoading(false)
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
          Ask anything your lab has said, written, or committed — get an answer with every source
          cited.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mt-9 w-full max-w-[660px]"
        >
          <AskBox value={value} onChange={setValue} onSubmit={() => submit()} loading={loading} autoFocus />
          <Suggestions onPick={submit} />
        </motion.div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 pt-5">
        <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-faint">
          Conversation
        </span>
        <button
          onClick={() => {
            setTurns([])
            setValue('')
          }}
          className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
        >
          <Plus className="size-3.5" strokeWidth={2} />
          New
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-9 px-6 py-7">
          {turns.map((turn, i) => (
            <div key={i} className="flex flex-col gap-4">
              <h2 className="text-[22px] font-medium leading-snug tracking-tight text-ink text-balance">
                {turn.q}
              </h2>
              {turn.protocol ? (
                <div className="flex flex-col gap-3">
                  <p className="text-[15px] leading-relaxed text-ink/80">
                    Here’s an Opentrons protocol for that — generated as a{' '}
                    <span className="font-medium text-ink">dry-run simulation</span>. Open the Bench to
                    watch it run.
                  </p>
                  <ProtocolCard protocol={turn.protocol} onOpen={() => onOpenProtocol(turn.protocol!)} />
                </div>
              ) : turn.reply ? (
                <AnswerView reply={turn.reply} />
              ) : i === turns.length - 1 && loading ? (
                <Thinking />
              ) : null}
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
            loading={loading}
            placeholder="Ask a follow-up…"
          />
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import type { AgentEvent, ConvTurn } from '@/lib/agent'
import { agentStream } from '@/lib/agent'
import type { Protocol } from '@/lib/protocol'
import { BrandMark } from '@/components/Sidebar'
import { AskBox } from './AskBox'
import { AgentTurn } from './AgentTurn'

interface Turn {
  q: string
  events: AgentEvent[]
  running: boolean
}

/** A compact one-line record of what the agent said/did on a turn — the "agent" side of history. */
function agentTextFromEvents(events: AgentEvent[]): string {
  const answers: string[] = []
  for (const e of events) if (e.type === 'answer') answers.push(e.text)
  if (answers.length) return answers.join('\n')
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'protocol') return `Built the "${e.protocol.name}" scene.`
    if (e.type === 'mlResult') return `Ran an ML analysis: ${e.result.title} (${e.result.verdict}).`
    if (e.type === 'analysis') return e.analysis.summary
    if (e.type === 'scienceSession') return e.session.resultSummary
  }
  return ''
}

/** The most recent protocol the agent produced across the conversation (the edit target). */
function lastProtocolOf(turns: Turn[]): Protocol | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const events = turns[i].events
    for (let j = events.length - 1; j >= 0; j--) {
      const e = events[j]
      if (e.type === 'protocol') return e.protocol
    }
  }
  return undefined
}

/** Build the conversation context the agent needs to answer with continuity (the memory fix). */
function buildContext(prior: Turn[]): { history: ConvTurn[]; lastProtocol?: Protocol } {
  const history: ConvTurn[] = []
  for (const t of prior) {
    if (t.q.trim()) history.push({ role: 'user', text: t.q })
    const at = agentTextFromEvents(t.events)
    if (at) history.push({ role: 'agent', text: at })
  }
  return { history, lastProtocol: lastProtocolOf(prior) }
}

/** A persisted turn (no transient `running` flag) — the shape stored in a chat. */
export interface PersistTurn {
  q: string
  events: AgentEvent[]
}

const SUGGESTIONS = [
  'Fill a 96-well plate with buffer',
  'Was our hypothesis that descriptors predict CBX2 activity true?',
  'Did we ever test the Y hypothesis?',
  'Dock the CBX2 fragment library',
]

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18 }}
      className="glass-quiet mt-5 overflow-hidden rounded-2xl"
    >
      {SUGGESTIONS.map((q) => (
        <button
          key={q}
          onClick={() => onPick(q)}
          className="group flex w-full items-center gap-2.5 border-b border-line/60 px-4 py-2.5 text-left text-[13.5px] text-muted transition-colors last:border-0 hover:bg-white/55 hover:text-ink"
        >
          <span className="flex-1">{q}</span>
          <ArrowUpRight
            className="size-4 shrink-0 text-faint transition-colors group-hover:text-sage-500"
            strokeWidth={1.85}
          />
        </button>
      ))}
    </motion.div>
  )
}

export function AskView({
  onOpenProtocol,
  initialTurns,
  onPersist,
  userName,
}: {
  onOpenProtocol: (p: Protocol) => void
  /** Turns to seed the Composer with when restoring a saved chat (parent remounts on change). */
  initialTurns?: PersistTurn[]
  /** Called after every completed turn so the parent can persist the chat locally. */
  onPersist?: (turns: PersistTurn[]) => void
  /** First name for the empty-state greeting. */
  userName?: string
}) {
  const [value, setValue] = useState('')
  const [turns, setTurns] = useState<Turn[]>(() =>
    (initialTurns ?? []).map((t) => ({ ...t, running: false })),
  )
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  // Mirror of `turns` kept in sync through every update so persistence reads the latest snapshot
  // without waiting on a React state flush.
  const turnsRef = useRef<Turn[]>(turns)
  // The in-flight stream's aborter. When this AskView unmounts — which only happens on a
  // chat switch (view changes keep it mounted+hidden) — we cancel the run so it can't keep
  // streaming into a dead component or persist a stale, half-finished turn to disk.
  const abortRef = useRef<AbortController | null>(null)

  function applyTurns(fn: (t: Turn[]) => Turn[]) {
    setTurns((prev) => {
      const next = fn(prev)
      turnsRef.current = next
      return next
    })
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  useEffect(() => () => abortRef.current?.abort(), [])

  async function submit(raw?: string) {
    const q = (raw ?? value).trim()
    if (!q || busy) return
    setValue('')
    // Snapshot the prior turns BEFORE appending this one — that's the conversation the agent sees.
    const ctx = buildContext(turnsRef.current)
    const idx = turnsRef.current.length
    applyTurns((t) => [...t, { q, events: [], running: true }])
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      for await (const ev of agentStream(q, { ...ctx, signal: ctrl.signal })) {
        if (ctrl.signal.aborted) break
        applyTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, events: [...turn.events, ev] } : turn)))
      }
    } catch (err) {
      if (!ctrl.signal.aborted) throw err
    } finally {
      // On abort the chat is gone — don't touch its (unmounted) state or save the partial turn.
      if (!ctrl.signal.aborted) {
        applyTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, running: false } : turn)))
        setBusy(false)
        onPersist?.(turnsRef.current.map(({ q: tq, events }) => ({ q: tq, events })))
      }
    }
  }

  const empty = turns.length === 0

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 pb-[9vh]">
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="font-serif text-[46px] leading-tight tracking-tight text-ink"
        >
          {greeting()}
          {userName ? `, ${userName}` : ''}.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.12 }}
          className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted text-balance"
        >
          One agent across everything your lab said, wrote, and ran — every answer cited.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mt-8 w-full max-w-[620px]"
        >
          <AskBox value={value} onChange={setValue} onSubmit={() => submit()} loading={busy} autoFocus />
          <Suggestions onPick={submit} />
        </motion.div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mask-fade-y flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-9 px-6 pb-6 pt-14">
          {turns.map((turn, i) => (
            <div key={i} className="flex flex-col gap-5">
              {/* you — a glass bubble on the right */}
              <div className="flex justify-end pl-12">
                <div className="glass max-w-full whitespace-pre-wrap break-words rounded-[20px] rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed text-ink">
                  {turn.q}
                </div>
              </div>

              {/* claymore — open prose on the left, marked with the brand glyph */}
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5">
                  <BrandMark size={15} />
                  <span className="font-serif text-[13.5px] leading-none text-muted">claymore</span>
                </div>
                <AgentTurn events={turn.events} running={turn.running} onOpenProtocol={onOpenProtocol} />
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <div className="px-6 pb-5 pt-1">
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

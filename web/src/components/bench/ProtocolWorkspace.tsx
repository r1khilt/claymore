import { lazy, Suspense, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Play,
  Pause,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Lock,
  ScrollText,
  Code2,
  ShieldCheck,
} from 'lucide-react'
import type { Protocol } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import { Deck2D } from './Deck2D'
import { RunLog } from './RunLog'
import { CodePanel } from './CodePanel'
import { useRunPlayer } from './useRunPlayer'

// three.js only loads when the 3D toggle is used.
const Deck3D = lazy(() => import('./Deck3D'))

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-lg border border-black/[0.07] bg-white/50 p-0.5 text-[12.5px]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative rounded-md px-3 py-1 font-medium transition-colors',
            value === o.value ? 'text-ink' : 'text-muted hover:text-ink',
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId="seg-active"
              className="absolute inset-0 -z-10 rounded-md bg-white shadow-sm ring-1 ring-black/[0.05]"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            />
          )}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ProtocolWorkspace({ protocol }: { protocol: Protocol }) {
  const player = useRunPlayer(protocol)
  const [dim, setDim] = useState<'2d' | '3d'>('2d')
  const [tab, setTab] = useState<'log' | 'code'>('log')
  const [gate, setGate] = useState(false)
  const { index, total, playing, speed, state } = player
  const progress = ((index + 1) / total) * 100

  return (
    <div className="flex h-full flex-col px-7 py-6">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="font-serif text-[30px] leading-none tracking-tight text-ink">{protocol.name}</h1>
            <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11.5px] font-medium text-muted">
              {protocol.deck.robot}
            </span>
          </div>
          <p className="mt-1.5 text-[13.5px] text-muted">
            {protocol.description} · {protocol.deck.pipette.display}
          </p>
          {protocol.groundedNote && (
            <p className="mt-1 text-[12.5px] italic text-sage-700/80">{protocol.groundedNote}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full bg-sage-500/12 px-2.5 py-1 text-[11.5px] font-medium text-sage-700">
            <span className="size-1.5 rounded-full bg-sage-500" />
            opentrons.simulate · dry-run
          </span>
          <Segmented
            value={dim}
            onChange={setDim}
            options={[
              { value: '2d', label: '2D' },
              { value: '3d', label: '3D' },
            ]}
          />
        </div>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* deck + transport */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="glass relative flex-1 overflow-hidden rounded-2xl p-4">
            <AnimatePresence mode="wait">
              <motion.div
                key={dim}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="h-full w-full"
              >
                {dim === '2d' ? (
                  <Deck2D protocol={protocol} state={state} />
                ) : (
                  <Suspense
                    fallback={
                      <div className="grid h-full place-items-center text-[13px] text-muted">
                        Loading 3D scene…
                      </div>
                    }
                  >
                    <Deck3D protocol={protocol} state={state} />
                  </Suspense>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* transport */}
          <div className="glass rounded-2xl px-4 py-3">
            <div className="mb-2.5 flex items-center gap-3">
              <button
                onClick={player.restart}
                className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-black/5 hover:text-ink"
                title="Restart"
              >
                <RotateCcw className="size-4" strokeWidth={2} />
              </button>
              <button
                onClick={player.prev}
                className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-black/5 hover:text-ink"
                title="Step back"
              >
                <ChevronLeft className="size-4.5" strokeWidth={2} />
              </button>
              <button
                onClick={player.toggle}
                className="grid size-10 place-items-center rounded-full bg-sage-500 text-white shadow-sm transition-colors hover:bg-sage-600"
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause className="size-5" strokeWidth={2.25} /> : <Play className="size-5 translate-x-0.5" strokeWidth={2.25} />}
              </button>
              <button
                onClick={player.next}
                className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-black/5 hover:text-ink"
                title="Step forward"
              >
                <ChevronRight className="size-4.5" strokeWidth={2} />
              </button>

              <div className="ml-1 tabular-nums text-[13px] text-muted">
                <span className="font-medium text-ink">{Math.max(0, index + 1)}</span> / {total}
              </div>

              <button
                onClick={player.cycleSpeed}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white/50 px-2.5 py-1 text-[12.5px] font-medium text-muted transition-colors hover:text-ink"
                title="Playback speed"
              >
                <Gauge className="size-3.5" strokeWidth={2} />
                {speed}×
              </button>
            </div>

            {/* scrubber */}
            <div className="relative">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
                <div
                  className="h-full rounded-full bg-sage-500 transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <input
                type="range"
                min={-1}
                max={total - 1}
                step={1}
                value={index}
                onChange={(e) => player.seek(Number(e.target.value))}
                className="absolute inset-0 h-1.5 w-full cursor-pointer opacity-0"
                aria-label="Scrub run"
              />
            </div>
          </div>
        </div>

        {/* right: log / code / gate */}
        <div className="flex w-[356px] shrink-0 flex-col gap-3">
          <div className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
            <div className="flex items-center gap-1 border-b border-line/70 p-1.5">
              <button
                onClick={() => setTab('log')}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] font-medium transition-colors',
                  tab === 'log' ? 'bg-sage-500/12 text-sage-700' : 'text-muted hover:text-ink',
                )}
              >
                <ScrollText className="size-4" strokeWidth={2} /> Run log
              </button>
              <button
                onClick={() => setTab('code')}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] font-medium transition-colors',
                  tab === 'code' ? 'bg-sage-500/12 text-sage-700' : 'text-muted hover:text-ink',
                )}
              >
                <Code2 className="size-4" strokeWidth={2} /> Python
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {tab === 'log' ? <RunLog protocol={protocol} index={index} /> : <CodePanel code={protocol.python} />}
            </div>
          </div>

          {/* physical-run gate (hard rule 2) */}
          <div className="glass rounded-2xl p-3.5">
            <AnimatePresence mode="wait" initial={false}>
              {gate ? (
                <motion.div
                  key="gated"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2.5"
                >
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-amber-400/18 text-amber-500">
                    <ShieldCheck className="size-4" strokeWidth={2} />
                  </span>
                  <div className="text-[12.5px] leading-relaxed text-ink/80">
                    Physical runs are gated. A human approves the plan + simulation before the OT-2 ever
                    moves — no wet-lab step runs from a text.
                    <button
                      onClick={() => setGate(false)}
                      className="ml-1 font-medium text-sage-700 hover:underline"
                    >
                      Got it
                    </button>
                  </div>
                </motion.div>
              ) : (
                <motion.button
                  key="cta"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => setGate(true)}
                  className="flex w-full items-center gap-2 text-[13px] font-medium text-muted transition-colors hover:text-ink"
                >
                  <Lock className="size-4 text-faint" strokeWidth={2} />
                  Request physical run
                  <span className="ml-auto text-[11.5px] font-normal text-faint">human-gated</span>
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * InlineBench — the live 3D wet-lab workspace, embedded directly in a chat message.
 *
 * A protocol answer no longer shows a flat preview that ships you off to a separate page: the
 * bench renders *inline*, the robotic run plays itself, and a compact transport lets you scrub it —
 * all without leaving the conversation. "Open full bench" stays as an escape hatch to the full
 * workbench (code panel + physical-run gate), so nothing is lost.
 *
 * The one hard constraint is WebGL context budget: a scrolling chat can hold many protocol answers,
 * and browsers cap live GL contexts (~8-16). So the Canvas is mounted through an IntersectionObserver
 * — it comes alive just before it scrolls into view and is torn down (context released) when it
 * leaves, and the run auto-plays on first reveal / auto-pauses off-screen. At most the few on-screen
 * benches ever hold a context. No WebGL at all → an animated 2D deck renders the same run.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  FlaskConical,
  Play,
  Pause,
  RotateCcw,
  Gauge,
  Maximize2,
  Boxes,
  CircleDot,
} from 'lucide-react'
import { primaryPipette, type Protocol } from '@/lib/protocol'
import { webglAvailable } from '@/lib/webgl'
import { cn } from '@/lib/utils'
import { Deck2D } from './Deck2D'
import { useRunPlayer } from './useRunPlayer'

// three.js only loads once a bench actually scrolls into a conversation.
const Deck3D = lazy(() => import('./Deck3D'))

/** Fires `true` when the element is (nearly) on-screen, `false` once it leaves. `rootMargin` pre-arms
 *  it so the heavy Canvas is already mounting a beat before the user reaches it. */
function useInView<T extends Element>(rootMargin = '240px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])
  return [ref, inView]
}

export function InlineBench({
  protocol,
  onExpand,
  onComplete,
}: {
  protocol: Protocol
  onExpand: () => void
  /** Fires once when the run first reaches its last step — lets the turn hold its written
   *  conclusion until the bench has actually finished playing. */
  onComplete?: () => void
}) {
  const player = useRunPlayer(protocol)
  const { index, total, playing, speed, state } = player
  const [containerRef, inView] = useInView<HTMLDivElement>()
  const webgl = useMemo(webglAvailable, [])
  const startedRef = useRef(false)
  const completedRef = useRef(false)

  // The run has reached the end at least once. Fire onComplete a single time.
  const finished = index >= total - 1
  useEffect(() => {
    if (finished && !completedRef.current) {
      completedRef.current = true
      onComplete?.()
    }
  }, [finished, onComplete])

  const general = protocol.mode === 'general'
  const pipette = primaryPipette(protocol)
  const progress = ((index + 1) / total) * 100
  const chips = [
    ...protocol.deck.modules.map((m) => m.display),
    ...protocol.deck.accessories.map((a) => a.display),
  ].slice(0, 3)

  // Auto-play the run the first time the bench reveals; pause it whenever it scrolls away so an
  // off-screen bench never burns frames (and, with the Canvas unmounted below, holds no GL context).
  useEffect(() => {
    if (inView && !startedRef.current) {
      startedRef.current = true
      player.play()
    } else if (!inView && playing) {
      player.pause()
    }
    // player identity is stable per protocol; guarding on inView/playing is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, playing])

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="glass-raised overflow-hidden rounded-2xl"
    >
      {/* header */}
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span
          className={cn(
            'grid size-7 place-items-center rounded-lg',
            general ? 'bg-amber-400/16 text-amber-500' : 'bg-sage-500/14 text-sage-700',
          )}
        >
          <FlaskConical className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink">{protocol.name}</div>
          <div className="truncate text-[12px] text-muted">
            {protocol.platformLabel} · {pipette.display} · {total} steps
          </div>
        </div>
        <span
          className={cn(
            'ml-auto flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium',
            general
              ? 'border-amber-400/20 bg-amber-400/10 text-amber-500'
              : 'border-sage-500/15 bg-sage-500/10 text-sage-700',
          )}
        >
          <CircleDot className="size-3" strokeWidth={2.25} />
          {general ? 'off-deck' : 'dry-run'}
        </span>
      </div>

      {/* live 3D bench — mounted only while on-screen */}
      <div className="relative mx-4 mt-3 overflow-hidden rounded-xl bg-[#eeece6] ring-1 ring-inset ring-black/[0.06]">
        <div className="aspect-[16/10] w-full">
          {webgl ? (
            inView ? (
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-[12.5px] text-muted">
                    Loading bench…
                  </div>
                }
              >
                <Deck3D protocol={protocol} state={state} />
              </Suspense>
            ) : (
              <div className="grid h-full place-items-center text-[12.5px] text-faint">Bench paused</div>
            )
          ) : (
            // No WebGL → the 2D engine plays the very same run.
            <div className="h-full p-2">
              <Deck2D protocol={protocol} state={state} />
            </div>
          )}
        </div>

        {/* current-step caption */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/25 to-transparent px-3 pb-2 pt-6 text-[12px] font-medium text-white">
          <span className="tabular-nums opacity-80">
            {Math.max(0, index + 1)}/{total}
          </span>
          <span className="min-w-0 flex-1 truncate">{state.current?.label ?? 'Ready to run'}</span>
        </div>
      </div>

      {/* compact transport */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <button
          onClick={player.restart}
          className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-black/5 hover:text-ink"
          title="Restart"
        >
          <RotateCcw className="size-4" strokeWidth={2} />
        </button>
        <button
          onClick={player.toggle}
          className="grid size-9 place-items-center rounded-full bg-sage-500 text-white shadow-sm transition-colors hover:bg-sage-600"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <Pause className="size-[18px]" strokeWidth={2.25} />
          ) : (
            <Play className="size-[18px] translate-x-0.5" strokeWidth={2.25} />
          )}
        </button>

        {/* scrubber */}
        <div className="relative min-w-0 flex-1">
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

        <button
          onClick={player.cycleSpeed}
          className="flex items-center gap-1 rounded-lg border border-black/[0.06] bg-white/50 px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:text-ink"
          title="Playback speed"
        >
          <Gauge className="size-3.5" strokeWidth={2} />
          {speed}×
        </button>
      </div>

      {protocol.groundedNote && (
        <p className="px-4 pt-2.5 text-[12.5px] italic text-sage-700/80">{protocol.groundedNote}</p>
      )}
      {protocol.fallbackNote && (
        <p className="px-4 pt-2.5 text-[12.5px] text-amber-500/90">{protocol.fallbackNote}</p>
      )}

      {/* footer — full bench escape hatch + hardware chips */}
      <div className="mt-3 flex items-center gap-2 border-t border-line/70 px-4 py-2.5">
        <button
          onClick={onExpand}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-medium text-muted transition-colors hover:bg-black/[0.02] hover:text-ink"
        >
          <Maximize2 className="size-3.5" strokeWidth={2} />
          Open full bench
        </button>
        {chips.length > 0 && (
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <Boxes className="size-3.5 shrink-0 text-faint" strokeWidth={2} />
            {chips.map((c) => (
              <span
                key={c}
                className="truncate rounded-full bg-ink/[0.05] px-2 py-0.5 text-[11px] font-medium text-muted"
              >
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

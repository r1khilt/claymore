import { useEffect, useRef, useState } from 'react'
import { deriveRun, type Protocol, type RunState } from '@/lib/protocol'

export interface RunPlayer {
  index: number // -1 = idle (nothing run yet)
  total: number
  playing: boolean
  speed: number
  state: RunState
  toggle: () => void
  restart: () => void
  next: () => void
  prev: () => void
  seek: (i: number) => void
  cycleSpeed: () => void
}

const SPEEDS = [1, 2, 4]
const STEP_MS = 640

/** Steps a protocol run forward over time; state is derived deterministically so
 *  scrubbing / stepping / speed changes all just work. */
export function useRunPlayer(protocol: Protocol): RunPlayer {
  const total = protocol.steps.length
  const [index, setIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    setIndex(-1)
    setPlaying(false)
  }, [protocol.id])

  useEffect(() => {
    if (!playing) return
    if (index >= total - 1) {
      setPlaying(false)
      return
    }
    timer.current = window.setTimeout(() => setIndex((i) => Math.min(total - 1, i + 1)), STEP_MS / speed)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [playing, index, speed, total])

  const state = deriveRun(protocol, index)

  return {
    index,
    total,
    playing,
    speed,
    state,
    toggle: () =>
      setPlaying((p) => {
        if (!p && index >= total - 1) setIndex(-1)
        return !p
      }),
    restart: () => {
      setPlaying(false)
      setIndex(-1)
    },
    next: () => setIndex((i) => Math.min(total - 1, i + 1)),
    prev: () => setIndex((i) => Math.max(-1, i - 1)),
    seek: (i: number) => setIndex(Math.max(-1, Math.min(total - 1, i))),
    cycleSpeed: () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]),
  }
}

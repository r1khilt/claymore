import { motion } from 'framer-motion'
import {
  DECK_W,
  DECK_H,
  slotRect,
  wellCenter,
  wellToRC,
  gridFor,
  type Labware,
  type Protocol,
  type RunState,
  type Step,
} from '@/lib/protocol'

const PLATE_BG = '#eceae2'
const SLOT_BG = '#f5f4ef'
const SLOT_LINE = '#d4d1c7'
const WELL_LINE = '#c8ccc2'
const INK = '#33352f'
const RAIL_X = 20

function liquidColor(p: Protocol): string {
  return p.id === 'serial' ? '#d99a54' : '#57a07b'
}

function Slot({ slot }: { slot: number }) {
  const r = slotRect(slot)
  const trash = slot === 12
  return (
    <g>
      <rect
        x={r.x}
        y={r.y}
        width={r.w}
        height={r.h}
        rx={9}
        fill={trash ? '#e7e5dd' : SLOT_BG}
        stroke={SLOT_LINE}
        strokeWidth={1}
      />
      {trash ? (
        <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 4} textAnchor="middle" fontSize={11} fill="#a2a498">
          Trash
        </text>
      ) : (
        <text x={r.x + 8} y={r.y + 15} fontSize={10} fill="#b3b5a9" fontWeight={600}>
          {slot}
        </text>
      )}
    </g>
  )
}

function LabwareView({
  lab,
  fills,
  liquid,
}: {
  lab: Labware
  fills: Record<string, number>
  liquid: string
}) {
  const { rows, cols } = gridFor(lab.kind)

  if (lab.kind === 'reservoir_12') {
    return (
      <g>
        {Array.from({ length: 12 }).map((_, c) => {
          const g = wellCenter(lab.slot, lab.kind, 0, c)
          const r = slotRect(lab.slot)
          return (
            <rect
              key={c}
              x={g.x - g.rx * 1.1}
              y={r.y + 8}
              width={g.rx * 2.2}
              height={r.h - 16}
              rx={3}
              fill="#dce9f1"
              stroke="#bcd3e2"
              strokeWidth={0.8}
            />
          )
        })}
      </g>
    )
  }

  // 96 grid (tiprack or well plate)
  const tiprack = lab.kind === 'tiprack_96'
  return (
    <g>
      {Array.from({ length: rows }).map((_, row) =>
        Array.from({ length: cols }).map((_, col) => {
          const g = wellCenter(lab.slot, lab.kind, row, col)
          const key = `${lab.id}:${'ABCDEFGH'[row]}${col + 1}`
          const vol = fills[key] ?? 0
          const frac = Math.min(1, vol / 100)
          return (
            <g key={key}>
              <circle
                cx={g.x}
                cy={g.y}
                r={g.rx}
                fill={tiprack ? '#e9ece5' : '#fbfbf8'}
                stroke={tiprack ? '#c3c8bd' : WELL_LINE}
                strokeWidth={0.9}
              />
              {!tiprack && (
                <circle
                  cx={g.x}
                  cy={g.y}
                  r={g.rx * 0.82}
                  fill={liquid}
                  style={{ transition: 'opacity 0.35s ease, r 0.35s ease' }}
                  opacity={vol > 0 ? 0.35 + 0.55 * frac : 0}
                />
              )}
            </g>
          )
        }),
      )}
    </g>
  )
}

function targetWells(p: Protocol, step: Step | null) {
  if (!step || !step.labwareId || !step.well) return []
  const lab = p.deck.labware.find((l) => l.id === step.labwareId)
  if (!lab || lab.kind === 'reservoir_12') return []
  const { row, col } = wellToRC(step.well)
  const multi = p.deck.pipette.channels === 8
  const rowList = multi ? [0, 1, 2, 3, 4, 5, 6, 7] : [row]
  return rowList.map((r) => wellCenter(lab.slot, lab.kind, r, col))
}

function Pipette({ protocol, state }: { protocol: Protocol; state: RunState }) {
  const { pos, hasTip, current, dipping } = state
  const multi = protocol.deck.pipette.channels === 8
  const rings = targetWells(protocol, current)
  return (
    <g>
      {/* active-well highlight */}
      {rings.map((g, i) => (
        <circle
          key={i}
          cx={g.x}
          cy={g.y}
          r={g.rx + 2}
          fill="none"
          stroke="#3f7d5c"
          strokeWidth={1.4}
          opacity={0.7}
        />
      ))}

      {/* gantry rail (fixed) */}
      <rect x={RAIL_X} y={2} width={DECK_W - RAIL_X * 2} height={5} rx={2.5} fill="#cbc8be" />

      {/* mount arm (gantry -> carriage) */}
      <motion.rect
        y={4}
        width={4}
        fill="#bcb9af"
        initial={false}
        animate={{ x: pos.x - 2, height: Math.max(0, pos.y - 4) }}
        transition={{ type: 'spring', stiffness: 150, damping: 20, mass: 0.6 }}
      />

      {/* carriage */}
      <motion.g
        initial={false}
        animate={{ x: pos.x, y: pos.y }}
        transition={{ type: 'spring', stiffness: 150, damping: 20, mass: 0.6 }}
      >
        <ellipse cx={0} cy={4} rx={16} ry={5} fill="#000" opacity={0.1} />
        <rect x={-13} y={-30} width={26} height={multi ? 34 : 28} rx={6} fill={INK} />
        <rect x={-13} y={-30} width={26} height={7} rx={6} fill="#3f7d5c" />
        {/* channel dots */}
        {Array.from({ length: multi ? 8 : 1 }).map((_, i) => (
          <circle
            key={i}
            cx={multi ? -8 + (i % 2) * 5 : 0}
            cy={multi ? -22 + Math.floor(i / 2) * 6 : -14}
            r={1.5}
            fill="#8bb79b"
          />
        ))}
        {/* tip */}
        {hasTip && (
          <path
            d={`M -3 ${multi ? 4 : 2} L 3 ${multi ? 4 : 2} L 1 ${multi ? 12 : 10} L -1 ${multi ? 12 : 10} Z`}
            fill="#c9ccc3"
          />
        )}
        {/* dispense droplet */}
        {dipping && current?.kind === 'dispense' && (
          <motion.circle
            key={state.index}
            cx={0}
            r={2}
            fill="#57a07b"
            initial={{ opacity: 0.9, cy: 8 }}
            animate={{ opacity: 0, cy: 16 }}
            transition={{ duration: 0.5 }}
          />
        )}
      </motion.g>
    </g>
  )
}

export function Deck2D({
  protocol,
  state,
  preview,
}: {
  protocol: Protocol
  state?: RunState
  preview?: boolean
}) {
  const liquid = liquidColor(protocol)
  const fills = state?.fills ?? {}
  return (
    <svg
      viewBox={`0 0 ${DECK_W} ${DECK_H}`}
      className="h-full w-full"
      style={{ overflow: 'visible' }}
      role="img"
      aria-label={`${protocol.deck.robot} deck`}
    >
      <rect x={0} y={0} width={DECK_W} height={DECK_H} rx={16} fill={PLATE_BG} />
      {Array.from({ length: 12 }).map((_, i) => (
        <Slot key={i} slot={i + 1} />
      ))}
      {protocol.deck.labware.map((lab) => (
        <LabwareView key={lab.id} lab={lab} fills={fills} liquid={liquid} />
      ))}
      {!preview && state && <Pipette protocol={protocol} state={state} />}
    </svg>
  )
}

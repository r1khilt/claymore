/**
 * The 2D deck engine — a high-fidelity SVG rendering of any scene the agent authors.
 *
 * Nothing here is experiment-specific: it draws whatever labware / modules / liquids / gantry the
 * scene declares, switching on the catalog's `shape`/`category`/behaviour flags. Liquids are tinted
 * per reagent and scaled by volume; tip racks deplete; modules heat / shake / pellet / read; the
 * gripper carries labware between slots. It renders a static snapshot (preview) or an animated run.
 */
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { labwareDef, moduleDef, type LabwareDef, type ModuleDef } from '@/lib/hardware'
import {
  deckGeom,
  slotRect,
  wellCenter,
  wellToRC,
  SLOT_W,
  SLOT_H,
  type DeckGeom,
  type Rect,
} from '@/lib/deck'
import {
  deriveRun,
  liquidColor,
  stepWells,
  primaryPipette,
  type DeckModule,
  type Labware,
  type ModuleRun,
  type Protocol,
  type RunState,
  type Step,
} from '@/lib/protocol'

const C = {
  plate: '#e8e6dd',
  plateEdge: '#d9d6cc',
  slot: '#f4f2ec',
  slotLine: '#d6d3c8',
  wellEmpty: '#fbfbf8',
  wellLine: '#cdd0c6',
  tip: '#e7eae2',
  tipLine: '#c3c8bd',
  tipUsed: '#efeee9',
  ink: '#33352f',
  label: '#8f9186',
  faint: '#b3b5a9',
}

/** Visible fill fraction — caps the reference volume so small transfers still read as liquid. */
function fillFrac(def: LabwareDef, vol: number): number {
  if (vol <= 0) return 0
  const ref = Math.min(def.wellUl ?? 300, 420)
  return Math.max(0.16, Math.min(1, vol / ref))
}

/* ------------------------------------------------------------------ deck body -- */

function DeckPlate({ geom }: { geom: DeckGeom }) {
  return (
    <g>
      <rect x={0} y={0} width={geom.width} height={geom.height} rx={18} fill={C.plate} stroke={C.plateEdge} strokeWidth={1.5} />
      {geom.slots.map((slot) => {
        const r = slotRect(geom, slot)
        const staging = geom.staging.has(slot)
        const trash = geom.trashSlot === slot
        return (
          <g key={slot}>
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={10}
              fill={trash ? '#eae8e0' : staging ? 'transparent' : C.slot}
              stroke={C.slotLine}
              strokeWidth={1}
              strokeDasharray={staging ? '4 4' : undefined}
              opacity={staging ? 0.75 : 1}
            />
            {trash ? (
              <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 4} textAnchor="middle" fontSize={11} fill={C.faint}>
                Trash
              </text>
            ) : (
              <text x={r.x + 8} y={r.y + 15} fontSize={9.5} fill={C.faint} fontWeight={600}>
                {slot}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/* -------------------------------------------------------------------- modules -- */

function ModuleView({ geom, mod, run }: { geom: DeckGeom; mod: DeckModule; run?: ModuleRun }) {
  const r = slotRect(geom, mod.slot)
  const def = moduleDef(mod.kind)
  const active = run?.active
  const heat = active && (def.behavior.heats || def.behavior.reads)
  return (
    <g transform={`translate(${r.x} ${r.y})`}>
      {/* heat/active glow */}
      {heat && (
        <motion.rect
          x={-3}
          y={-3}
          width={r.w + 6}
          height={r.h + 6}
          rx={12}
          fill="none"
          stroke={def.tint}
          strokeWidth={2}
          initial={{ opacity: 0.15 }}
          animate={{ opacity: [0.15, 0.5, 0.15] }}
          transition={{ duration: 1.8, repeat: Infinity }}
        />
      )}
      <rect x={2} y={2} width={r.w - 4} height={r.h - 4} rx={9} fill={def.tint} opacity={0.14} stroke={def.tint} strokeOpacity={0.34} strokeWidth={1.1} />
      {/* housing chrome per behaviour */}
      <ModuleChrome def={def} run={run} w={r.w} h={r.h} />
      {/* badge */}
      <rect x={6} y={6} width={30} height={13} rx={3} fill={def.tint} opacity={0.92} />
      <text x={21} y={15.4} textAnchor="middle" fontSize={8} fontWeight={700} fill="#fff">
        {def.short}
      </text>
      {(run?.state ?? mod.state) && (
        <text x={r.w - 6} y={r.h - 6} textAnchor="end" fontSize={7.5} fill={def.tint} fontWeight={600}>
          {run?.state ?? mod.state}
        </text>
      )}
    </g>
  )
}

function ModuleChrome({ def, run, w, h }: { def: ModuleDef; run?: ModuleRun; w: number; h: number }) {
  const b = def.behavior
  if (b.lid) {
    // thermocycler / reader lid — lifts up + back and thins when open
    const open = run?.lidOpen
    return (
      <g>
        {b.reads && run?.reading && (
          <motion.rect x={w / 2 - 1.5} y={12} width={3} height={h - 24} fill="#ffe58a" initial={{ opacity: 0 }} animate={{ opacity: [0.2, 0.9, 0.2] }} transition={{ duration: 1, repeat: Infinity }} />
        )}
        <motion.g initial={false} animate={{ y: open ? -9 : 0, scaleY: open ? 0.5 : 1 }} transition={{ type: 'spring', stiffness: 130, damping: 17 }} style={{ transformOrigin: 'top' }}>
          <rect x={8} y={4} width={w - 16} height={h - 8} rx={7} fill={def.tint} opacity={open ? 0.24 : 0.42} stroke={def.tint} strokeOpacity={0.5} strokeWidth={1} />
          <rect x={8} y={4} width={w - 16} height={5} rx={2.5} fill={def.tint} opacity={0.7} />
        </motion.g>
      </g>
    )
  }
  if (b.shakes) {
    // heater-shaker clamp corners
    return (
      <g stroke={def.tint} strokeWidth={2} strokeOpacity={0.55} fill="none">
        <path d={`M 8 14 L 8 8 L 14 8`} />
        <path d={`M ${w - 14} 8 L ${w - 8} 8 L ${w - 8} 14`} />
        <path d={`M 8 ${h - 14} L 8 ${h - 8} L 14 ${h - 8}`} />
        <path d={`M ${w - 14} ${h - 8} L ${w - 8} ${h - 8} L ${w - 8} ${h - 14}`} />
      </g>
    )
  }
  if (b.magnet) {
    return (
      <g>
        {[0.3, 0.5, 0.7].map((f, i) => (
          <line key={i} x1={w * f} y1={h - 6} x2={w * f} y2={h - 14} stroke={def.tint} strokeWidth={2} strokeOpacity={run?.magnet ? 0.9 : 0.3} />
        ))}
      </g>
    )
  }
  if (b.cools || b.heats) {
    // temperature module ramp fins
    return (
      <g stroke={def.tint} strokeWidth={1.2} strokeOpacity={0.4}>
        {[0.35, 0.5, 0.65].map((f, i) => (
          <line key={i} x1={10} y1={h * f} x2={w - 10} y2={h * f} />
        ))}
      </g>
    )
  }
  return null
}

/* -------------------------------------------------------------------- labware -- */

function WellsView({ lab, def, fills, used, magnet }: { lab: Labware; def: LabwareDef; fills: Record<string, WellRef>; used: Record<string, boolean>; magnet: boolean }) {
  const r0 = slotRect0()
  const tips = def.category === 'tips'
  const square = def.wellShape === 'square'
  const nodes: ReactNode[] = []
  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      const g = wellCenter(r0, def, row, col)
      const well = `${'ABCDEFGHIJKLMNOP'[row]}${col + 1}`
      const key = `${lab.id}:${well}`
      const fill = fills[key]
      if (tips) {
        const gone = used[well]
        nodes.push(
          <g key={key} opacity={gone ? 0.5 : 1}>
            <circle cx={g.x} cy={g.y} r={g.rx} fill={gone ? C.tipUsed : C.tip} stroke={C.tipLine} strokeWidth={0.8} />
            {!gone && <circle cx={g.x} cy={g.y} r={g.rx * 0.5} fill="none" stroke={C.tipLine} strokeWidth={0.7} />}
          </g>,
        )
        continue
      }
      const frac = fill ? fillFrac(def, fill.volume) : 0
      const color = fill ? fill.color : undefined
      if (square) {
        const s = g.rx * 1.7
        nodes.push(
          <g key={key}>
            <rect x={g.x - s / 2} y={g.y - s / 2} width={s} height={s} rx={1.5} fill={C.wellEmpty} stroke={C.wellLine} strokeWidth={0.7} />
            {frac > 0 && color && <rect x={g.x - (s / 2) * frac} y={g.y - (s / 2) * frac} width={s * frac} height={s * frac} rx={1} fill={color} opacity={0.85} style={{ transition: 'all .35s ease' }} />}
            {magnet && frac > 0 && <circle cx={g.x + s * 0.28} cy={g.y} r={s * 0.16} fill="#5a4a2e" opacity={0.8} />}
          </g>,
        )
      } else {
        nodes.push(
          <g key={key}>
            <circle cx={g.x} cy={g.y} r={g.rx} fill={C.wellEmpty} stroke={C.wellLine} strokeWidth={0.85} />
            {frac > 0 && color && (
              <>
                <circle cx={g.x} cy={g.y} r={g.rx * (0.5 + 0.45 * frac)} fill={color} opacity={0.86} style={{ transition: 'r .35s ease, opacity .35s ease' }} />
                {/* bead pellet when a magnet is engaged under this plate */}
                {magnet && <circle cx={g.x + g.rx * 0.55} cy={g.y} r={g.rx * 0.28} fill="#5a4a2e" opacity={0.8} />}
              </>
            )}
          </g>,
        )
      }
    }
  }
  return <g>{nodes}</g>
}

function ReservoirView({ def, fills, labId }: { def: LabwareDef; fills: Record<string, WellRef>; labId: string }) {
  const r0 = slotRect0()
  return (
    <g>
      {Array.from({ length: def.cols }).map((_, c) => {
        const g = wellCenter(r0, def, 0, c)
        const chW = g.rx * (def.cols > 1 ? 2.0 : 4)
        const top = 8
        const bot = r0.h - 8
        const well = `A${c + 1}`
        const fill = fills[`${labId}:${well}`]
        const frac = fill ? fillFrac(def, fill.volume) : 0
        const h = (bot - top) * frac
        return (
          <g key={c}>
            <rect x={g.x - chW / 2} y={top} width={chW} height={bot - top} rx={3} fill="#eef4f7" stroke="#c6d7e0" strokeWidth={0.8} />
            {frac > 0 && fill && <rect x={g.x - chW / 2} y={bot - h} width={chW} height={h} rx={3} fill={fill.color} opacity={0.82} style={{ transition: 'all .35s ease' }} />}
          </g>
        )
      })}
    </g>
  )
}

function TubesView({ lab, def, fills }: { lab: Labware; def: LabwareDef; fills: Record<string, WellRef> }) {
  const r0 = slotRect0()
  const nodes: ReactNode[] = []
  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      const g = wellCenter(r0, def, row, col)
      const well = `${'ABCDEFGH'[row]}${col + 1}`
      const fill = fills[`${lab.id}:${well}`]
      nodes.push(
        <g key={well}>
          <circle cx={g.x} cy={g.y} r={g.rx} fill="#f0efe9" stroke="#c9ccc2" strokeWidth={1} />
          <circle cx={g.x} cy={g.y} r={g.rx * 0.72} fill="#e7e6df" stroke="#d4d6cc" strokeWidth={0.6} />
          {fill && <circle cx={g.x} cy={g.y} r={g.rx * 0.6} fill={fill.color} opacity={0.85} />}
        </g>,
      )
    }
  }
  return <g>{nodes}</g>
}

function StripsView({ lab, def, fills }: { lab: Labware; def: LabwareDef; fills: Record<string, WellRef> }) {
  const r0 = slotRect0()
  return (
    <g>
      {Array.from({ length: def.cols }).map((_, col) => {
        const gTop = wellCenter(r0, def, 0, col)
        const gBot = wellCenter(r0, def, def.rows - 1, col)
        return (
          <g key={col}>
            <rect x={gTop.x - gTop.rx * 1.15} y={gTop.y - gTop.rx * 1.3} width={gTop.rx * 2.3} height={gBot.y - gTop.y + gTop.rx * 2.6} rx={gTop.rx} fill="#eceff2" stroke="#c9d2d8" strokeWidth={0.7} />
            {Array.from({ length: def.rows }).map((_, row) => {
              const g = wellCenter(r0, def, row, col)
              const fill = fills[`${lab.id}:${'ABCDEFGH'[row]}${col + 1}`]
              return (
                <g key={row}>
                  <circle cx={g.x} cy={g.y} r={g.rx * 0.85} fill={C.wellEmpty} stroke={C.wellLine} strokeWidth={0.6} />
                  {fill && <circle cx={g.x} cy={g.y} r={g.rx * 0.6} fill={fill.color} opacity={0.85} />}
                </g>
              )
            })}
          </g>
        )
      })}
    </g>
  )
}

interface WellRef {
  color: string
  volume: number
}

function LabwareBody({ lab, fills, used, magnet }: { lab: Labware; fills: Record<string, WellRef>; used: Record<string, boolean>; magnet: boolean }) {
  const def = labwareDef(lab.kind)
  const r0 = slotRect0()
  const inner = lab.onModule ? 4 : 3
  return (
    <g>
      {/* labware body plate */}
      <rect x={inner} y={inner} width={r0.w - inner * 2} height={r0.h - inner * 2} rx={7} fill={def.tint ?? '#f4f3ef'} stroke="#00000012" strokeWidth={1} />
      {def.category === 'tips' && <rect x={inner} y={inner} width={r0.w - inner * 2} height={r0.h - inner * 2} rx={7} fill="none" stroke={C.tipLine} strokeWidth={0.8} strokeOpacity={0.5} />}
      {def.shape === 'reservoir' ? (
        <ReservoirView def={def} fills={fills} labId={lab.id} />
      ) : def.shape === 'tubes' ? (
        <TubesView lab={lab} def={def} fills={fills} />
      ) : def.shape === 'strips' ? (
        <StripsView lab={lab} def={def} fills={fills} />
      ) : def.shape === 'wells' ? (
        <WellsView lab={lab} def={def} fills={fills} used={used} magnet={magnet} />
      ) : def.shape === 'trash' ? (
        <g>
          {Array.from({ length: 4 }).map((_, i) => (
            <line key={i} x1={12 + i * 8} y1={12} x2={12 + i * 8} y2={r0.h - 12} stroke={C.faint} strokeWidth={1} strokeOpacity={0.5} />
          ))}
        </g>
      ) : (
        <rect x={10} y={10} width={r0.w - 20} height={r0.h - 20} rx={5} fill="#00000008" />
      )}
    </g>
  )
}

/** A slot-shaped rect at origin (labware groups are positioned by their parent). */
function slotRect0(): Rect {
  return { x: 0, y: 0, w: SLOT_W, h: SLOT_H }
}

function LabwareView({ geom, lab, slot, fills, used, magnet, label }: { geom: DeckGeom; lab: Labware; slot: string; fills: Record<string, WellRef>; used: Record<string, boolean>; magnet: boolean; label: boolean }) {
  const r = slotRect(geom, slot)
  return (
    <motion.g initial={false} animate={{ x: r.x, y: r.y }} transition={{ type: 'spring', stiffness: 120, damping: 18 }}>
      <LabwareBody lab={lab} fills={fills} used={used} magnet={magnet} />
      {label && lab.label && (
        <text x={r.w / 2} y={r.h - 5} textAnchor="middle" fontSize={8} fill={C.label} fontWeight={600}>
          {lab.label}
        </text>
      )}
    </motion.g>
  )
}

/* -------------------------------------------------------------------- gantry --- */

function Gantry({ protocol, geom, state }: { protocol: Protocol; geom: DeckGeom; state: RunState }) {
  const { pos, hasTip, tipLiquid, current, dipping, gripping } = state
  const pipette = primaryPipette(protocol)
  const channels = pipette.channels
  const multi = channels === 8
  const big = channels === 96
  const tipColor = tipLiquid ? liquidColor(protocol, tipLiquid) : '#c9ccc3'
  const rings = current ? stepWells(protocol, current, channels).map((w) => wellRing(protocol, geom, state, current, w)) : []
  const railX = 16
  const headW = big ? 46 : multi ? 30 : 22
  const headH = big ? 40 : multi ? 34 : 26

  return (
    <g>
      {/* target-well highlight rings */}
      {rings.map((g, i) => g && (
        <circle key={i} cx={g.x} cy={g.y} r={g.rx + 2} fill="none" stroke="#3f7d5c" strokeWidth={1.4} opacity={0.7} />
      ))}

      {/* gantry rail */}
      <rect x={railX} y={2} width={geom.width - railX * 2} height={5} rx={2.5} fill="#c8c5bb" />

      {/* arm from rail down to the carriage */}
      <motion.rect y={4} width={4} fill="#bbb8ae" initial={false} animate={{ x: pos.x - 2, height: Math.max(0, pos.y - 4) }} transition={{ type: 'spring', stiffness: 150, damping: 20, mass: 0.6 }} />

      {/* gripper claw while carrying labware */}
      {gripping && (
        <motion.g initial={false} animate={{ x: pos.x, y: pos.y }} transition={{ type: 'spring', stiffness: 120, damping: 18 }}>
          <path d={`M -26 -6 L -20 6 M 26 -6 L 20 6`} stroke="#8a8b80" strokeWidth={2.4} fill="none" strokeLinecap="round" />
        </motion.g>
      )}

      {/* carriage + pipette head */}
      <motion.g initial={false} animate={{ x: pos.x, y: pos.y }} transition={{ type: 'spring', stiffness: 150, damping: 20, mass: 0.6 }}>
        <ellipse cx={0} cy={5} rx={headW * 0.55} ry={5} fill="#000" opacity={0.1} />
        <rect x={-headW / 2} y={-34} width={headW} height={headH} rx={6} fill={C.ink} />
        <rect x={-headW / 2} y={-34} width={headW} height={7} rx={6} fill="#3f7d5c" />
        {/* channel nozzles */}
        {big ? (
          <rect x={-headW / 2 + 4} y={-2} width={headW - 8} height={7} rx={2} fill="#5a5c54" />
        ) : (
          Array.from({ length: multi ? 8 : 1 }).map((_, i) => (
            <circle key={i} cx={multi ? -9 + (i % 2) * 6 : 0} cy={multi ? -24 + Math.floor(i / 2) * 6 : -16} r={1.5} fill="#8bb79b" />
          ))
        )}
        {/* attached tip(s), coloured by aspirated liquid */}
        {hasTip &&
          (big ? (
            <rect x={-headW / 2 + 5} y={4} width={headW - 10} height={9} rx={2} fill={tipColor} opacity={0.9} />
          ) : (
            Array.from({ length: multi ? 8 : 1 }).map((_, i) => {
              const x = multi ? -9 + (i % 2) * 6 : 0
              const y = multi ? 2 : 2
              return <path key={i} d={`M ${x - 2.5} ${y} L ${x + 2.5} ${y} L ${x + 1} ${y + 10} L ${x - 1} ${y + 10} Z`} fill={tipColor} />
            })
          ))}
        {/* dispense droplet */}
        {dipping && current?.kind === 'dispense' && (
          <motion.circle key={state.index} cx={0} r={2} fill={tipColor} initial={{ opacity: 0.9, cy: 10 }} animate={{ opacity: 0, cy: 18 }} transition={{ duration: 0.5 }} />
        )}
      </motion.g>
    </g>
  )
}

function wellRing(protocol: Protocol, geom: DeckGeom, state: RunState, step: Step, well: string) {
  const lab = protocol.deck.labware.find((l) => l.id === step.labwareId)
  if (!lab) return null
  const def = labwareDef(lab.kind)
  if (def.shape === 'reservoir' || def.shape === 'trash') return null
  const slot = state.slotOf[lab.id] ?? lab.slot
  const r = slotRect(geom, slot)
  const { row, col } = wellToRC(well)
  const g = wellCenter(r, def, row, col)
  return g
}

/* --------------------------------------------------------------------- root ---- */

export function Deck2D({ protocol, state, preview }: { protocol: Protocol; state?: RunState; preview?: boolean }) {
  const geom = deckGeom(protocol.deck.robot)
  const s = state ?? deriveRun(protocol, -1)

  // Precompute per-labware coloured fills so the well components stay dumb.
  const colored: Record<string, WellRef> = {}
  for (const [k, v] of Object.entries(s.fills)) colored[k] = { color: liquidColor(protocol, v.liquid), volume: v.volume }

  return (
    <svg viewBox={`0 0 ${geom.width} ${geom.height}`} className="h-full w-full" style={{ overflow: 'visible' }} role="img" aria-label={`${protocol.platformLabel} deck`}>
      <DeckPlate geom={geom} />
      {protocol.deck.modules.map((m) => (
        <ModuleView key={m.id} geom={geom} mod={m} run={s.modules[m.id]} />
      ))}
      {protocol.deck.labware.map((lab) => {
        // Magnet pellet keys off the module under the labware's CURRENT slot (a plate can be
        // gripper-moved onto the magnetic block), not the static onModule placement.
        const slot = s.slotOf[lab.id] ?? lab.slot
        const modHere = protocol.deck.modules.find((m) => m.slot === slot)
        const magnet = modHere ? !!s.modules[modHere.id]?.magnet : false
        return (
          <LabwareView
            key={lab.id}
            geom={geom}
            lab={lab}
            slot={slot}
            fills={colored}
            used={s.tipsUsed[lab.id] ?? {}}
            magnet={magnet}
            label={!preview}
          />
        )
      })}
      {!preview && state && <Gantry protocol={protocol} geom={geom} state={state} />}
    </svg>
  )
}

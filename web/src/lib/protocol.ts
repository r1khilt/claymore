/**
 * Opentrons protocol model + geometry + a scene generator. A protocol is a deck
 * of numbered slots holding labware (optionally on modules) plus an ordered list
 * of pipetting steps. Everything is validated against the supported-hardware
 * catalog in hardware.ts — `generateScene` refuses anything Opentrons can't do.
 * The 2D/3D deck renders any spec produced here, so scenes aren't hard-coded.
 */
import {
  LABWARE,
  PIPETTES,
  unsupportedReason,
  type LabwareKind,
  type ModuleKind,
  type Robot,
} from './hardware'

export type { LabwareKind, ModuleKind, Robot }

export interface Labware {
  id: string
  kind: LabwareKind
  slot: number
  loadName: string
  display: string
}

export interface DeckModule {
  id: string
  kind: ModuleKind
  slot: number
  state?: string
}

export interface PipetteSpec {
  mount: 'left' | 'right'
  model: string
  display: string
  channels: 1 | 8 | 96
}

export interface DeckLayout {
  robot: Robot
  labware: Labware[]
  modules: DeckModule[]
  pipette: PipetteSpec
}

export type StepKind = 'pick_up_tip' | 'aspirate' | 'dispense' | 'drop_tip' | 'move'

export interface Step {
  kind: StepKind
  labwareId?: string
  well?: string
  volume?: number
  label: string
}

export interface Protocol {
  id: string
  name: string
  description: string
  deck: DeckLayout
  steps: Step[]
  python: string
  groundedNote?: string
}

/* --------------------------------------------------------------- geometry -- */

export const DECK = { padX: 16, padY: 16, colW: 120, rowH: 86, gapX: 12, gapY: 12 }
export const DECK_W = DECK.padX * 2 + 3 * DECK.colW + 2 * DECK.gapX // 416
export const DECK_H = DECK.padY * 2 + 4 * DECK.rowH + 3 * DECK.gapY // 412

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function slotRect(slot: number): Rect {
  const idx = slot - 1
  const col = idx % 3
  const rowFromBottom = Math.floor(idx / 3)
  return {
    x: DECK.padX + col * (DECK.colW + DECK.gapX),
    y: DECK.padY + (3 - rowFromBottom) * (DECK.rowH + DECK.gapY),
    w: DECK.colW,
    h: DECK.rowH,
  }
}

export function gridFor(kind: LabwareKind): { rows: number; cols: number } {
  const def = LABWARE[kind]
  return { rows: def.rows, cols: def.cols }
}

export function isReservoir(kind: LabwareKind): boolean {
  return kind === 'reservoir_12' || kind === 'reservoir_1'
}

export interface WellGeo {
  x: number
  y: number
  rx: number
  ry: number
}

export function wellCenter(slot: number, kind: LabwareKind, row: number, col: number): WellGeo {
  const r = slotRect(slot)
  const padIn = 9
  const { rows, cols } = gridFor(kind)
  const gx = (r.w - 2 * padIn) / cols
  const gy = (r.h - 2 * padIn) / rows
  return {
    x: r.x + padIn + (col + 0.5) * gx,
    y: r.y + padIn + (row + 0.5) * gy,
    rx: Math.min(gx, gy) * 0.36,
    ry: Math.min(gx, gy) * 0.36,
  }
}

const LETTERS = 'ABCDEFGHIJKLMNOP'

export function wellToRC(name: string): { row: number; col: number } {
  const row = name.charCodeAt(0) - 65
  const col = Number.parseInt(name.slice(1), 10) - 1
  return { row: Number.isNaN(row) ? 0 : row, col: Number.isNaN(col) ? 0 : col }
}

export interface Point {
  x: number
  y: number
}

export const HOME_POS: Point = { x: DECK_W / 2, y: 6 }

export function trashPos(): Point {
  const r = slotRect(12)
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

function findLabware(p: Protocol, id: string): Labware | undefined {
  return p.deck.labware.find((l) => l.id === id)
}

export function wellPosFor(p: Protocol, labwareId: string, well: string, channels: number): Point {
  const lab = findLabware(p, labwareId)
  if (!lab) return HOME_POS
  const { row, col } = wellToRC(well)
  const multi = channels >= 8 && !isReservoir(lab.kind)
  if (multi) {
    const { rows } = gridFor(lab.kind)
    const top = wellCenter(lab.slot, lab.kind, 0, col)
    const bot = wellCenter(lab.slot, lab.kind, rows - 1, col)
    return { x: top.x, y: (top.y + bot.y) / 2 }
  }
  const c = wellCenter(lab.slot, lab.kind, row, col)
  return { x: c.x, y: c.y }
}

/* --------------------------------------------------------------- run state -- */

export interface RunState {
  index: number
  pos: Point
  hasTip: boolean
  fills: Record<string, number>
  current: Step | null
  dipping: boolean
}

function applyFill(fills: Record<string, number>, p: Protocol, s: Step, channels: number): void {
  if (!s.labwareId || !s.well) return
  const lab = findLabware(p, s.labwareId)
  if (!lab) return
  const { row, col } = wellToRC(s.well)
  const { rows } = gridFor(lab.kind)
  const multi = channels >= 8 && !isReservoir(lab.kind)
  const rowList = multi ? Array.from({ length: rows }, (_, i) => i) : [row]
  for (const r of rowList) {
    const key = `${lab.id}:${LETTERS[r]}${col + 1}`
    fills[key] = (fills[key] ?? 0) + (s.volume ?? 0)
  }
}

export function deriveRun(p: Protocol, index: number): RunState {
  const fills: Record<string, number> = {}
  let hasTip = false
  let pos: Point = HOME_POS
  let current: Step | null = null
  let dipping = false
  const channels = p.deck.pipette.channels
  const last = Math.min(index, p.steps.length - 1)
  for (let i = 0; i <= last; i++) {
    const s = p.steps[i]
    current = s
    dipping = s.kind === 'aspirate' || s.kind === 'dispense'
    const wp = s.labwareId && s.well ? wellPosFor(p, s.labwareId, s.well, channels) : null
    switch (s.kind) {
      case 'pick_up_tip':
        hasTip = true
        if (wp) pos = wp
        break
      case 'drop_tip':
        hasTip = false
        pos = trashPos()
        break
      case 'aspirate':
        if (wp) pos = wp
        break
      case 'dispense':
        if (wp) pos = wp
        applyFill(fills, p, s, channels)
        break
      case 'move':
        if (wp) pos = wp
        break
    }
  }
  return { index: last, pos, hasTip, fills, current, dipping }
}

/* ------------------------------------------------------------- generator --- */

function lw(id: string, kind: LabwareKind, slot: number): Labware {
  return { id, kind, slot, loadName: LABWARE[kind].loadName, display: LABWARE[kind].display }
}

function pip(model: string, mount: 'left' | 'right' = 'right'): PipetteSpec {
  const def = PIPETTES.find((p) => p.model === model)!
  return { mount, model, display: def.display, channels: def.channels }
}

function header(name: string): string {
  return `from opentrons import protocol_api\n\nmetadata = {"protocolName": "${name}", "author": "Claymore", "apiLevel": "2.20"}\n\n\n`
}

function fillPlate(): Protocol {
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' }]
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 100, label: 'Aspirate 100 µL · reservoir A1' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 100, label: `Dispense 100 µL · plate column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  return {
    id: 'fill96',
    name: 'Fill a 96-well plate',
    description: '8-channel · 100 µL buffer into every well',
    deck: {
      robot: 'OT-2',
      pipette: pip('p300_multi_gen2'),
      modules: [],
      labware: [lw('tips', 'tiprack_96', 1), lw('res', 'reservoir_12', 2), lw('plate', 'wellplate_96', 3)],
    },
    steps,
    groundedNote: "Using Maya's Assay Buffer v3 — held under 2% DMSO so the thermal-shift baseline stays flat.",
    python: `${header('Fill 96-well plate')}def run(protocol: protocol_api.ProtocolContext):
    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", 2)
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 3)
    p300 = protocol.load_instrument("p300_multi_gen2", "right", tip_racks=[tips])

    p300.pick_up_tip()
    for column in plate.columns():
        p300.aspirate(100, reservoir["A1"])
        p300.dispense(100, column[0])
    p300.drop_tip()
`,
  }
}

function serialDilution(): Protocol {
  const steps: Step[] = [
    { kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up tip' },
    { kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 100, label: 'Aspirate 100 µL · reservoir (dye)' },
    { kind: 'dispense', labwareId: 'plate', well: 'A1', volume: 100, label: 'Dispense 100 µL · plate A1' },
  ]
  for (let c = 1; c <= 11; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'plate', well: `A${c}`, volume: 100, label: `Aspirate 100 µL · A${c}` })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c + 1}`, volume: 100, label: `Dispense 100 µL · A${c + 1}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tip' })
  return {
    id: 'serial',
    name: 'Serial dilution',
    description: 'Single-channel · 2× dilution across row A',
    deck: {
      robot: 'OT-2',
      pipette: pip('p300_single_gen2'),
      modules: [],
      labware: [lw('tips', 'tiprack_96', 1), lw('res', 'reservoir_12', 2), lw('plate', 'wellplate_96', 3)],
    },
    steps,
    python: `${header('Serial dilution')}def run(protocol: protocol_api.ProtocolContext):
    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", 2)
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 3)
    p300 = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tips])

    row = plate.rows()[0]
    p300.pick_up_tip()
    p300.transfer(100, reservoir["A1"], row[0], new_tip="never")
    for i in range(11):
        p300.transfer(100, row[i], row[i + 1], mix_after=(3, 50), new_tip="never")
    p300.drop_tip()
`,
  }
}

function pcrSetup(): Protocol {
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' }]
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'mm', well: 'A1', volume: 18, label: 'Aspirate 18 µL · master mix' })
    steps.push({ kind: 'dispense', labwareId: 'pcr', well: `A${c}`, volume: 18, label: `Dispense 18 µL · PCR column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'move', label: 'Thermocycler: 35 cycles (95/55/72 °C)' })
  return {
    id: 'pcr',
    name: 'PCR plate setup',
    description: '8-channel master-mix distribution → thermocycler',
    deck: {
      robot: 'OT-2',
      pipette: pip('p20_multi_gen2'),
      modules: [{ id: 'tc', kind: 'thermocycler', slot: 7, state: 'lid open' }],
      labware: [lw('tips', 'tiprack_96', 1), lw('mm', 'reservoir_12', 2), lw('pcr', 'pcr_96', 7)],
    },
    steps,
    groundedNote: 'Master mix from the shared stock; plate seats on the thermocycler for cycling.',
    python: `${header('PCR plate setup')}def run(protocol: protocol_api.ProtocolContext):
    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)
    master_mix = protocol.load_labware("nest_12_reservoir_15ml", 2)
    tc = protocol.load_module("thermocycler module gen2")
    pcr = tc.load_labware("nest_96_wellplate_100ul_pcr_full_skirt")
    p20 = protocol.load_instrument("p20_multi_gen2", "right", tip_racks=[tips])

    tc.open_lid()
    p20.pick_up_tip()
    for column in pcr.columns():
        p20.aspirate(18, master_mix["A1"])
        p20.dispense(18, column[0])
    p20.drop_tip()
    tc.close_lid()
    tc.set_lid_temperature(105)
    tc.execute_profile(
        steps=[{"temperature": 95, "hold_time_seconds": 15},
               {"temperature": 55, "hold_time_seconds": 15},
               {"temperature": 72, "hold_time_seconds": 20}],
        repetitions=35, block_max_volume=25)
    tc.open_lid()
`,
  }
}

function heaterShake(): Protocol {
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up tip' }]
  for (let i = 1; i <= 6; i++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 200, label: 'Aspirate 200 µL · resuspension buffer' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${i}`, volume: 200, label: `Dispense 200 µL · plate A${i}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tip' })
  steps.push({ kind: 'move', label: 'Heater-Shaker: 1000 rpm, 37 °C, 10 min' })
  return {
    id: 'heatshake',
    name: 'Resuspend & incubate',
    description: 'Add buffer, then shake at 37 °C on the Heater-Shaker',
    deck: {
      robot: 'OT-2',
      pipette: pip('p300_single_gen2'),
      modules: [{ id: 'hs', kind: 'heater_shaker', slot: 3, state: '1000 rpm · 37 °C' }],
      labware: [lw('tips', 'tiprack_96', 1), lw('res', 'reservoir_12', 2), lw('plate', 'wellplate_96', 3)],
    },
    steps,
    python: `${header('Resuspend and incubate')}def run(protocol: protocol_api.ProtocolContext):
    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", 2)
    hs = protocol.load_module("heaterShakerModuleV1", 3)
    plate = hs.load_labware("corning_96_wellplate_360ul_flat")
    p300 = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tips])

    hs.open_labware_latch()
    p300.pick_up_tip()
    for i in range(6):
        p300.transfer(200, reservoir["A1"], plate.wells()[i], new_tip="never")
    p300.drop_tip()
    hs.close_labware_latch()
    hs.set_and_wait_for_temperature(37)
    hs.set_and_wait_for_shake_speed(1000)
    protocol.delay(minutes=10)
    hs.deactivate_shaker()
`,
  }
}

function magCleanup(): Protocol {
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' }]
  for (let c = 1; c <= 6; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 50, label: 'Aspirate 50 µL · magnetic beads' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 50, label: `Dispense 50 µL beads · column ${c}` })
  }
  steps.push({ kind: 'move', label: 'Engage magnet · 5 min' })
  for (let c = 1; c <= 6; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'plate', well: `A${c}`, volume: 45, label: `Remove supernatant · column ${c}` })
    steps.push({ kind: 'drop_tip', label: 'Discard supernatant' })
    if (c < 6) steps.push({ kind: 'pick_up_tip', labwareId: 'tips', well: `A${c + 1}`, label: 'Pick up 8 tips' })
  }
  return {
    id: 'magclean',
    name: 'Magnetic bead cleanup',
    description: '8-channel SPRI cleanup on the Magnetic Module',
    deck: {
      robot: 'OT-2',
      pipette: pip('p300_multi_gen2'),
      modules: [{ id: 'mag', kind: 'magnetic', slot: 4, state: 'engaged' }],
      labware: [lw('tips', 'tiprack_96', 1), lw('res', 'reservoir_12', 2), lw('plate', 'deepwell_96', 4)],
    },
    steps,
    python: `${header('Magnetic bead cleanup')}def run(protocol: protocol_api.ProtocolContext):
    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)
    reagents = protocol.load_labware("nest_12_reservoir_15ml", 2)
    mag = protocol.load_module("magnetic module gen2", 4)
    plate = mag.load_labware("nest_96_wellplate_2ml_deep")
    p300 = protocol.load_instrument("p300_multi_gen2", "right", tip_racks=[tips])

    mag.disengage()
    p300.pick_up_tip()
    for column in plate.columns()[:6]:
        p300.aspirate(50, reagents["A1"])
        p300.dispense(50, column[0])
    p300.drop_tip()
    mag.engage()
    protocol.delay(minutes=5)
    for column in plate.columns()[:6]:
        p300.pick_up_tip()
        p300.aspirate(45, column[0])
        p300.drop_tip()
    mag.disengage()
`,
  }
}

interface Recipe {
  match: RegExp
  build: () => Protocol
}

const RECIPES: Recipe[] = [
  { match: /pcr|master ?mix|amplif|thermocycl|denatur|anneal/i, build: pcrSetup },
  { match: /bead|spri|clean-?up|purif|magnet/i, build: magCleanup },
  { match: /heat|shak|incubat|resuspend|37 ?°?c|mix at/i, build: heaterShake },
  { match: /dilut|serial|titrat/i, build: serialDilution },
  { match: /fill|dispense|aliquot|stamp|96|plate|pipette|transfer|buffer/i, build: fillPlate },
]

export type SceneResult = { protocol: Protocol } | { unsupported: string }

/** Turn a natural-language request into a runnable scene, or refuse it. */
export function generateScene(request: string): SceneResult {
  const reason = unsupportedReason(request)
  if (reason) return { unsupported: reason }
  for (const r of RECIPES) if (r.match.test(request)) return { protocol: r.build() }
  return { protocol: fillPlate() }
}

/** Whether a request should route to the robot at all. */
export function isProtocolRequest(request: string): boolean {
  return /pipette|opentron|protocol|dispense|aspirate|transfer|dilut|\bplate\b|\bwell|tray|tips?\b|liquid handl|fill|pcr|bead|clean-?up|resuspend|master ?mix|96|384|thermocycl|heater|shaker|magnet/i.test(
    request,
  )
}

export function defaultProtocol(): Protocol {
  return fillPlate()
}

/** Legacy helper (returns null when unsupported). */
export function protocolFor(query: string): Protocol | null {
  const r = generateScene(query)
  return 'protocol' in r ? r.protocol : null
}

export const PROTOCOLS: Protocol[] = [fillPlate(), serialDilution(), pcrSetup(), heaterShake(), magCleanup()]

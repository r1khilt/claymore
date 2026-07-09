/**
 * A minimal, faithful model of an Opentrons OT-2 protocol so the UI can render a
 * top-down deck and animate a run. Mirrors the Opentrons Python Protocol API:
 * a deck of numbered slots holds labware; a pipette runs an ordered list of
 * steps (pick_up_tip / aspirate / dispense / drop_tip). `python` is the real
 * Protocol-API source the same protocol would ship as.
 *
 * Geometry is proportional (not millimetres) — enough for an authentic 2D deck.
 */

export type Robot = 'OT-2' | 'Flex'
export type LabwareKind = 'tiprack_96' | 'wellplate_96' | 'reservoir_12' | 'tuberack_96' | 'trash'

export interface Labware {
  id: string
  kind: LabwareKind
  slot: number // 1–11 (12 = fixed trash)
  loadName: string // opentrons load name
  display: string
}

export interface PipetteSpec {
  mount: 'left' | 'right'
  model: string
  display: string
  channels: 1 | 8
}

export interface DeckLayout {
  robot: Robot
  labware: Labware[]
  pipette: PipetteSpec
}

export type StepKind = 'pick_up_tip' | 'aspirate' | 'dispense' | 'drop_tip' | 'move'

export interface Step {
  kind: StepKind
  labwareId?: string
  well?: string // "A1"
  volume?: number // µL
  label: string
}

export interface Protocol {
  id: string
  name: string
  description: string
  deck: DeckLayout
  steps: Step[]
  python: string
  /** optional grounded note tying the run to lab memory (a citation-ish blurb). */
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

/** Slot rectangle in deck coordinates. OT-2 numbering runs bottom-left → up. */
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
  if (kind === 'reservoir_12') return { rows: 1, cols: 12 }
  if (kind === 'trash') return { rows: 1, cols: 1 }
  return { rows: 8, cols: 12 } // 96 layout
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

const LETTERS = 'ABCDEFGH'

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

/** Screen position the pipette targets for a step (column-centered for 8-channel). */
export function wellPosFor(p: Protocol, labwareId: string, well: string, channels: 1 | 8): Point {
  const lab = findLabware(p, labwareId)
  if (!lab) return HOME_POS
  const { row, col } = wellToRC(well)
  if (channels === 8 && lab.kind !== 'reservoir_12') {
    const top = wellCenter(lab.slot, lab.kind, 0, col)
    const bot = wellCenter(lab.slot, lab.kind, 7, col)
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
  /** key `${labwareId}:${well}` -> accumulated volume (µL). */
  fills: Record<string, number>
  current: Step | null
  dipping: boolean // aspirate/dispense -> nozzle dips into the well
}

function applyFill(fills: Record<string, number>, p: Protocol, s: Step, channels: 1 | 8): void {
  if (!s.labwareId || !s.well) return
  const lab = findLabware(p, s.labwareId)
  if (!lab) return
  const { row, col } = wellToRC(s.well)
  const rows = channels === 8 && lab.kind !== 'reservoir_12' ? [0, 1, 2, 3, 4, 5, 6, 7] : [row]
  for (const r of rows) {
    const key = `${lab.id}:${LETTERS[r]}${col + 1}`
    fills[key] = (fills[key] ?? 0) + (s.volume ?? 0)
  }
}

/** Deterministic state after executing steps 0..index — so scrubbing just works. */
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

/* --------------------------------------------------------------- catalog --- */

const RESERVOIR: Labware = {
  id: 'res',
  kind: 'reservoir_12',
  slot: 2,
  loadName: 'nest_12_reservoir_15ml',
  display: 'Reservoir · buffer',
}
const TIPS: Labware = {
  id: 'tips',
  kind: 'tiprack_96',
  slot: 1,
  loadName: 'opentrons_96_tiprack_300ul',
  display: '300 µL tips',
}
const PLATE: Labware = {
  id: 'plate',
  kind: 'wellplate_96',
  slot: 3,
  loadName: 'corning_96_wellplate_360ul_flat',
  display: '96-well plate',
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
    description: '8-channel · 100 µL buffer into every well of the plate',
    deck: {
      robot: 'OT-2',
      pipette: { mount: 'right', model: 'p300_multi_gen2', display: 'P300 8-Channel', channels: 8 },
      labware: [TIPS, RESERVOIR, PLATE],
    },
    steps,
    groundedNote:
      "Using Maya's Assay Buffer v3 — held under 2% DMSO so the thermal-shift baseline stays flat.",
    python: `from opentrons import protocol_api

metadata = {"protocolName": "Fill 96-well plate", "author": "Claymore", "apiLevel": "2.20"}


def run(protocol: protocol_api.ProtocolContext):
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
      pipette: { mount: 'right', model: 'p300_single_gen2', display: 'P300 Single', channels: 1 },
      labware: [TIPS, RESERVOIR, PLATE],
    },
    steps,
    python: `from opentrons import protocol_api

metadata = {"protocolName": "Serial dilution", "author": "Claymore", "apiLevel": "2.20"}


def run(protocol: protocol_api.ProtocolContext):
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

export const PROTOCOLS: Protocol[] = [fillPlate(), serialDilution()]

/** Map a natural-language request to a protocol (null = not a protocol ask). */
export function protocolFor(query: string): Protocol | null {
  const q = query.toLowerCase()
  if (
    !/(pipette|opentron|protocol|dispense|aspirate|transfer|dilut|\bplate\b|\bwell|tray|tips?\b|liquid handl|fill|96)/.test(
      q,
    )
  )
    return null
  if (/dilut|serial|titrat/.test(q)) return serialDilution()
  return fillPlate()
}

export function defaultProtocol(): Protocol {
  return fillPlate()
}

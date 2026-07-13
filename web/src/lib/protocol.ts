/**
 * The scene model the agent authors, and the generators that produce it.
 *
 * A "protocol" is a bespoke scene: a robot deck holding labware (optionally on modules), a palette
 * of named liquids, and an ordered choreography of steps. The 2D/3D engines render *any* scene
 * produced here — nothing about a specific experiment is hard-coded in a renderer. `generateScene`
 * composes a scene from the supported-hardware catalog for Opentrons-capable work, and falls back
 * to a *general lab-robot* scene + a PyLabRobot movement script for anything a liquid handler
 * can't physically do (so the deck still shows what the run would look like).
 *
 * Geometry lives in `deck.ts`; the catalog in `hardware.ts`. This file owns the scene types, the
 * deterministic run derivation the player scrubs through, and the scene library.
 */
import {
  capabilityGap,
  instrumentDef,
  labwareDef,
  moduleDef,
  paletteColor,
  pipetteModel,
  type CapabilityGap,
  type InstrumentDef,
  type InstrumentKind,
  type Robot,
} from './hardware'
import {
  deckGeom,
  homePos,
  rcToWell,
  slotRect,
  trashPos,
  wellCenter,
  wellToRC,
  type Point,
} from './deck'

export type { Robot, InstrumentKind } from './hardware'
export type { Point, Rect, WellGeo } from './deck'

/* -------------------------------------------------------------------- types --- */

export interface Liquid {
  id: string
  name: string
  color: string
}

export interface WellFill {
  liquid: string
  volume: number
}

export interface Labware {
  id: string
  kind: string
  slot: string
  onModule?: string
  loadName: string
  display: string
  label?: string
  /** Reagents pre-loaded before the run starts (well name -> fill). */
  initial?: Record<string, WellFill>
}

export interface DeckModule {
  id: string
  kind: string
  slot: string
  display: string
  state?: string
}

export interface PipetteSpec {
  mount: 'left' | 'right'
  model: string
  display: string
  channels: 1 | 8 | 96
}

export interface Accessory {
  kind: 'gripper' | 'waste_chute' | 'trash_bin'
  display: string
  slot?: string
}

/** An off-deck instrument (centrifuge, imager…) the agent hands a plate to. Rendered as a bespoke
 *  animated 3D model, positioned on the benchtop beside the deck (see `deck.instrumentRect`). */
export interface Instrument {
  id: string
  kind: InstrumentKind
  display: string
  label?: string
  /** Which edge of the deck it stands next to. */
  side: 'right' | 'left' | 'back'
}

export interface DeckLayout {
  robot: Robot
  labware: Labware[]
  modules: DeckModule[]
  pipettes: PipetteSpec[]
  accessories: Accessory[]
  /** Off-deck instruments on the benchtop (empty for a pure Opentrons scene). */
  instruments?: Instrument[]
}

export type StepKind =
  | 'pick_up_tip'
  | 'drop_tip'
  | 'aspirate'
  | 'dispense'
  | 'blow_out'
  | 'mix'
  | 'move_labware'
  | 'set_temperature'
  | 'wait_temperature'
  | 'deactivate'
  | 'shake'
  | 'stop_shake'
  | 'engage_magnet'
  | 'disengage_magnet'
  | 'thermocycle'
  | 'open_lid'
  | 'close_lid'
  | 'read_absorbance'
  | 'load_instrument'
  | 'run_instrument'
  | 'unload_instrument'
  | 'delay'
  | 'comment'

export interface Step {
  kind: StepKind
  label: string
  labwareId?: string
  well?: string
  volume?: number
  liquid?: string
  moduleId?: string
  /** Target off-deck instrument for load/run/unload steps. */
  instrumentId?: string
  toSlot?: string
  temperature?: number
  rpm?: number
  seconds?: number
}

export type SceneMode = 'opentrons' | 'general'

export interface Protocol {
  id: string
  name: string
  description: string
  mode: SceneMode
  platformLabel: string
  deck: DeckLayout
  liquids: Liquid[]
  steps: Step[]
  code: string
  codeLang: string
  groundedNote?: string
  fallbackNote?: string
}

/* --------------------------------------------------------------- accessors --- */

export function primaryPipette(p: Protocol): PipetteSpec {
  return p.deck.pipettes[0] ?? { mount: 'right', model: 'p300_single_gen2', display: 'P300 Single', channels: 1 }
}

export function liquidColor(p: Protocol, id?: string): string {
  const l = p.liquids.find((q) => q.id === id)
  return l ? l.color : '#57a07b'
}

export function labwareById(p: Protocol, id?: string): Labware | undefined {
  return id ? p.deck.labware.find((l) => l.id === id) : undefined
}

export function instrumentById(p: Protocol, id?: string): Instrument | undefined {
  return id ? p.deck.instruments?.find((i) => i.id === id) : undefined
}

/** The tweakable parameters of an off-deck instrument scene (for follow-up change summaries). */
export function instrumentSceneParams(
  p: Protocol,
): { plateDisplay: string; plateKind: string; seconds?: number; rpm?: number; instrument?: string } | null {
  const plate = p.deck.labware.find((l) => labwareDef(l.kind).category === 'plate')
  if (!plate) return null
  const inst = p.deck.instruments?.[0]
  const run = p.steps.find((s) => s.kind === 'run_instrument')
  return {
    plateDisplay: plate.display,
    plateKind: plate.kind,
    seconds: run?.seconds,
    rpm: run?.rpm,
    instrument: inst ? instrumentDef(inst.kind).display : undefined,
  }
}

/* ----------------------------------------------------------------- run state -- */

export interface ModuleRun {
  active: boolean
  shaking: boolean
  magnet: boolean
  reading: boolean
  lidOpen: boolean
  temp?: number
  state?: string
}

/** Live state of an off-deck instrument for the run player / renderers. */
export interface InstrumentRun {
  /** A plate is currently seated inside. */
  loaded: boolean
  /** Actively running (spinning / imaging / …) — drives the rotor animation. */
  running: boolean
  /** Lid/door is open (plate is going in or out). */
  lidOpen: boolean
  rpm?: number
  seconds?: number
}

export interface RunState {
  index: number
  pos: Point
  hasTip: boolean
  tipLiquid?: string
  fills: Record<string, WellFill>
  slotOf: Record<string, string>
  modules: Record<string, ModuleRun>
  /** Off-deck instrument state, keyed by instrument id. */
  instruments: Record<string, InstrumentRun>
  /** Labware id -> instrument id it is currently seated inside (overrides its deck slot). */
  inInstrument: Record<string, string>
  /** Consumed tip wells per tiprack labware id (so racks visibly deplete). */
  tipsUsed: Record<string, Record<string, boolean>>
  current: Step | null
  dipping: boolean
  /** Labware currently held by the gripper mid-move (for the carry animation). */
  gripping?: { labwareId: string; toSlot: string } | null
  /** Labware currently being carried to/from an off-deck instrument. */
  handoff?: { labwareId: string; instrumentId: string; dir: 'in' | 'out' } | null
}

function fillKey(labwareId: string, well: string): string {
  return `${labwareId}:${well}`
}

/** Which wells a step touches, honouring 8-channel (whole column) / 96-channel (whole plate). */
export function stepWells(p: Protocol, step: Step, channels: number): string[] {
  if (!step.labwareId || !step.well) return []
  const lab = labwareById(p, step.labwareId)
  if (!lab) return []
  const def = labwareDef(lab.kind)
  if (def.shape === 'reservoir' || def.shape === 'trash') return [step.well]
  if (channels >= 96) {
    const out: string[] = []
    for (let r = 0; r < def.rows; r++) for (let c = 0; c < def.cols; c++) out.push(rcToWell(r, c))
    return out
  }
  const { row, col } = wellToRC(step.well)
  if (channels >= 8) return Array.from({ length: def.rows }, (_, r) => rcToWell(r, col))
  return [rcToWell(row, col)]
}

/** Screen position of a step's target (mean of touched wells, at the labware's current slot). */
export function wellPosFor(p: Protocol, slotOf: Record<string, string>, step: Step, channels: number): Point {
  const geom = deckGeom(p.deck.robot)
  const lab = labwareById(p, step.labwareId)
  if (!lab || !step.well) return homePos(geom)
  const def = labwareDef(lab.kind)
  const slot = slotOf[lab.id] ?? lab.slot
  const rect = slotRect(geom, slot)
  const wells = stepWells(p, step, channels).map((w) => wellToRC(w))
  if (wells.length === 0) return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  let sx = 0
  let sy = 0
  for (const { row, col } of wells) {
    const g = wellCenter(rect, def, row, col)
    sx += g.x
    sy += g.y
  }
  return { x: sx / wells.length, y: sy / wells.length }
}

function emptyModules(p: Protocol): Record<string, ModuleRun> {
  const out: Record<string, ModuleRun> = {}
  for (const m of p.deck.modules) {
    out[m.id] = { active: false, shaking: false, magnet: false, reading: false, lidOpen: false, state: m.state }
  }
  return out
}

function emptyInstruments(p: Protocol): Record<string, InstrumentRun> {
  const out: Record<string, InstrumentRun> = {}
  for (const inst of p.deck.instruments ?? []) out[inst.id] = { loaded: false, running: false, lidOpen: false }
  return out
}

function initialFills(p: Protocol): Record<string, WellFill> {
  const out: Record<string, WellFill> = {}
  for (const lab of p.deck.labware) {
    if (!lab.initial) continue
    for (const [well, fill] of Object.entries(lab.initial)) out[fillKey(lab.id, well)] = { ...fill }
  }
  return out
}

/** Replay steps 0..index into a deterministic snapshot the renderers draw. */
export function deriveRun(p: Protocol, index: number): RunState {
  const geom = deckGeom(p.deck.robot)
  const fills = initialFills(p)
  const slotOf: Record<string, string> = {}
  for (const lab of p.deck.labware) slotOf[lab.id] = lab.slot
  const modules = emptyModules(p)
  const instruments = emptyInstruments(p)
  const inInstrument: Record<string, string> = {}
  const tipsUsed: Record<string, Record<string, boolean>> = {}
  const channels = primaryPipette(p).channels

  let pos: Point = homePos(geom)
  let hasTip = false
  let tipLiquid: string | undefined
  let current: Step | null = null
  let dipping = false
  let gripping: RunState['gripping'] = null
  let handoff: RunState['handoff'] = null

  const last = Math.min(index, p.steps.length - 1)
  for (let i = 0; i <= last; i++) {
    const s = p.steps[i]
    current = s
    dipping = s.kind === 'aspirate' || s.kind === 'dispense' || s.kind === 'mix'
    gripping = null
    handoff = null
    const mod = s.moduleId ? modules[s.moduleId] : undefined
    switch (s.kind) {
      case 'pick_up_tip':
        hasTip = true
        tipLiquid = undefined
        pos = wellPosFor(p, slotOf, s, channels)
        if (s.labwareId && s.well) {
          const rack = (tipsUsed[s.labwareId] ??= {})
          for (const w of stepWells(p, s, channels)) rack[w] = true
        }
        break
      case 'drop_tip':
        hasTip = false
        tipLiquid = undefined
        pos = trashPos(geom)
        break
      case 'aspirate':
        pos = wellPosFor(p, slotOf, s, channels)
        tipLiquid = s.liquid ?? tipLiquid
        break
      case 'dispense': {
        pos = wellPosFor(p, slotOf, s, channels)
        for (const w of stepWells(p, s, channels)) {
          if (!s.labwareId) break
          const k = fillKey(s.labwareId, w)
          const prev = fills[k]
          fills[k] = {
            liquid: s.liquid ?? tipLiquid ?? prev?.liquid ?? '',
            volume: (prev?.volume ?? 0) + (s.volume ?? 0),
          }
        }
        tipLiquid = undefined
        break
      }
      case 'mix':
        pos = wellPosFor(p, slotOf, s, channels)
        break
      case 'blow_out':
        pos = trashPos(geom)
        tipLiquid = undefined
        break
      case 'move_labware':
        if (s.labwareId && s.toSlot) {
          gripping = { labwareId: s.labwareId, toSlot: s.toSlot }
          slotOf[s.labwareId] = s.toSlot
          const r = slotRect(geom, s.toSlot)
          pos = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
        }
        break
      case 'set_temperature':
      case 'wait_temperature':
        if (mod) {
          mod.active = true
          mod.temp = s.temperature
          mod.state = s.temperature != null ? `${s.temperature} °C` : mod.state
        }
        break
      case 'shake':
        if (mod) {
          mod.shaking = true
          mod.active = true
          mod.state = s.rpm ? `${s.rpm} rpm` : mod.state
        }
        break
      case 'stop_shake':
        if (mod) mod.shaking = false
        break
      case 'engage_magnet':
        if (mod) {
          mod.magnet = true
          mod.state = 'engaged'
        }
        break
      case 'disengage_magnet':
        if (mod) mod.magnet = false
        break
      case 'open_lid':
        if (mod) mod.lidOpen = true
        break
      case 'close_lid':
        if (mod) mod.lidOpen = false
        break
      case 'thermocycle':
        if (mod) {
          mod.active = true
          mod.lidOpen = false
          mod.state = 'cycling'
        }
        break
      case 'read_absorbance':
        if (mod) {
          mod.reading = true
          mod.active = true
          mod.state = s.temperature ? `${s.temperature} nm` : 'reading'
        }
        break
      case 'deactivate':
        if (mod) {
          mod.active = false
          mod.shaking = false
          mod.temp = undefined
          mod.state = 'idle'
        }
        break
      case 'load_instrument':
        if (s.instrumentId && s.labwareId) {
          inInstrument[s.labwareId] = s.instrumentId
          const inst = instruments[s.instrumentId]
          if (inst) {
            inst.loaded = true
            inst.lidOpen = true
            inst.running = false
          }
          handoff = { labwareId: s.labwareId, instrumentId: s.instrumentId, dir: 'in' }
          pos = homePos(geom)
        }
        break
      case 'run_instrument':
        if (s.instrumentId) {
          const inst = instruments[s.instrumentId]
          if (inst) {
            inst.running = true
            inst.lidOpen = false
            inst.rpm = s.rpm
            inst.seconds = s.seconds
          }
          pos = homePos(geom)
        }
        break
      case 'unload_instrument':
        if (s.instrumentId && s.labwareId) {
          delete inInstrument[s.labwareId]
          const inst = instruments[s.instrumentId]
          if (inst) {
            inst.loaded = false
            inst.lidOpen = true
            inst.running = false
          }
          handoff = { labwareId: s.labwareId, instrumentId: s.instrumentId, dir: 'out' }
          pos = homePos(geom)
        }
        break
      case 'delay':
      case 'comment':
        break
    }
  }
  return { index: last, pos, hasTip, tipLiquid, fills, slotOf, modules, instruments, inInstrument, tipsUsed, current, dipping, gripping, handoff }
}

/* ============================================================ scene generators = */

let uid = 0
function nextId(prefix: string): string {
  uid += 1
  return `${prefix}${uid}`
}

function mkLiquids(names: [string, number][]): Liquid[] {
  return names.map(([name, i]) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name, color: paletteColor(i) }))
}

function lw(id: string, kind: string, slot: string, opts: Partial<Labware> = {}): Labware {
  const d = labwareDef(kind)
  return { id, kind, slot, loadName: d.loadName, display: d.display, ...opts }
}

function mod(id: string, kind: string, slot: string, state?: string): DeckModule {
  return { id, kind, slot, display: moduleDef(kind).display, state }
}

function pip(model: string, mount: 'left' | 'right' = 'right'): PipetteSpec {
  const m = pipetteModel(model)!
  return { mount, model, display: m.display, channels: m.channels }
}

function header(name: string): string {
  return `from opentrons import protocol_api\n\nmetadata = {"protocolName": "${name}", "author": "Claymore", "apiLevel": "2.20"}\n\n\ndef run(protocol: protocol_api.ProtocolContext):\n`
}

/* ---- Opentrons scene: fill a plate (8-channel) ---- */

function fillPlate(): Protocol {
  const liquids = mkLiquids([['Assay buffer', 0]])
  const buf = liquids[0].id
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' }]
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 100, liquid: buf, label: 'Aspirate 100 µL · buffer' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 100, liquid: buf, label: `Dispense 100 µL · column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  return {
    id: nextId('fill'),
    name: 'Fill a 96-well plate',
    description: '8-channel · 100 µL assay buffer into every well',
    mode: 'opentrons',
    platformLabel: 'Opentrons OT-2',
    liquids,
    deck: {
      robot: 'OT-2',
      pipettes: [pip('p300_multi_gen2')],
      modules: [],
      accessories: [],
      labware: [
        lw('tips', 'tiprack_300', '1'),
        lw('res', 'reservoir_12', '2', { label: 'Assay buffer', initial: { A1: { liquid: buf, volume: 12000 } } }),
        lw('plate', 'wellplate_96', '3', { label: 'Assay plate' }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    groundedNote: "Using Maya's Assay Buffer v3 — held under 2% DMSO so the thermal-shift baseline stays flat.",
    code:
      header('Fill 96-well plate') +
      '    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)\n' +
      '    reservoir = protocol.load_labware("nest_12_reservoir_15ml", 2)\n' +
      '    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 3)\n' +
      '    p300 = protocol.load_instrument("p300_multi_gen2", "right", tip_racks=[tips])\n\n' +
      '    p300.pick_up_tip()\n' +
      '    for column in plate.columns():\n' +
      '        p300.aspirate(100, reservoir["A1"])\n' +
      '        p300.dispense(100, column[0])\n' +
      '    p300.drop_tip()\n',
  }
}

/* ---- Opentrons scene: serial dilution ---- */

function serialDilution(): Protocol {
  const liquids = mkLiquids([['Diluent', 2], ['Dye', 1]])
  const diluent = liquids[0].id
  const dye = liquids[1].id
  const steps: Step[] = [
    { kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up tip' },
    { kind: 'aspirate', labwareId: 'res', well: 'A2', volume: 100, liquid: dye, label: 'Aspirate 100 µL · dye stock' },
    { kind: 'dispense', labwareId: 'plate', well: 'A1', volume: 100, liquid: dye, label: 'Dispense 100 µL · A1' },
  ]
  for (let c = 1; c <= 11; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'plate', well: `A${c}`, volume: 100, liquid: dye, label: `Aspirate 100 µL · A${c}` })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c + 1}`, volume: 100, liquid: dye, label: `Dispense + mix · A${c + 1}` })
    steps.push({ kind: 'mix', labwareId: 'plate', well: `A${c + 1}`, volume: 50, label: `Mix 3× · A${c + 1}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tip' })
  return {
    id: nextId('serial'),
    name: 'Serial dilution',
    description: 'Single-channel · 2× dilution series across row A',
    mode: 'opentrons',
    platformLabel: 'Opentrons OT-2',
    liquids,
    deck: {
      robot: 'OT-2',
      pipettes: [pip('p300_single_gen2')],
      modules: [],
      accessories: [],
      labware: [
        lw('tips', 'tiprack_300', '1'),
        lw('res', 'reservoir_12', '2', { label: 'Diluent + dye', initial: { A1: { liquid: diluent, volume: 12000 }, A2: { liquid: dye, volume: 8000 } } }),
        lw('plate', 'wellplate_96', '3', { label: 'Dilution plate', initial: rowInitial('A', 1, 12, diluent, 100) }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    code:
      header('Serial dilution') +
      '    tips = protocol.load_labware("opentrons_96_tiprack_300ul", 1)\n' +
      '    reservoir = protocol.load_labware("nest_12_reservoir_15ml", 2)\n' +
      '    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 3)\n' +
      '    p300 = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tips])\n\n' +
      '    row = plate.rows()[0]\n' +
      '    p300.pick_up_tip()\n' +
      '    p300.transfer(100, reservoir["A2"], row[0], new_tip="never")\n' +
      '    for i in range(11):\n' +
      '        p300.transfer(100, row[i], row[i + 1], mix_after=(3, 50), new_tip="never")\n' +
      '    p300.drop_tip()\n',
  }
}

function rowInitial(rowLetter: string, from: number, to: number, liquid: string, volume: number): Record<string, WellFill> {
  const out: Record<string, WellFill> = {}
  for (let c = from; c <= to; c++) out[`${rowLetter}${c}`] = { liquid, volume }
  return out
}

/* ---- Opentrons scene: PCR setup on the thermocycler (Flex) ---- */

function pcrSetup(): Protocol {
  const liquids = mkLiquids([['Master mix', 6], ['Template', 3]])
  const mm = liquids[0].id
  const tmpl = liquids[1].id
  const steps: Step[] = [
    { kind: 'open_lid', moduleId: 'tc', label: 'Thermocycler: open lid' },
    { kind: 'set_temperature', moduleId: 'temp', temperature: 4, label: 'Temp module: hold reagents at 4 °C' },
    { kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' },
  ]
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'reagents', well: 'A1', volume: 18, liquid: mm, label: 'Aspirate 18 µL · master mix' })
    steps.push({ kind: 'dispense', labwareId: 'pcr', well: `A${c}`, volume: 18, liquid: mm, label: `Dispense 18 µL · column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'pick_up_tip', labwareId: 'tips', well: 'A2', label: 'Pick up 8 tips' })
  steps.push({ kind: 'aspirate', labwareId: 'reagents', well: 'A2', volume: 2, liquid: tmpl, label: 'Aspirate 2 µL · template' })
  steps.push({ kind: 'dispense', labwareId: 'pcr', well: 'A1', volume: 2, liquid: tmpl, label: 'Add template · column 1' })
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'close_lid', moduleId: 'tc', label: 'Thermocycler: close lid' })
  steps.push({ kind: 'thermocycle', moduleId: 'tc', label: '35 cycles · 95 / 55 / 72 °C', seconds: 5400 })
  steps.push({ kind: 'open_lid', moduleId: 'tc', label: 'Thermocycler: open lid' })
  return {
    id: nextId('pcr'),
    name: 'PCR plate setup + cycling',
    description: '8-channel master-mix + template → thermocycler, 35 cycles',
    mode: 'opentrons',
    platformLabel: 'Opentrons Flex',
    liquids,
    deck: {
      robot: 'Flex',
      pipettes: [pip('flex_8channel_50')],
      modules: [mod('tc', 'thermocycler', 'B1', 'lid open'), mod('temp', 'temperature', 'C1', '4 °C')],
      accessories: [{ kind: 'trash_bin', display: 'Trash Bin', slot: 'A3' }],
      labware: [
        lw('tips', 'tiprack_flex_50', 'D1'),
        lw('reagents', 'reservoir_12', 'D2', { label: 'Reagents', initial: { A1: { liquid: mm, volume: 4000 }, A2: { liquid: tmpl, volume: 400 } } }),
        lw('pcr', 'pcr_96', 'B1', { onModule: 'tc', label: 'PCR plate' }),
        lw('block', 'block_96_pcr', 'C1', { onModule: 'temp', label: 'Reagent block' }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    groundedNote: 'Master mix from the shared stock; template kept cold on the temperature module until cycling.',
    code:
      header('PCR setup') +
      '    tips = protocol.load_labware("opentrons_flex_96_tiprack_50ul", "D1")\n' +
      '    reagents = protocol.load_labware("nest_12_reservoir_15ml", "D2")\n' +
      '    tc = protocol.load_module("thermocyclerModuleV2")\n' +
      '    temp = protocol.load_module("temperatureModuleV2", "C1")\n' +
      '    pcr = tc.load_labware("nest_96_wellplate_100ul_pcr_full_skirt")\n' +
      '    p50 = protocol.load_instrument("flex_8channel_50", "left", tip_racks=[tips])\n\n' +
      '    tc.open_lid()\n' +
      '    temp.set_temperature(4)\n' +
      '    p50.pick_up_tip()\n' +
      '    for column in pcr.columns():\n' +
      '        p50.aspirate(18, reagents["A1"])\n' +
      '        p50.dispense(18, column[0])\n' +
      '    p50.drop_tip()\n' +
      '    tc.close_lid()\n' +
      '    tc.set_lid_temperature(105)\n' +
      '    tc.execute_profile(\n' +
      '        steps=[{"temperature": 95, "hold_time_seconds": 15},\n' +
      '               {"temperature": 55, "hold_time_seconds": 15},\n' +
      '               {"temperature": 72, "hold_time_seconds": 20}],\n' +
      '        repetitions=35, block_max_volume=20)\n' +
      '    tc.open_lid()\n',
  }
}

/* ---- Opentrons scene: heater-shaker resuspension ---- */

function heaterShake(): Protocol {
  const liquids = mkLiquids([['Resuspension buffer', 5]])
  const buf = liquids[0].id
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up tip' }]
  for (let i = 1; i <= 6; i++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 200, liquid: buf, label: 'Aspirate 200 µL · buffer' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${i}`, volume: 200, liquid: buf, label: `Dispense 200 µL · A${i}` })
    steps.push({ kind: 'mix', labwareId: 'plate', well: `A${i}`, volume: 100, label: `Resuspend · A${i}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tip' })
  steps.push({ kind: 'set_temperature', moduleId: 'hs', temperature: 37, label: 'Heater-Shaker: 37 °C' })
  steps.push({ kind: 'shake', moduleId: 'hs', rpm: 1000, seconds: 600, label: 'Shake 1000 rpm · 10 min' })
  steps.push({ kind: 'stop_shake', moduleId: 'hs', label: 'Stop shaking' })
  steps.push({ kind: 'deactivate', moduleId: 'hs', label: 'Deactivate Heater-Shaker' })
  return {
    id: nextId('hs'),
    name: 'Resuspend & incubate',
    description: 'Add buffer, resuspend, then shake at 37 °C',
    mode: 'opentrons',
    platformLabel: 'Opentrons Flex',
    liquids,
    deck: {
      robot: 'Flex',
      pipettes: [pip('flex_1channel_1000')],
      modules: [mod('hs', 'heater_shaker', 'C1', '37 °C · 1000 rpm')],
      accessories: [{ kind: 'trash_bin', display: 'Trash Bin', slot: 'A3' }],
      labware: [
        lw('tips', 'tiprack_flex_1000', 'D1'),
        lw('res', 'reservoir_12', 'D2', { label: 'Buffer', initial: { A1: { liquid: buf, volume: 14000 } } }),
        lw('plate', 'deepwell_96', 'C1', { onModule: 'hs', label: 'Sample block' }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    code:
      header('Resuspend and incubate') +
      '    tips = protocol.load_labware("opentrons_flex_96_tiprack_1000ul", "D1")\n' +
      '    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "D2")\n' +
      '    hs = protocol.load_module("heaterShakerModuleV1", "C1")\n' +
      '    plate = hs.load_labware("nest_96_wellplate_2ml_deep")\n' +
      '    p1000 = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])\n\n' +
      '    hs.open_labware_latch()\n' +
      '    hs.close_labware_latch()\n' +
      '    p1000.pick_up_tip()\n' +
      '    for i in range(6):\n' +
      '        p1000.transfer(200, reservoir["A1"], plate.wells()[i], mix_after=(3, 100), new_tip="never")\n' +
      '    p1000.drop_tip()\n' +
      '    hs.set_and_wait_for_temperature(37)\n' +
      '    hs.set_and_wait_for_shake_speed(1000)\n' +
      '    protocol.delay(minutes=10)\n' +
      '    hs.deactivate_shaker()\n' +
      '    hs.deactivate_heater()\n',
  }
}

/* ---- Opentrons scene: magnetic bead cleanup (Flex magnetic block + gripper) ---- */

function magBeadCleanup(): Protocol {
  const liquids = mkLiquids([['SPRI beads', 4], ['Ethanol', 7], ['Elution buffer', 2]])
  const beads = liquids[0].id
  const etoh = liquids[1].id
  const elution = liquids[2].id
  const steps: Step[] = [{ kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' }]
  for (let c = 1; c <= 6; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 50, liquid: beads, label: 'Aspirate 50 µL · beads' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 50, liquid: beads, label: `Add beads · column ${c}` })
    steps.push({ kind: 'mix', labwareId: 'plate', well: `A${c}`, volume: 40, label: `Mix beads · column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'delay', seconds: 300, label: 'Bind · 5 min' })
  steps.push({ kind: 'move_labware', labwareId: 'plate', toSlot: 'C2', label: 'Gripper → magnetic block' })
  steps.push({ kind: 'engage_magnet', moduleId: 'mag', label: 'Engage magnet · pellet beads' })
  steps.push({ kind: 'delay', seconds: 120, label: 'Settle · 2 min' })
  for (let c = 1; c <= 6; c++) {
    steps.push({ kind: 'pick_up_tip', labwareId: 'tips', well: `A${c + 1}`, label: 'Pick up 8 tips' })
    steps.push({ kind: 'aspirate', labwareId: 'plate', well: `A${c}`, volume: 45, label: `Remove supernatant · column ${c}` })
    steps.push({ kind: 'drop_tip', label: 'Discard to waste chute' })
  }
  steps.push({ kind: 'disengage_magnet', moduleId: 'mag', label: 'Disengage magnet' })
  steps.push({ kind: 'move_labware', labwareId: 'plate', toSlot: 'C1', label: 'Gripper → deck' })
  return {
    id: nextId('mag'),
    name: 'Magnetic bead cleanup',
    description: '8-channel SPRI cleanup · gripper move onto the magnetic block',
    mode: 'opentrons',
    platformLabel: 'Opentrons Flex',
    liquids,
    deck: {
      robot: 'Flex',
      pipettes: [pip('flex_8channel_1000')],
      modules: [mod('mag', 'magnetic_block', 'C2', 'disengaged')],
      accessories: [
        { kind: 'gripper', display: 'Flex Gripper' },
        { kind: 'waste_chute', display: 'Waste Chute', slot: 'D3' },
      ],
      labware: [
        lw('tips', 'tiprack_flex_200_filtered', 'D1'),
        lw('res', 'reservoir_12', 'D2', { label: 'Reagents', initial: { A1: { liquid: beads, volume: 4000 }, A2: { liquid: etoh, volume: 12000 }, A3: { liquid: elution, volume: 4000 } } }),
        lw('plate', 'deepwell_96', 'C1', { label: 'Sample block' }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    code:
      header('Magnetic bead cleanup') +
      '    tips = protocol.load_labware("opentrons_flex_96_filtertiprack_200ul", "D1")\n' +
      '    reagents = protocol.load_labware("nest_12_reservoir_15ml", "D2")\n' +
      '    mag = protocol.load_module("magneticBlockV1", "C2")\n' +
      '    chute = protocol.load_waste_chute()\n' +
      '    plate = protocol.load_labware("nest_96_wellplate_2ml_deep", "C1")\n' +
      '    p1000 = protocol.load_instrument("flex_8channel_1000", "left", tip_racks=[tips])\n\n' +
      '    p1000.pick_up_tip()\n' +
      '    for column in plate.columns()[:6]:\n' +
      '        p1000.aspirate(50, reagents["A1"])\n' +
      '        p1000.dispense(50, column[0])\n' +
      '        p1000.mix(3, 40, column[0])\n' +
      '    p1000.drop_tip()\n' +
      '    protocol.delay(minutes=5)\n' +
      '    protocol.move_labware(plate, mag, use_gripper=True)\n' +
      '    protocol.delay(minutes=2)\n' +
      '    for column in plate.columns()[:6]:\n' +
      '        p1000.pick_up_tip()\n' +
      '        p1000.aspirate(45, column[0])\n' +
      '        p1000.drop_tip()\n' +
      '    protocol.move_labware(plate, "C1", use_gripper=True)\n',
  }
}

/* ---- Opentrons scene: absorbance / ELISA-style read (Flex plate reader) ---- */

function absorbanceAssay(): Protocol {
  const liquids = mkLiquids([['Sample', 3], ['Substrate', 6], ['Stop solution', 1]])
  const sample = liquids[0].id
  const substrate = liquids[1].id
  const stop = liquids[2].id
  const steps: Step[] = [
    { kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up 8 tips' },
  ]
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'samples', well: `A${c}`, volume: 50, liquid: sample, label: `Aspirate 50 µL · samples col ${c}` })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 50, liquid: sample, label: `Load samples · column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'pick_up_tip', labwareId: 'tips', well: 'A2', label: 'Pick up 8 tips' })
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: 50, liquid: substrate, label: 'Aspirate 50 µL · substrate' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 50, liquid: substrate, label: `Add substrate · column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'delay', seconds: 900, label: 'Develop · 15 min' })
  steps.push({ kind: 'pick_up_tip', labwareId: 'tips', well: 'A3', label: 'Pick up 8 tips' })
  for (let c = 1; c <= 12; c++) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A2', volume: 50, liquid: stop, label: 'Aspirate 50 µL · stop' })
    steps.push({ kind: 'dispense', labwareId: 'plate', well: `A${c}`, volume: 50, liquid: stop, label: `Stop reaction · column ${c}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tips' })
  steps.push({ kind: 'move_labware', labwareId: 'plate', toSlot: 'B3', label: 'Gripper → plate reader' })
  steps.push({ kind: 'read_absorbance', moduleId: 'reader', temperature: 450, label: 'Read absorbance · 450 nm' })
  steps.push({ kind: 'move_labware', labwareId: 'plate', toSlot: 'C2', label: 'Gripper → deck' })
  return {
    id: nextId('abs'),
    name: 'Colorimetric assay + read',
    description: 'Load samples + substrate, develop, then read A450 on the plate reader',
    mode: 'opentrons',
    platformLabel: 'Opentrons Flex',
    liquids,
    deck: {
      robot: 'Flex',
      pipettes: [pip('flex_8channel_50')],
      modules: [mod('reader', 'absorbance', 'B3', 'idle')],
      accessories: [
        { kind: 'gripper', display: 'Flex Gripper' },
        { kind: 'trash_bin', display: 'Trash Bin', slot: 'A3' },
      ],
      labware: [
        lw('tips', 'tiprack_flex_50', 'D1'),
        lw('res', 'reservoir_12', 'D2', { label: 'Substrate + stop', initial: { A1: { liquid: substrate, volume: 8000 }, A2: { liquid: stop, volume: 8000 } } }),
        lw('samples', 'wellplate_96', 'C1', { label: 'Sample plate', initial: allWells('wellplate_96', sample, 60) }),
        lw('plate', 'wellplate_96', 'C2', { label: 'Assay plate' }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    code:
      header('Colorimetric assay') +
      '    tips = protocol.load_labware("opentrons_flex_96_tiprack_50ul", "D1")\n' +
      '    reagents = protocol.load_labware("nest_12_reservoir_15ml", "D2")\n' +
      '    samples = protocol.load_labware("corning_96_wellplate_360ul_flat", "C1")\n' +
      '    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", "C2")\n' +
      '    reader = protocol.load_module("absorbanceReaderV1", "B3")\n' +
      '    p50 = protocol.load_instrument("flex_8channel_50", "left", tip_racks=[tips])\n\n' +
      '    for src, dst in zip(samples.columns(), plate.columns()):\n' +
      '        p50.transfer(50, src[0], dst[0])\n' +
      '    for column in plate.columns():\n' +
      '        p50.transfer(50, reagents["A1"], column[0])\n' +
      '    protocol.delay(minutes=15)\n' +
      '    for column in plate.columns():\n' +
      '        p50.transfer(50, reagents["A2"], column[0])\n' +
      '    reader.close_lid()\n' +
      '    protocol.move_labware(plate, reader, use_gripper=True)\n' +
      '    reader.initialize("single", [450])\n' +
      '    result = reader.read()\n' +
      '    protocol.move_labware(plate, "C2", use_gripper=True)\n',
  }
}

function allWells(kind: string, liquid: string, volume: number): Record<string, WellFill> {
  const d = labwareDef(kind)
  const out: Record<string, WellFill> = {}
  for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) out[rcToWell(r, c)] = { liquid, volume }
  return out
}

/* ---- Opentrons scene: normalization from tubes ---- */

function normalization(): Protocol {
  const liquids = mkLiquids([['Stock DNA', 3], ['Water', 2]])
  const stock = liquids[0].id
  const water = liquids[1].id
  const steps: Step[] = []
  const vols = [8, 12, 6, 10, 14, 9]
  for (let i = 0; i < 6; i++) {
    const well = rcToWell(Math.floor(i / 6), i % 6)
    steps.push({ kind: 'pick_up_tip', labwareId: 'tips', well: rcToWell(0, i), label: 'Pick up tip' })
    steps.push({ kind: 'aspirate', labwareId: 'water', well: 'A1', volume: 20 - vols[i], liquid: water, label: `Aspirate ${20 - vols[i]} µL · water` })
    steps.push({ kind: 'dispense', labwareId: 'plate', well, volume: 20 - vols[i], liquid: water, label: `Water → ${well}` })
    steps.push({ kind: 'aspirate', labwareId: 'tubes', well: rcToWell(0, i), volume: vols[i], liquid: stock, label: `Aspirate ${vols[i]} µL · stock ${i + 1}` })
    steps.push({ kind: 'dispense', labwareId: 'plate', well, volume: vols[i], liquid: stock, label: `Stock → ${well}` })
    steps.push({ kind: 'mix', labwareId: 'plate', well, volume: 10, label: `Mix · ${well}` })
    steps.push({ kind: 'drop_tip', label: 'Drop tip' })
  }
  const tubeInit: Record<string, WellFill> = {}
  for (let i = 0; i < 6; i++) tubeInit[rcToWell(0, i)] = { liquid: stock, volume: 1500 }
  return {
    id: nextId('norm'),
    name: 'Concentration normalization',
    description: 'Normalize 6 DNA stocks to 20 µL at equal concentration',
    mode: 'opentrons',
    platformLabel: 'Opentrons OT-2',
    liquids,
    deck: {
      robot: 'OT-2',
      pipettes: [pip('p20_single_gen2')],
      modules: [],
      accessories: [],
      labware: [
        lw('tips', 'tiprack_20', '1'),
        lw('water', 'reservoir_12', '2', { label: 'Water', initial: { A1: { liquid: water, volume: 12000 } } }),
        lw('tubes', 'tuberack_24_1500', '4', { label: 'DNA stocks', initial: tubeInit }),
        lw('plate', 'wellplate_96', '3', { label: 'Normalized plate' }),
      ],
    },
    steps,
    codeLang: 'Opentrons Protocol API · 2.20',
    code:
      header('Concentration normalization') +
      '    tips = protocol.load_labware("opentrons_96_tiprack_20ul", 1)\n' +
      '    water = protocol.load_labware("nest_12_reservoir_15ml", 2)\n' +
      '    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 3)\n' +
      '    tubes = protocol.load_labware("opentrons_24_tuberack_nest_1.5ml_snapcap", 4)\n' +
      '    p20 = protocol.load_instrument("p20_single_gen2", "right", tip_racks=[tips])\n\n' +
      '    stock_volumes = [8, 12, 6, 10, 14, 9]\n' +
      '    for i, vol in enumerate(stock_volumes):\n' +
      '        p20.pick_up_tip()\n' +
      '        p20.transfer(20 - vol, water["A1"], plate.wells()[i], new_tip="never")\n' +
      '        p20.transfer(vol, tubes.wells()[i], plate.wells()[i], mix_after=(2, 10), new_tip="never")\n' +
      '        p20.drop_tip()\n',
  }
}

/* ---- General (non-Opentrons) scene: prep on-deck, then hand a plate to an instrument ---- */

const PLATE_BY_COUNT: Record<number, string> = {
  6: 'wellplate_6',
  12: 'wellplate_12',
  24: 'wellplate_24',
  48: 'wellplate_48',
  96: 'wellplate_96',
  384: 'wellplate_384',
}

/** The well-plate a request names ("24 well plate" -> wellplate_24). An unsupported count snaps to
 *  the nearest real plate ("324-well" -> the 384-well), never a silent 96-well default. */
export function plateKindFromRequest(request: string): string {
  const m = request.toLowerCase().match(/(\d{1,4})[\s-]*well/)
  if (!m) return 'wellplate_96'
  const n = Number(m[1])
  if (PLATE_BY_COUNT[n]) return PLATE_BY_COUNT[n]
  const counts = Object.keys(PLATE_BY_COUNT).map(Number)
  const nearest = counts.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a))
  return PLATE_BY_COUNT[nearest]
}

/** Parse a run duration + speed from the request ("spin for 10 seconds", "2 min at 3000 rpm"). */
export function spinParamsFromRequest(request: string): { seconds: number; rpm?: number } {
  const q = request.toLowerCase()
  let seconds = 0
  const min = q.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)\b/)
  const sec = q.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/)
  if (min) seconds += Math.round(Number(min[1]) * 60)
  if (sec) seconds += Math.round(Number(sec[1]))
  if (!seconds) seconds = 10 // a sensible default spin
  const rpm = q.match(/(\d[\d,]*)\s*(?:rpm|rcf|x\s*g|×\s*g)\b/)
  return { seconds, rpm: rpm ? Number(rpm[1].replace(/,/g, '')) : undefined }
}

function humanTime(s: number): string {
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} min ${r} s` : `${m} min`
}

function runLabel(idef: InstrumentDef, seconds: number, rpm?: number): string {
  const base = `${cap(idef.verb)} ${humanTime(seconds)}`
  return rpm ? `${base} · ${rpm.toLocaleString()} rpm` : base
}

/** A tidy per-well fill volume scaled to the plate size (µL). */
function perWellVolume(capUl: number): number {
  return Math.max(20, Math.min(250, Math.round((capUl * 0.35) / 10) * 10))
}

interface InstrumentSceneOpts {
  kind: InstrumentKind
  plateKind: string
  seconds: number
  rpm?: number
  /** Text used for the plan comment / fallback note (the request or the follow-up edit). */
  requestLabel: string
}

function generalRobotScene(request: string, gap: CapabilityGap): Protocol {
  return composeInstrumentScene({
    kind: gap.kind,
    plateKind: plateKindFromRequest(request),
    ...spinParamsFromRequest(request),
    requestLabel: request,
  })
}

/**
 * Continue a conversation on an off-deck instrument scene — the "it remembers" edit path. Given the
 * previous protocol and a follow-up ("spin it for 30 seconds", "make it a 48-well plate", "faster"),
 * carry forward every parameter and override only what the follow-up changes, then rebuild. Returns
 * null when the follow-up isn't an instrument-scene edit (the caller then generates fresh).
 */
export function editInstrumentScene(last: Protocol, query: string): Protocol | null {
  const q = query.toLowerCase()
  const plate = last.deck.labware.find((l) => labwareDef(l.kind).category === 'plate')
  if (!plate) return null
  const inst = last.deck.instruments?.[0]
  const gapNow = capabilityGap(query) // e.g. "image it instead" -> microscope
  if (!inst && !gapNow) return null // nothing instrument-related to continue

  const kind: InstrumentKind = gapNow?.kind ?? inst!.kind
  const runStep = last.steps.find((s) => s.kind === 'run_instrument')

  // plate size — only override when the follow-up actually names a well count
  let plateKind = plate.kind
  if (/\d{1,3}[\s-]*well/.test(q)) plateKind = plateKindFromRequest(query)

  // duration
  let seconds = runStep?.seconds ?? 10
  const parsed = spinParamsFromRequest(query)
  if (/\b(seconds?|secs?|minutes?|mins?)\b/.test(q)) seconds = parsed.seconds
  else if (/\b(longer|more time|keep spinning)\b/.test(q)) seconds = Math.round(seconds * 2)
  else if (/\b(shorter|less time|quick(er|ly)?|briefly)\b/.test(q)) seconds = Math.max(1, Math.round(seconds / 2))

  // speed
  let rpm = runStep?.rpm
  if (/\b(rpm|rcf|x\s*g)\b/.test(q)) rpm = parsed.rpm
  else if (/\b(faster|harder|higher|max speed)\b/.test(q)) rpm = Math.round((rpm ?? 3000) * 1.5)
  else if (/\b(slower|gentl(e|er|y)|lower speed|soft)\b/.test(q)) rpm = Math.round((rpm ?? 3000) / 1.5)

  return composeInstrumentScene({ kind, plateKind, seconds, rpm, requestLabel: query })
}

function composeInstrumentScene(o: InstrumentSceneOpts): Protocol {
  const idef = instrumentDef(o.kind)
  const plateKind = o.plateKind
  const pdef = labwareDef(plateKind)
  const wellCount = pdef.rows * pdef.cols
  const perWell = perWellVolume(pdef.wellUl ?? 300)
  const seconds = o.seconds
  const rpm = o.rpm
  const request = o.requestLabel

  const liquids = mkLiquids([['Sample', 3]])
  const sample = liquids[0].id
  const instId = 'inst'
  const plateId = 'plate'
  const lower = idef.display.toLowerCase()

  // Fill EVERY well of the plate — single channel, one tip, well by well (the request's
  // "pipette every well"). A 24-well plate is on a 19 mm pitch, so an 8-channel head can't span it.
  const wells: string[] = []
  for (let r = 0; r < pdef.rows; r++) for (let c = 0; c < pdef.cols; c++) wells.push(rcToWell(r, c))

  const steps: Step[] = [
    { kind: 'comment', label: `Plan: ${request.trim().slice(0, 90)}` },
    { kind: 'pick_up_tip', labwareId: 'tips', well: 'A1', label: 'Pick up tip' },
  ]
  for (const w of wells) {
    steps.push({ kind: 'aspirate', labwareId: 'res', well: 'A1', volume: perWell, liquid: sample, label: `Aspirate ${perWell} µL · sample` })
    steps.push({ kind: 'dispense', labwareId: plateId, well: w, volume: perWell, liquid: sample, label: `Dispense ${perWell} µL · ${w}` })
  }
  steps.push({ kind: 'drop_tip', label: 'Drop tip' })
  steps.push({ kind: 'load_instrument', instrumentId: instId, labwareId: plateId, label: `Robot arm → load plate into the ${lower}` })
  steps.push({ kind: 'run_instrument', instrumentId: instId, seconds, rpm, label: runLabel(idef, seconds, rpm) })
  steps.push({ kind: 'unload_instrument', instrumentId: instId, labwareId: plateId, label: 'Robot arm → return plate to the deck' })
  steps.push({ kind: 'comment', label: `${cap(idef.capability)} result texted back + ingested into memory` })

  return {
    id: nextId('gen'),
    name: `${cap(idef.capability)} run`,
    description: `Fill every well of the ${pdef.display}, then ${idef.verb} it for ${humanTime(seconds)}`,
    mode: 'general',
    platformLabel: 'General lab robot · PyLabRobot',
    liquids,
    deck: {
      robot: 'Generic',
      pipettes: [pip('p300_single_gen2')],
      modules: [],
      accessories: [{ kind: 'gripper', display: 'Robot arm' }],
      instruments: [{ id: instId, kind: o.kind, display: idef.display, label: idef.display, side: 'right' }],
      labware: [
        lw('tips', 'tiprack_300', '1'),
        lw('res', 'reservoir_12', '2', { label: 'Sample', initial: { A1: { liquid: sample, volume: 12000 } } }),
        lw(plateId, plateKind, '3', { label: `${pdef.display}` }),
      ],
    },
    steps,
    codeLang: 'PyLabRobot',
    fallbackNote: `Claymore composed a general lab-robot scene: it fills the ${pdef.display} on-deck, a robot arm hands it to the ${lower}, and the ${lower} runs the ${idef.verb}.`,
    code: pylabrobotScript(request, idef, wellCount, perWell, seconds, rpm),
  }
}

function pylabrobotScript(request: string, idef: InstrumentDef, wellCount: number, perWell: number, seconds: number, rpm?: number): string {
  const cls = idef.kind === 'centrifuge' ? 'Centrifuge' : `${cap(idef.kind.replace(/_/g, ' ')).replace(/ /g, '')}`
  const plateRes = `Cor_${wellCount}_wellplate`
  const spinArgs = rpm ? `rpm=${rpm}, seconds=${seconds}` : `seconds=${seconds}`
  return (
    '"""Generated by Claymore — a general lab-robot plan (off the Opentrons deck).\n' +
    `Request: ${request.trim().slice(0, 110)}\n` +
    `Prep the plate on-deck, then a robot arm hands it to the ${idef.display.toLowerCase()}.\n` +
    'Runs on any PyLabRobot-supported deck; the off-deck step drives the instrument over its API.\n' +
    '"""\n' +
    'import asyncio\n\n' +
    'from pylabrobot.liquid_handling import LiquidHandler\n' +
    'from pylabrobot.liquid_handling.backends import ChatterboxBackend\n' +
    `from pylabrobot.resources import Deck, ${plateRes}, HTF_L, Cor_12_reservoir\n\n` +
    `FILL_UL = ${perWell}\n\n\n` +
    'async def main() -> None:\n' +
    '    lh = LiquidHandler(backend=ChatterboxBackend(), deck=Deck())\n' +
    '    await lh.setup()\n\n' +
    '    tips = HTF_L(name="tips")\n' +
    `    plate = ${plateRes}(name="sample_plate")\n` +
    '    reservoir = Cor_12_reservoir(name="reservoir")\n' +
    '    lh.deck.assign_child_resource(tips, location=(0, 0, 0))\n' +
    '    lh.deck.assign_child_resource(reservoir, location=(150, 0, 0))\n' +
    '    lh.deck.assign_child_resource(plate, location=(300, 0, 0))\n\n' +
    `    # 1) fill every one of the plate's ${wellCount} wells\n` +
    '    await lh.pick_up_tips(tips["A1"])\n' +
    '    for well in plate.get_all_items():\n' +
    '        await lh.aspirate(reservoir["A1"], vols=[FILL_UL])\n' +
    '        await lh.dispense(well, vols=[FILL_UL])\n' +
    '    await lh.drop_tips(tips["A1"])\n\n' +
    `    # 2) hand the plate to the ${idef.display.toLowerCase()} and run it\n` +
    `    await ${cls}().run(plate, ${spinArgs})\n\n` +
    '    await lh.stop()\n\n\n' +
    `class ${cls}:\n` +
    `    """Thin async driver over the ${idef.display.toLowerCase()}'s vendor API.\n\n` +
    `    Claymore texts the ${idef.capability} result back and ingests it into lab memory."""\n\n` +
    (idef.kind === 'centrifuge'
      ? '    async def run(self, plate, *, seconds, rpm=3000):\n' +
        '        await self.open_lid()\n' +
        '        await self.load(plate)          # robot arm seats the plate in a rotor bucket\n' +
        '        await self.close_lid()\n' +
        '        await self.spin(rpm=rpm, seconds=seconds)\n' +
        '        await self.open_lid()\n' +
        '        return await self.unload()      # arm returns the plate to the deck\n\n' +
        '    async def spin(self, *, rpm, seconds):\n' +
        '        await self._cmd(f"SET_SPEED {rpm}")\n' +
        '        await self._cmd("START")\n' +
        '        await asyncio.sleep(seconds)\n' +
        '        await self._cmd("STOP")\n' +
        '        await self._wait_for_rotor_stop()\n'
      : '    async def run(self, plate, *, seconds, **params):\n' +
        '        await self.load(plate)\n' +
        `        await self._cmd("RUN", seconds=seconds, **params)  # ${idef.verb} the plate\n` +
        '        return await self.unload()\n') +
    '\n' +
    '    async def _cmd(self, *args, **kwargs):\n' +
    '        await asyncio.sleep(0)  # vendor serial/HTTP call goes here\n\n\n' +
    'if __name__ == "__main__":\n' +
    '    asyncio.run(main())\n'
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ---- router ---- */

interface Recipe {
  match: RegExp
  build: () => Protocol
}

const RECIPES: Recipe[] = [
  { match: /pcr|master ?mix|amplif|thermocycl|denatur|anneal|cycling/i, build: pcrSetup },
  { match: /bead|spri|clean-?up|purif|magnet|spri/i, build: magBeadCleanup },
  { match: /absorb|elisa|colorimetr|plate ?read|\bod\b|\bod ?600\b|a450|450 ?nm|assay read/i, build: absorbanceAssay },
  { match: /heat|shak|incubat|resuspend|37 ?°?c|mix at/i, build: heaterShake },
  { match: /normali[sz]|equal concentration|equimolar|dilute to/i, build: normalization },
  { match: /dilut|serial|titrat/i, build: serialDilution },
  { match: /fill|dispense|aliquot|stamp|96|plate|pipette|transfer|buffer/i, build: fillPlate },
]

export type SceneResult = { protocol: Protocol }

/** Turn a natural-language request into a scene. Opentrons-capable work maps to the catalog; a
 *  capability a liquid handler lacks becomes a general lab-robot scene + a PyLabRobot script. */
export function generateScene(request: string): SceneResult {
  const gap = capabilityGap(request)
  if (gap) return { protocol: generalRobotScene(request, gap) }
  for (const r of RECIPES) if (r.match.test(request)) return { protocol: r.build() }
  return { protocol: fillPlate() }
}

/** Whether a request should route to the robot at all. */
export function isProtocolRequest(request: string): boolean {
  if (capabilityGap(request)) return true
  return /pipette|opentron|protocol|dispense|aspirate|transfer|dilut|\bplate\b|\bwell|reservoir|tube|tips?\b|liquid handl|fill|pcr|bead|clean-?up|resuspend|master ?mix|96|384|thermocycl|heater|shaker|magnet|absorb|elisa|normali[sz]|assay|reagent|incubat/i.test(
    request,
  )
}

export function defaultProtocol(): Protocol {
  return fillPlate()
}

export function protocolFor(query: string): Protocol | null {
  return generateScene(query).protocol
}

export const PROTOCOLS: Protocol[] = [
  fillPlate(),
  serialDilution(),
  pcrSetup(),
  heaterShake(),
  magBeadCleanup(),
  absorbanceAssay(),
  normalization(),
]

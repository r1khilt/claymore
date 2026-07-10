/**
 * Opentrons supported-hardware catalog — the full deck.
 *
 * This is the single source of truth for what the agent may place on a deck. Every entry carries
 * its real Opentrons `loadName` (so a generated scene maps 1:1 to Protocol-API Python) plus the
 * geometry + rendering hints the 2D/3D engines need. The renderers switch on `shape`/`category`
 * and behaviour flags — never on the exact `kind` — so extending this catalog never touches a
 * renderer. Mirrored on the backend in `src/claymore/agent/hardware.py`.
 *
 * When a request needs a capability a liquid handler doesn't have (a centrifuge, a plate imager),
 * `capabilityGap` names it — the scene generator then builds a *general lab-robot* scene and a
 * PyLabRobot movement script instead of refusing (the deck still shows what the run would do).
 */

export type Robot = 'OT-2' | 'Flex' | 'Generic'

/* ------------------------------------------------------------------- pipettes -- */

export interface PipetteModel {
  model: string
  display: string
  channels: 1 | 8 | 96
  volumeUl: number
  tipUl: number
  robots: Robot[]
}

export const PIPETTES: PipetteModel[] = [
  // OT-2 GEN2
  { model: 'p20_single_gen2', display: 'P20 Single', channels: 1, volumeUl: 20, tipUl: 20, robots: ['OT-2'] },
  { model: 'p20_multi_gen2', display: 'P20 8-Channel', channels: 8, volumeUl: 20, tipUl: 20, robots: ['OT-2'] },
  { model: 'p300_single_gen2', display: 'P300 Single', channels: 1, volumeUl: 300, tipUl: 300, robots: ['OT-2'] },
  { model: 'p300_multi_gen2', display: 'P300 8-Channel', channels: 8, volumeUl: 300, tipUl: 300, robots: ['OT-2'] },
  { model: 'p1000_single_gen2', display: 'P1000 Single', channels: 1, volumeUl: 1000, tipUl: 1000, robots: ['OT-2'] },
  // Flex
  { model: 'flex_1channel_50', display: 'Flex 1-Channel 50', channels: 1, volumeUl: 50, tipUl: 50, robots: ['Flex'] },
  { model: 'flex_1channel_1000', display: 'Flex 1-Channel 1000', channels: 1, volumeUl: 1000, tipUl: 1000, robots: ['Flex'] },
  { model: 'flex_8channel_50', display: 'Flex 8-Channel 50', channels: 8, volumeUl: 50, tipUl: 50, robots: ['Flex'] },
  { model: 'flex_8channel_1000', display: 'Flex 8-Channel 1000', channels: 8, volumeUl: 1000, tipUl: 1000, robots: ['Flex'] },
  { model: 'flex_96channel_1000', display: 'Flex 96-Channel', channels: 96, volumeUl: 1000, tipUl: 1000, robots: ['Flex'] },
]

export function pipetteModel(model: string): PipetteModel | undefined {
  return PIPETTES.find((p) => p.model === model)
}

/* -------------------------------------------------------------------- labware -- */

export type LabwareShape = 'wells' | 'tubes' | 'strips' | 'reservoir' | 'tips' | 'flat' | 'trash' | 'chute'
export type WellShape = 'circle' | 'square'
export type LabwareCategory = 'tips' | 'plate' | 'reservoir' | 'tuberack' | 'block' | 'lid' | 'trash' | 'adapter'

export interface LabwareDef {
  kind: string
  loadName: string
  display: string
  category: LabwareCategory
  rows: number
  cols: number
  shape: LabwareShape
  wellShape?: WellShape
  /** Tubes/reservoirs taper toward the bottom (rendered as conical in 3D). */
  conical?: boolean
  /** Max working volume of one well/tube (µL) — scales the liquid meniscus. */
  wellUl?: number
  /** Plastic tint for the labware body. */
  tint?: string
  /** Physical labware height (mm-ish, for 3D extrusion). */
  height?: number
}

function def(d: LabwareDef): LabwareDef {
  return d
}

export const LABWARE: Record<string, LabwareDef> = {
  /* tip racks — Flex + OT-2, filtered + unfiltered, all volumes (all 8×12) */
  tiprack_flex_50: def({ kind: 'tiprack_flex_50', loadName: 'opentrons_flex_96_tiprack_50ul', display: '50 µL Flex tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 50, height: 6, tint: '#dfe3da' }),
  tiprack_flex_200: def({ kind: 'tiprack_flex_200', loadName: 'opentrons_flex_96_tiprack_200ul', display: '200 µL Flex tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 200, height: 7, tint: '#dfe3da' }),
  tiprack_flex_1000: def({ kind: 'tiprack_flex_1000', loadName: 'opentrons_flex_96_tiprack_1000ul', display: '1000 µL Flex tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 1000, height: 9, tint: '#dfe3da' }),
  tiprack_flex_200_filtered: def({ kind: 'tiprack_flex_200_filtered', loadName: 'opentrons_flex_96_filtertiprack_200ul', display: '200 µL Flex filter tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 200, height: 7, tint: '#e6e9e0' }),
  tiprack_300: def({ kind: 'tiprack_300', loadName: 'opentrons_96_tiprack_300ul', display: '300 µL tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 300, height: 7, tint: '#e9ece5' }),
  tiprack_20: def({ kind: 'tiprack_20', loadName: 'opentrons_96_tiprack_20ul', display: '20 µL tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 20, height: 5, tint: '#e9ece5' }),
  tiprack_1000: def({ kind: 'tiprack_1000', loadName: 'opentrons_96_tiprack_1000ul', display: '1000 µL tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 1000, height: 9, tint: '#e9ece5' }),
  tiprack_20_filtered: def({ kind: 'tiprack_20_filtered', loadName: 'opentrons_96_filtertiprack_20ul', display: '20 µL filter tips', category: 'tips', rows: 8, cols: 12, shape: 'tips', wellUl: 20, height: 5, tint: '#eef1e9' }),

  /* well plates — 6 / 12 / 24 / 48 / 96 / 384 */
  wellplate_6: def({ kind: 'wellplate_6', loadName: 'corning_6_wellplate_16.8ml_flat', display: '6-well plate', category: 'plate', rows: 2, cols: 3, shape: 'wells', wellShape: 'circle', wellUl: 16800, height: 20, tint: '#f4f3ef' }),
  wellplate_12: def({ kind: 'wellplate_12', loadName: 'corning_12_wellplate_6.9ml_flat', display: '12-well plate', category: 'plate', rows: 3, cols: 4, shape: 'wells', wellShape: 'circle', wellUl: 6900, height: 18, tint: '#f4f3ef' }),
  wellplate_24: def({ kind: 'wellplate_24', loadName: 'corning_24_wellplate_3.4ml_flat', display: '24-well plate', category: 'plate', rows: 4, cols: 6, shape: 'wells', wellShape: 'circle', wellUl: 3400, height: 18, tint: '#f4f3ef' }),
  wellplate_48: def({ kind: 'wellplate_48', loadName: 'corning_48_wellplate_1.6ml_flat', display: '48-well plate', category: 'plate', rows: 6, cols: 8, shape: 'wells', wellShape: 'circle', wellUl: 1600, height: 18, tint: '#f4f3ef' }),
  wellplate_96: def({ kind: 'wellplate_96', loadName: 'corning_96_wellplate_360ul_flat', display: '96-well plate', category: 'plate', rows: 8, cols: 12, shape: 'wells', wellShape: 'circle', wellUl: 360, height: 15, tint: '#f7f6f2' }),
  wellplate_384: def({ kind: 'wellplate_384', loadName: 'corning_384_wellplate_112ul_flat', display: '384-well plate', category: 'plate', rows: 16, cols: 24, shape: 'wells', wellShape: 'square', wellUl: 112, height: 15, tint: '#f7f6f2' }),
  pcr_96: def({ kind: 'pcr_96', loadName: 'nest_96_wellplate_100ul_pcr_full_skirt', display: '96 PCR plate', category: 'plate', rows: 8, cols: 12, shape: 'wells', wellShape: 'circle', conical: true, wellUl: 100, height: 16, tint: '#eef2f4' }),
  deepwell_96: def({ kind: 'deepwell_96', loadName: 'nest_96_wellplate_2ml_deep', display: '96 deep-well block', category: 'plate', rows: 8, cols: 12, shape: 'wells', wellShape: 'square', wellUl: 2000, height: 30, tint: '#eef0ea' }),

  /* reservoirs */
  reservoir_1: def({ kind: 'reservoir_1', loadName: 'nest_1_reservoir_195ml', display: '1-well reservoir', category: 'reservoir', rows: 1, cols: 1, shape: 'reservoir', wellUl: 195000, height: 30, tint: '#dfe9ef' }),
  reservoir_12: def({ kind: 'reservoir_12', loadName: 'nest_12_reservoir_15ml', display: '12-well reservoir', category: 'reservoir', rows: 1, cols: 12, shape: 'reservoir', wellUl: 15000, height: 30, tint: '#dfe9ef' }),

  /* tube racks (4-in-1 system) */
  tuberack_6_50ml: def({ kind: 'tuberack_6_50ml', loadName: 'opentrons_6_tuberack_falcon_50ml_conical', display: '6× 50 mL rack', category: 'tuberack', rows: 2, cols: 3, shape: 'tubes', conical: true, wellUl: 50000, height: 34, tint: '#e7e5dd' }),
  tuberack_15_15ml: def({ kind: 'tuberack_15_15ml', loadName: 'opentrons_15_tuberack_falcon_15ml_conical', display: '15× 15 mL rack', category: 'tuberack', rows: 3, cols: 5, shape: 'tubes', conical: true, wellUl: 15000, height: 30, tint: '#e7e5dd' }),
  tuberack_10_combo: def({ kind: 'tuberack_10_combo', loadName: 'opentrons_10_tuberack_falcon_4x50ml_6x15ml_conical', display: '10-tube combo rack', category: 'tuberack', rows: 2, cols: 5, shape: 'tubes', conical: true, wellUl: 50000, height: 32, tint: '#e7e5dd' }),
  tuberack_24_1500: def({ kind: 'tuberack_24_1500', loadName: 'opentrons_24_tuberack_nest_1.5ml_snapcap', display: '24× 1.5 mL rack', category: 'tuberack', rows: 4, cols: 6, shape: 'tubes', conical: true, wellUl: 1500, height: 22, tint: '#e7e5dd' }),
  tuberack_24_2000: def({ kind: 'tuberack_24_2000', loadName: 'opentrons_24_tuberack_nest_2ml_snapcap', display: '24× 2 mL rack', category: 'tuberack', rows: 4, cols: 6, shape: 'tubes', conical: true, wellUl: 2000, height: 22, tint: '#e7e5dd' }),
  tuberack_24_500: def({ kind: 'tuberack_24_500', loadName: 'opentrons_24_tuberack_nest_0.5ml_screwcap', display: '24× 0.5 mL rack', category: 'tuberack', rows: 4, cols: 6, shape: 'tubes', conical: true, wellUl: 500, height: 20, tint: '#e7e5dd' }),

  /* aluminum blocks + PCR strips (usually seat on a Temperature Module) */
  block_96_pcr: def({ kind: 'block_96_pcr', loadName: 'opentrons_96_aluminumblock_nest_wellplate_100ul', display: '96-well aluminum block', category: 'block', rows: 8, cols: 12, shape: 'wells', wellShape: 'circle', conical: true, wellUl: 100, height: 20, tint: '#cfd2cf' }),
  block_24_2ml: def({ kind: 'block_24_2ml', loadName: 'opentrons_24_aluminumblock_generic_2ml_screwcap', display: '24-tube aluminum block', category: 'block', rows: 4, cols: 6, shape: 'tubes', conical: true, wellUl: 2000, height: 24, tint: '#cfd2cf' }),
  block_pcr_strips: def({ kind: 'block_pcr_strips', loadName: 'opentrons_96_aluminumblock_generic_pcr_strip_200ul', display: 'PCR strips (aluminum block)', category: 'block', rows: 8, cols: 12, shape: 'strips', conical: true, wellUl: 200, height: 20, tint: '#cfd2cf' }),

  /* lid (an auto-sealing lid the gripper can lift on/off a plate) */
  pcr_lid: def({ kind: 'pcr_lid', loadName: 'opentrons_tough_pcr_auto_sealing_lid', display: 'PCR sealing lid', category: 'lid', rows: 8, cols: 12, shape: 'flat', wellUl: 0, height: 6, tint: '#e4e2da' }),

  /* fixed trash */
  trash: def({ kind: 'trash', loadName: 'opentrons_1_trash_1100ml_fixed', display: 'Trash', category: 'trash', rows: 1, cols: 1, shape: 'trash', height: 40, tint: '#e2e0d8' }),
}

export function labwareDef(kind: string): LabwareDef {
  return LABWARE[kind] ?? LABWARE.wellplate_96
}

/* -------------------------------------------------------------------- modules -- */

export interface ModuleBehavior {
  heats?: boolean
  cools?: boolean
  shakes?: boolean
  magnet?: boolean
  lid?: boolean
  reads?: boolean
  hood?: boolean
  stacker?: boolean
}

export interface ModuleDef {
  kind: string
  loadName: string
  display: string
  short: string
  tint: string
  robots: Robot[]
  behavior: ModuleBehavior
  /** Deck height of the module housing (for 3D). */
  height: number
}

export const MODULES: Record<string, ModuleDef> = {
  temperature: { kind: 'temperature', loadName: 'temperature module gen2', display: 'Temperature Module GEN2', short: 'TEMP', tint: '#4a6fa5', robots: ['OT-2', 'Flex'], behavior: { heats: true, cools: true }, height: 0.16 },
  thermocycler: { kind: 'thermocycler', loadName: 'thermocycler module gen2', display: 'Thermocycler GEN2', short: 'TC', tint: '#b4623f', robots: ['OT-2', 'Flex'], behavior: { heats: true, cools: true, lid: true }, height: 0.34 },
  heater_shaker: { kind: 'heater_shaker', loadName: 'heaterShakerModuleV1', display: 'Heater-Shaker', short: 'H/S', tint: '#c67f3d', robots: ['OT-2', 'Flex'], behavior: { heats: true, shakes: true }, height: 0.2 },
  magnetic: { kind: 'magnetic', loadName: 'magnetic module gen2', display: 'Magnetic Module GEN2', short: 'MAG', tint: '#7a5ea8', robots: ['OT-2'], behavior: { magnet: true }, height: 0.16 },
  magnetic_block: { kind: 'magnetic_block', loadName: 'magneticBlockV1', display: 'Magnetic Block GEN1', short: 'MAG', tint: '#7a5ea8', robots: ['Flex'], behavior: { magnet: true }, height: 0.14 },
  absorbance: { kind: 'absorbance', loadName: 'absorbanceReaderV1', display: 'Absorbance Plate Reader', short: 'ABS', tint: '#2f7d7a', robots: ['Flex'], behavior: { reads: true, lid: true }, height: 0.22 },
  hepa_uv: { kind: 'hepa_uv', loadName: 'hepaUVModule', display: 'HEPA/UV Module', short: 'HEPA', tint: '#5f6d7a', robots: ['Flex'], behavior: { hood: true }, height: 0.5 },
  stacker: { kind: 'stacker', loadName: 'flexStackerModuleV1', display: 'Flex Stacker', short: 'STK', tint: '#516b52', robots: ['Flex'], behavior: { stacker: true }, height: 0.42 },
}

export function moduleDef(kind: string): ModuleDef {
  return MODULES[kind] ?? MODULES.temperature
}

/* ---------------------------------------------------------------- accessories -- */

export interface AccessoryDef {
  kind: 'gripper' | 'waste_chute' | 'trash_bin'
  display: string
  robots: Robot[]
}

export const ACCESSORIES: Record<string, AccessoryDef> = {
  gripper: { kind: 'gripper', display: 'Flex Gripper', robots: ['Flex'] },
  waste_chute: { kind: 'waste_chute', display: 'Waste Chute', robots: ['Flex'] },
  trash_bin: { kind: 'trash_bin', display: 'Trash Bin', robots: ['Flex'] },
}

/* ---------------------------------------------------------------- liquid hues -- */

/** A warm, legible palette for named reagents (assigned round-robin by the generators). */
export const LIQUID_PALETTE: string[] = [
  '#57a07b', // buffer green
  '#d99a54', // amber / dye
  '#5b8dd6', // aqueous blue
  '#c96a6a', // reagent red
  '#8a6fc0', // beads purple
  '#4fb0a5', // teal
  '#d5b04a', // master-mix gold
  '#7ba0a8', // grey-blue
]

export function paletteColor(i: number): string {
  return LIQUID_PALETTE[((i % LIQUID_PALETTE.length) + LIQUID_PALETTE.length) % LIQUID_PALETTE.length]
}

/* ------------------------------------------------------- capability gap (fallback) -- */

export interface CapabilityGap {
  /** Human phrase for what's missing, e.g. "centrifugation". */
  capability: string
  /** The instrument that would do it off-deck, e.g. "benchtop centrifuge". */
  instrument: string
}

const CAPABILITY_GAPS: { re: RegExp; capability: string; instrument: string }[] = [
  { re: /centrifuge|spin ?down|spin the|pellet the/, capability: 'centrifugation', instrument: 'benchtop centrifuge' },
  { re: /microscop|image the|imaging|photograph|confocal/, capability: 'imaging / microscopy', instrument: 'automated microscope' },
  { re: /weigh|balance|gravimetric|mass of/, capability: 'weighing', instrument: 'analytical balance' },
  { re: /co2 incubat|cell cultur|tissue cultur|passage cells/, capability: 'CO₂ cell culture', instrument: 'CO₂ incubator + cell shuttle' },
  { re: /sequenc|nanopore|illumina|minion/, capability: 'sequencing', instrument: 'sequencer (Illumina / ONT)' },
  { re: /electroporat/, capability: 'electroporation', instrument: 'electroporator' },
  { re: /sonicat/, capability: 'sonication', instrument: 'sonicator' },
  { re: /flow cytometr|facs/, capability: 'flow cytometry', instrument: 'flow cytometer' },
  { re: /colony pick|colony-pick/, capability: 'colony picking', instrument: 'colony picker' },
]

/** Name the capability a liquid handler lacks for this request, else null. */
export function capabilityGap(request: string): CapabilityGap | null {
  const q = request.toLowerCase()
  for (const g of CAPABILITY_GAPS) if (g.re.test(q)) return { capability: g.capability, instrument: g.instrument }
  return null
}

/** Back-compat: a one-line reason string (or null) — some callers still use this. */
export function unsupportedReason(request: string): string | null {
  const gap = capabilityGap(request)
  return gap ? `${gap.capability} — needs a ${gap.instrument}, off the Opentrons deck` : null
}

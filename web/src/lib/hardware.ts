/**
 * Opentrons supported-hardware catalog. The agent may only generate a protocol
 * using equipment defined here — anything else returns "not supported by
 * Opentrons" rather than a fabricated scene. Load names are the real Opentrons
 * definitions. Mirrored on the backend in src/claymore/agent/hardware.py.
 */

export type Robot = 'OT-2' | 'Flex'

export interface PipetteModel {
  model: string
  display: string
  channels: 1 | 8 | 96
  volumeUl: number
  robots: Robot[]
}

export const PIPETTES: PipetteModel[] = [
  { model: 'p20_single_gen2', display: 'P20 Single', channels: 1, volumeUl: 20, robots: ['OT-2'] },
  { model: 'p20_multi_gen2', display: 'P20 8-Channel', channels: 8, volumeUl: 20, robots: ['OT-2'] },
  { model: 'p300_single_gen2', display: 'P300 Single', channels: 1, volumeUl: 300, robots: ['OT-2'] },
  { model: 'p300_multi_gen2', display: 'P300 8-Channel', channels: 8, volumeUl: 300, robots: ['OT-2'] },
  { model: 'p1000_single_gen2', display: 'P1000 Single', channels: 1, volumeUl: 1000, robots: ['OT-2'] },
  { model: 'flex_1channel_1000', display: 'Flex 1-Channel', channels: 1, volumeUl: 1000, robots: ['Flex'] },
  { model: 'flex_8channel_1000', display: 'Flex 8-Channel', channels: 8, volumeUl: 1000, robots: ['Flex'] },
  { model: 'flex_96channel_1000', display: 'Flex 96-Channel', channels: 96, volumeUl: 1000, robots: ['Flex'] },
]

export type LabwareKind =
  | 'tiprack_96'
  | 'wellplate_96'
  | 'wellplate_384'
  | 'reservoir_12'
  | 'reservoir_1'
  | 'tuberack_24'
  | 'pcr_96'
  | 'deepwell_96'
  | 'trash'

export interface LabwareDef {
  kind: LabwareKind
  loadName: string
  display: string
  rows: number
  cols: number
}

export const LABWARE: Record<LabwareKind, LabwareDef> = {
  tiprack_96: { kind: 'tiprack_96', loadName: 'opentrons_96_tiprack_300ul', display: '300 µL tips', rows: 8, cols: 12 },
  wellplate_96: { kind: 'wellplate_96', loadName: 'corning_96_wellplate_360ul_flat', display: '96-well plate', rows: 8, cols: 12 },
  wellplate_384: { kind: 'wellplate_384', loadName: 'corning_384_wellplate_112ul_flat', display: '384-well plate', rows: 16, cols: 24 },
  reservoir_12: { kind: 'reservoir_12', loadName: 'nest_12_reservoir_15ml', display: '12-ch reservoir', rows: 1, cols: 12 },
  reservoir_1: { kind: 'reservoir_1', loadName: 'nest_1_reservoir_195ml', display: 'reservoir', rows: 1, cols: 1 },
  tuberack_24: { kind: 'tuberack_24', loadName: 'opentrons_24_tuberack_nest_1.5ml_snapcap', display: '24-tube rack', rows: 4, cols: 6 },
  pcr_96: { kind: 'pcr_96', loadName: 'nest_96_wellplate_100ul_pcr_full_skirt', display: '96 PCR plate', rows: 8, cols: 12 },
  deepwell_96: { kind: 'deepwell_96', loadName: 'nest_96_wellplate_2ml_deep', display: '96 deep-well', rows: 8, cols: 12 },
  trash: { kind: 'trash', loadName: 'opentrons_1_trash_1100ml_fixed', display: 'Trash', rows: 1, cols: 1 },
}

export type ModuleKind = 'temperature' | 'thermocycler' | 'heater_shaker' | 'magnetic'

export interface ModuleDef {
  kind: ModuleKind
  loadName: string
  display: string
  short: string
  tint: string
}

export const MODULES: Record<ModuleKind, ModuleDef> = {
  temperature: { kind: 'temperature', loadName: 'temperature module gen2', display: 'Temperature Module', short: 'TEMP', tint: '#4a6fa5' },
  thermocycler: { kind: 'thermocycler', loadName: 'thermocycler module gen2', display: 'Thermocycler', short: 'TC', tint: '#b4623f' },
  heater_shaker: { kind: 'heater_shaker', loadName: 'heaterShakerModuleV1', display: 'Heater-Shaker', short: 'H/S', tint: '#c67f3d' },
  magnetic: { kind: 'magnetic', loadName: 'magnetic module gen2', display: 'Magnetic Module', short: 'MAG', tint: '#7a5ea8' },
}

/** Non-Opentrons capabilities the agent must refuse (returns a reason), else null. */
export function unsupportedReason(request: string): string | null {
  const q = request.toLowerCase()
  const blocked: [RegExp, string][] = [
    [/centrifuge|spin ?down|spin the/, 'centrifugation — the OT-2/Flex has no centrifuge'],
    [/microscop|image the|imaging|photograph/, 'imaging/microscopy — not an Opentrons capability'],
    [/weigh|balance|mass of/, 'weighing — no balance on the deck'],
    [/co2|cell cultur|incubat.*(cell|co2)/, 'CO₂ cell-culture incubation — outside Opentrons'],
    [/sequenc|nanopore|illumina/, 'sequencing — Opentrons only preps the library'],
    [/electroporat|sonicat|autoclave/, 'that instrument is not on the Opentrons deck'],
  ]
  for (const [re, reason] of blocked) if (re.test(q)) return reason
  return null
}

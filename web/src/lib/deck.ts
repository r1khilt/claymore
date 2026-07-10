/**
 * Deck geometry for every robot Claymore can draw — OT-2 (3×4 numbered slots + fixed trash),
 * Flex (A1–D4 with a staging column), and a neutral Generic bench for off-Opentrons scenes.
 *
 * Everything downstream (the 2D SVG engine, the 3D scene, the run player, the generators) reads
 * slot rectangles and well centres from here so the two renderers stay pixel-aligned and adding a
 * robot never means re-deriving coordinates in two places.
 */
import { labwareDef, type LabwareDef, type Robot } from './hardware'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface WellGeo {
  x: number
  y: number
  rx: number
  ry: number
}

interface Cell {
  col: number
  row: number // 0 = back (top of the drawn deck)
}

export interface DeckGeom {
  robot: Robot
  cols: number
  rows: number
  /** Ordered slot ids, e.g. ["1".."12"] or ["A1".."D4"]. */
  slots: string[]
  /** Slots that are a staging area (Flex column 4) — drawn as a quieter strip. */
  staging: Set<string>
  /** The fixed-trash slot, if the robot has one on-deck (OT-2 slot 12). */
  trashSlot?: string
  width: number
  height: number
}

const CELL = { colW: 120, rowH: 82, gapX: 12, gapY: 12, padX: 18, padY: 18 }

/** One deck slot's footprint (all slots share it) — labware groups draw in this local box. */
export const SLOT_W = CELL.colW
export const SLOT_H = CELL.rowH

function gridSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: CELL.padX * 2 + cols * CELL.colW + (cols - 1) * CELL.gapX,
    height: CELL.padY * 2 + rows * CELL.rowH + (rows - 1) * CELL.gapY,
  }
}

/* ---- per-robot slot maps ---- */

function ot2Cell(slot: string): Cell {
  const idx = Number.parseInt(slot, 10) - 1
  const col = idx % 3
  const rowFromBottom = Math.floor(idx / 3)
  return { col, row: 3 - rowFromBottom }
}

function flexCell(slot: string): Cell {
  const row = slot.charCodeAt(0) - 65 // A=0 (back) … D=3 (front)
  const col = Number.parseInt(slot.slice(1), 10) - 1
  return { col, row }
}

const OT2_SLOTS = Array.from({ length: 12 }, (_, i) => String(i + 1))
const FLEX_SLOTS = ['A', 'B', 'C', 'D'].flatMap((r) => [1, 2, 3, 4].map((c) => `${r}${c}`))
const GENERIC_SLOTS = Array.from({ length: 12 }, (_, i) => String(i + 1))

export function deckGeom(robot: Robot): DeckGeom {
  if (robot === 'Flex') {
    const { width, height } = gridSize(4, 4)
    return {
      robot,
      cols: 4,
      rows: 4,
      slots: FLEX_SLOTS,
      staging: new Set(FLEX_SLOTS.filter((s) => s.endsWith('4'))),
      width,
      height,
    }
  }
  // OT-2 and Generic share the 3×4 numbered grid; OT-2 pins trash to slot 12.
  const { width, height } = gridSize(3, 4)
  return {
    robot,
    cols: 3,
    rows: 4,
    slots: robot === 'OT-2' ? OT2_SLOTS : GENERIC_SLOTS,
    staging: new Set(),
    trashSlot: robot === 'OT-2' ? '12' : undefined,
    width,
    height,
  }
}

function cellFor(geom: DeckGeom, slot: string): Cell {
  return geom.robot === 'Flex' ? flexCell(slot) : ot2Cell(slot)
}

export function slotRect(geom: DeckGeom, slot: string): Rect {
  const { col, row } = cellFor(geom, slot)
  return {
    x: CELL.padX + col * (CELL.colW + CELL.gapX),
    y: CELL.padY + row * (CELL.rowH + CELL.gapY),
    w: CELL.colW,
    h: CELL.rowH,
  }
}

/* ---- well geometry inside a slot ---- */

const LETTERS = 'ABCDEFGHIJKLMNOP'

export function wellToRC(name: string): { row: number; col: number } {
  const row = name.charCodeAt(0) - 65
  const col = Number.parseInt(name.slice(1), 10) - 1
  return { row: Number.isNaN(row) ? 0 : row, col: Number.isNaN(col) ? 0 : col }
}

export function rcToWell(row: number, col: number): string {
  return `${LETTERS[row] ?? 'A'}${col + 1}`
}

/** Centre + radius of one well/tube/tip within a labware on a slot. */
export function wellCenter(rect: Rect, def: LabwareDef, row: number, col: number): WellGeo {
  const padIn = def.shape === 'reservoir' ? 7 : 9
  const gx = (rect.w - 2 * padIn) / def.cols
  const gy = (rect.h - 2 * padIn) / def.rows
  const base = Math.min(gx, gy)
  // Tubes/reservoir channels read better a touch tighter; dense plates a touch smaller.
  const rFactor = def.shape === 'tubes' ? 0.42 : def.rows * def.cols >= 384 ? 0.34 : 0.38
  return {
    x: rect.x + padIn + (col + 0.5) * gx,
    y: rect.y + padIn + (row + 0.5) * gy,
    rx: base * rFactor,
    ry: base * rFactor,
  }
}

export function gridFor(kind: string): { rows: number; cols: number } {
  const d = labwareDef(kind)
  return { rows: d.rows, cols: d.cols }
}

export function isReservoir(kind: string): boolean {
  return labwareDef(kind).shape === 'reservoir'
}

/** Home (gantry parked at back-centre) and trash drop points, in deck coordinates. */
export function homePos(geom: DeckGeom): Point {
  return { x: geom.width / 2, y: 4 }
}

export function trashPos(geom: DeckGeom): Point {
  const slot = geom.trashSlot ?? geom.slots[geom.slots.length - 1]
  const r = slotRect(geom, slot)
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/**
 * Shared coordinate system + surface palette for the 3D bench.
 *
 * One vertical datum for the whole rig so nothing floats: the benchtop top surface is world y=0
 * (`TABLE_Y`); the robot deck sits directly on it; labware sits flush on the deck; instruments sit
 * on the benchtop. Every height is derived from these constants — no per-mesh fudge offsets (the
 * old renderer's `+0.02`/`+0.04` gaps are gone). `S` maps deck-coordinate units (from `deck.ts`)
 * to world units, identical to the 2D engine so the two stay in register.
 */

/** deck-coordinate → world-unit scale (shared with 2D geometry). */
export const S = 0.02

/** Benchtop top surface — the datum everything rests on. */
export const TABLE_Y = 0
/** Robot deck chassis thickness. */
export const DECK_H = 0.34
/** Top face of the deck — labware bottoms sit exactly here. */
export const DECK_TOP = TABLE_Y + DECK_H
/** Benchtop slab thickness (top face at TABLE_Y, so it extends downward). */
export const BENCH_H = 0.4
/** Floor plane. */
export const FLOOR_Y = TABLE_Y - 2.6

/** Warm, premium surface palette — a pale benchtop + dark satin deck so the pale labware pops. */
export const SURFACE = {
  benchTop: '#c7c0b0',
  benchTopEdge: '#b0a793',
  cabinet: '#ded9cf',
  cabinetShadow: '#cbc5b8',
  floor: '#e7e3db',
  wall: '#eeebe4',
  deck: '#33352f',
  deckRaised: '#3c3e37',
  slotFloor: '#2c2e28',
  slotWall: '#454842',
  rail: '#8f9188',
  railDark: '#5a5c54',
} as const

/** Convert a deck-x coordinate to world x (deck centred on the origin). */
export function worldX(width: number, x: number): number {
  return (x - width / 2) * S
}

/** Convert a deck-y (depth) coordinate to world z. */
export function worldZ(height: number, y: number): number {
  return (y - height / 2) * S
}

/**
 * Realistic labware meshes — data-driven off the catalog `shape`/`category`, drawn with its base at
 * local y=0 so a placement group just sets the world height.
 *
 * Each labware is a skirted plastic body with wells/tubes/troughs that actually *contain* their
 * liquid: translucent walls (depthWrite off so 96 of them don't fight) over an opaque tinted
 * column, a dark recessed floor, a plate rim. Tip racks seat tapered tips that deplete; tube racks
 * hold conical capped tubes; aluminium blocks read metallic. Nothing floats, nothing gaps —
 * every height derives from the body height.
 */
import { RoundedBox } from '@react-three/drei'
import { labwareDef, type LabwareDef } from '@/lib/hardware'
import { wellCenter, SLOT_W, SLOT_H, type Rect } from '@/lib/deck'
import { S } from './scene'

const LETTERS = 'ABCDEFGHIJKLMNOP'
const LOCAL_RECT: Rect = { x: 0, y: 0, w: SLOT_W, h: SLOT_H }

export interface Colored {
  color: string
  volume: number
}

/** Local (labware-centred) offset + world radius of a well. */
function wellLocal(def: LabwareDef, row: number, col: number): { x: number; z: number; r: number } {
  const g = wellCenter(LOCAL_RECT, def, row, col)
  return { x: (g.x - SLOT_W / 2) * S, z: (g.y - SLOT_H / 2) * S, r: g.rx * S }
}

function fillFrac(def: LabwareDef, vol: number): number {
  if (vol <= 0) return 0
  const ref = Math.min(def.wellUl ?? 300, 420)
  return Math.max(0.22, Math.min(1, vol / ref))
}

/* ---- shared materials (as elements so they attach to the parent mesh) ---- */

function BodyPlastic({ color, metal = 0 }: { color: string; metal?: number }) {
  return <meshPhysicalMaterial color={color} roughness={metal ? 0.34 : 0.42} metalness={metal} clearcoat={metal ? 0 : 0.5} clearcoatRoughness={0.32} />
}

function ClearWall({ color = '#eef1ee' }: { color?: string }) {
  return <meshPhysicalMaterial color={color} roughness={0.12} transmission={0} transparent opacity={0.26} depthWrite={false} clearcoat={0.8} clearcoatRoughness={0.15} />
}

function Liquid({ color }: { color: string }) {
  return <meshStandardMaterial color={color} roughness={0.25} emissive={color} emissiveIntensity={0.22} />
}

const WELL_FLOOR = '#24261f'

/* ---- per-shape sub-meshes ---- */

function PlateWells({ labId, def, bodyH, fills, magnet, metal }: { labId: string; def: LabwareDef; bodyH: number; fills: Record<string, Colored>; magnet: boolean; metal: number }) {
  const bw = SLOT_W * S * 0.92
  const bd = SLOT_H * S * 0.92
  const skirtH = bodyH * 0.42
  const wellH = bodyH - skirtH
  const conical = !!def.conical
  // Detail scales down with well count: a 384-well plate at this size is ~1900 meshes at full
  // detail, which z-fights (overlapping translucent walls) and tanks the frame rate. Denser plates
  // get fewer radial segments and drop the rim (invisible at that scale) / recessed floor.
  const nWells = def.rows * def.cols
  const dense = nWells >= 96
  const veryDense = nWells >= 384
  const seg = veryDense ? 6 : dense ? 8 : 12
  const square = def.wellShape === 'square'
  const wells = []
  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      const w = wellLocal(def, row, col)
      const key = `${labId}:${LETTERS[row]}${col + 1}`
      const fill = fills[key]
      const frac = fill ? fillFrac(def, fill.volume) : 0
      const rTop = w.r * 0.98
      const rBot = conical ? w.r * 0.5 : w.r * 0.9
      const liqH = frac > 0 ? Math.max(0.012, frac * wellH * 0.86) : 0
      const side = w.r * 1.7 // square-well footprint
      wells.push(
        <group key={key} position={[w.x, 0, w.z]}>
          {/* translucent well wall — square wells (e.g. 384) render as boxes, round as cones */}
          <mesh position={[0, skirtH + wellH / 2, 0]}>
            {square ? (
              <boxGeometry args={[side, wellH, side]} />
            ) : (
              <cylinderGeometry args={[rTop, rBot, wellH, seg, 1, true]} />
            )}
            <ClearWall />
          </mesh>
          {/* dark recessed floor (skipped on the densest plates) */}
          {!veryDense && (
            <mesh position={[0, skirtH + 0.006, 0]}>
              <cylinderGeometry args={[rBot * 1.02, rBot * 0.7, 0.012, seg]} />
              <meshStandardMaterial color={WELL_FLOOR} roughness={0.85} />
            </mesh>
          )}
          {/* rim — only on sparse plates where it actually reads */}
          {!dense && (
            <mesh position={[0, skirtH + wellH - 0.004, 0]}>
              <torusGeometry args={[rTop * 0.98, rTop * 0.08, 6, 16]} />
              <BodyPlastic color={def.tint ?? '#f2f1ec'} metal={metal} />
            </mesh>
          )}
          {/* liquid */}
          {frac > 0 && fill && (
            <mesh position={[0, skirtH + 0.008 + liqH / 2, 0]}>
              {square ? (
                <boxGeometry args={[side * 0.86, liqH, side * 0.86]} />
              ) : (
                <cylinderGeometry args={[rTop * 0.86, rBot * 0.92, liqH, seg]} />
              )}
              <Liquid color={fill.color} />
            </mesh>
          )}
          {/* bead pellet against the wall when a magnet is engaged */}
          {magnet && frac > 0 && (
            <mesh position={[w.r * 0.55, skirtH + 0.02, 0]}>
              <sphereGeometry args={[w.r * 0.32, 8, 8]} />
              <meshStandardMaterial color="#5a4a2e" roughness={0.6} />
            </mesh>
          )}
        </group>,
      )
    }
  }
  return (
    <group>
      {/* skirt */}
      <RoundedBox args={[bw, skirtH, bd]} radius={0.02} smoothness={3} position={[0, skirtH / 2, 0]} castShadow receiveShadow>
        <BodyPlastic color={def.tint ?? '#f2f1ec'} metal={metal} />
      </RoundedBox>
      {/* upper deck the wells rise from (reads as the plate face) */}
      <RoundedBox args={[bw * 0.99, wellH * 0.5, bd * 0.99]} radius={0.015} smoothness={3} position={[0, skirtH + wellH * 0.25, 0]} castShadow>
        <BodyPlastic color={def.tint ?? '#f2f1ec'} metal={metal} />
      </RoundedBox>
      {wells}
    </group>
  )
}

function TipRack({ def, bodyH, used }: { def: LabwareDef; bodyH: number; used: Record<string, boolean> }) {
  const bw = SLOT_W * S * 0.92
  const bd = SLOT_H * S * 0.92
  const rackH = bodyH * 1.1
  const tipH = 0.2
  const tips = []
  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      const key = `${LETTERS[row]}${col + 1}`
      if (used[key]) continue
      const w = wellLocal(def, row, col)
      tips.push(
        <mesh key={key} position={[w.x, rackH + tipH / 2, w.z]} castShadow>
          <cylinderGeometry args={[w.r * 0.6, w.r * 0.16, tipH, 10]} />
          <meshPhysicalMaterial color="#dfe3da" roughness={0.4} clearcoat={0.4} />
        </mesh>,
      )
    }
  }
  return (
    <group>
      {/* rack base */}
      <RoundedBox args={[bw, rackH * 0.7, bd]} radius={0.02} smoothness={3} position={[0, rackH * 0.35, 0]} castShadow receiveShadow>
        <BodyPlastic color={def.tint ?? '#e9ece5'} />
      </RoundedBox>
      {/* top grid plate */}
      <mesh position={[0, rackH, 0]} castShadow>
        <boxGeometry args={[bw, 0.02, bd]} />
        <meshStandardMaterial color="#d3d7cd" roughness={0.6} />
      </mesh>
      {tips}
    </group>
  )
}

function TubeRack({ labId, def, bodyH, fills }: { labId: string; def: LabwareDef; bodyH: number; fills: Record<string, Colored> }) {
  const bw = SLOT_W * S * 0.92
  const bd = SLOT_H * S * 0.92
  const rackH = bodyH * 0.5
  const tubeH = bodyH * 1.05
  const tubes = []
  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      const w = wellLocal(def, row, col)
      const fill = fills[`${labId}:${LETTERS[row]}${col + 1}`]
      const frac = fill ? fillFrac(def, fill.volume) : 0
      const liqH = frac > 0 ? Math.max(0.02, frac * tubeH * 0.7) : 0
      tubes.push(
        <group key={`${row}-${col}`} position={[w.x, 0, w.z]}>
          {/* tube wall (tapers to a conical tip) */}
          <mesh position={[0, rackH + tubeH / 2, 0]}>
            <cylinderGeometry args={[w.r * 0.9, w.r * 0.25, tubeH, 14, 1, true]} />
            <ClearWall color="#e9ede8" />
          </mesh>
          {/* cap */}
          <mesh position={[0, rackH + tubeH + 0.02, 0]} castShadow>
            <cylinderGeometry args={[w.r * 0.98, w.r * 0.98, 0.05, 14]} />
            <BodyPlastic color="#cfd3ca" />
          </mesh>
          {frac > 0 && fill && (
            <mesh position={[0, rackH + 0.02 + liqH / 2, 0]}>
              <cylinderGeometry args={[w.r * 0.78, w.r * 0.22, liqH, 14]} />
              <Liquid color={fill.color} />
            </mesh>
          )}
        </group>,
      )
    }
  }
  return (
    <group>
      <RoundedBox args={[bw, rackH, bd]} radius={0.02} smoothness={3} position={[0, rackH / 2, 0]} castShadow receiveShadow>
        <BodyPlastic color={def.tint ?? '#e7e5dd'} metal={def.category === 'block' ? 0.6 : 0} />
      </RoundedBox>
      {tubes}
    </group>
  )
}

function Reservoir({ labId, def, bodyH, fills }: { labId: string; def: LabwareDef; bodyH: number; fills: Record<string, Colored> }) {
  const bw = SLOT_W * S * 0.92
  const bd = SLOT_H * S * 0.92
  const troughs = []
  for (let col = 0; col < def.cols; col++) {
    const w = wellLocal(def, 0, col)
    const fill = fills[`${labId}:A${col + 1}`]
    const frac = fill ? fillFrac(def, fill.volume) : 0
    const chW = def.cols > 1 ? bw / def.cols - 0.006 : bw * 0.8
    const liqH = frac > 0 ? Math.max(0.02, frac * bodyH * 0.8) : 0
    troughs.push(
      <group key={col} position={[w.x, 0, 0]}>
        {frac > 0 && fill && (
          <mesh position={[0, bodyH * 0.12 + liqH / 2, 0]}>
            <boxGeometry args={[chW * 0.92, liqH, bd * 0.78]} />
            <Liquid color={fill.color} />
          </mesh>
        )}
      </group>,
    )
  }
  return (
    <group>
      {/* translucent trough body */}
      <mesh position={[0, bodyH / 2, 0]}>
        <boxGeometry args={[bw, bodyH, bd]} />
        <meshPhysicalMaterial color="#dfe9ef" roughness={0.12} transparent opacity={0.34} depthWrite={false} clearcoat={0.9} />
      </mesh>
      {/* opaque base */}
      <mesh position={[0, bodyH * 0.06, 0]} receiveShadow>
        <boxGeometry args={[bw, bodyH * 0.12, bd]} />
        <BodyPlastic color="#cdd9e0" />
      </mesh>
      {/* dividers */}
      {def.cols > 1 &&
        Array.from({ length: def.cols - 1 }).map((_, i) => {
          const x = (-bw / 2) + (bw / def.cols) * (i + 1)
          return (
            <mesh key={i} position={[x, bodyH / 2, 0]}>
              <boxGeometry args={[0.006, bodyH, bd * 0.9]} />
              <meshStandardMaterial color="#c4d2da" transparent opacity={0.5} depthWrite={false} />
            </mesh>
          )
        })}
      {troughs}
    </group>
  )
}

function Trash({ bodyH }: { bodyH: number }) {
  const bw = SLOT_W * S * 0.82
  const bd = SLOT_H * S * 0.82
  return (
    <mesh position={[0, bodyH / 2, 0]} receiveShadow>
      <boxGeometry args={[bw, bodyH, bd]} />
      <meshPhysicalMaterial color="#d9d7cf" roughness={0.85} transparent opacity={0.55} />
    </mesh>
  )
}

/** One labware, drawn with its base at local y=0. `magnet` pellets beads when a magnet is engaged. */
export function LabwareMesh({ kind, labId, fills, used, magnet }: { kind: string; labId: string; fills: Record<string, Colored>; used: Record<string, boolean>; magnet: boolean }) {
  const def = labwareDef(kind)
  const bodyH = Math.max(0.06, (def.height ?? 15) * S)
  const metal = def.category === 'block' ? 0.65 : 0

  if (def.category === 'tips') return <TipRack def={def} bodyH={bodyH} used={used} />
  if (def.shape === 'reservoir') return <Reservoir labId={labId} def={def} bodyH={bodyH} fills={fills} />
  if (def.shape === 'tubes') return <TubeRack labId={labId} def={def} bodyH={bodyH} fills={fills} />
  if (def.shape === 'trash') return <Trash bodyH={bodyH} />
  return <PlateWells labId={labId} def={def} bodyH={bodyH} fills={fills} magnet={magnet} metal={metal} />
}

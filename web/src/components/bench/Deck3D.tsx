/**
 * The 3D deck engine — a react-three-fiber realisation of any scene the agent authors.
 *
 * Mirrors Deck2D's data-driven approach in three dimensions: labware meshes are chosen by the
 * catalog's `shape` (well plates, tube racks, reservoirs, PCR strips, tapered tip racks, trash),
 * modules render their housing + status glow, liquids are extruded and tinted per reagent, the
 * gantry lerps to the active well, and the gripper carries labware between slots. Lazy-loaded — the
 * three.js bundle only arrives when the 3D toggle is used.
 */
import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { labwareDef, moduleDef, type LabwareDef } from '@/lib/hardware'
import { deckGeom, slotRect, wellCenter, SLOT_W, SLOT_H, type DeckGeom, type Rect } from '@/lib/deck'
import {
  deriveRun,
  liquidColor,
  primaryPipette,
  type DeckModule,
  type Labware,
  type ModuleRun,
  type Protocol,
  type RunState,
  type WellFill,
} from '@/lib/protocol'

const S = 0.02
const DECK_TOP = 0.2
const LETTERS = 'ABCDEFGHIJKLMNOP'

function wx(geom: DeckGeom, x: number): number {
  return (x - geom.width / 2) * S
}
function wz(geom: DeckGeom, y: number): number {
  return (y - geom.height / 2) * S
}

const LOCAL_RECT: Rect = { x: 0, y: 0, w: SLOT_W, h: SLOT_H }

/** Local (labware-centred) world offset of a well. */
function wellLocal(def: LabwareDef, row: number, col: number): { x: number; z: number; r: number } {
  const g = wellCenter(LOCAL_RECT, def, row, col)
  return { x: (g.x - SLOT_W / 2) * S, z: (g.y - SLOT_H / 2) * S, r: g.rx * S }
}

function fillFrac(def: LabwareDef, vol: number): number {
  if (vol <= 0) return 0
  const ref = Math.min(def.wellUl ?? 300, 420)
  return Math.max(0.2, Math.min(1, vol / ref))
}

interface Colored {
  color: string
  volume: number
}

/* ------------------------------------------------------------------ labware -- */

function LabwareMesh({ lab, fills, used, magnet }: { lab: Labware; fills: Record<string, Colored>; used: Record<string, boolean>; magnet: boolean }) {
  const def = labwareDef(lab.kind)
  const bodyH = Math.max(0.08, (def.height ?? 15) * S * 0.9)
  const bodyY = DECK_TOP + 0.02 + bodyH / 2
  const topY = DECK_TOP + 0.02 + bodyH

  const wells = useMemo(() => {
    const out: { key: string; x: number; z: number; r: number; row: number; col: number }[] = []
    for (let row = 0; row < def.rows; row++)
      for (let col = 0; col < def.cols; col++) {
        const l = wellLocal(def, row, col)
        out.push({ key: `${LETTERS[row]}${col + 1}`, ...l, row, col })
      }
    return out
  }, [def])

  const bodyColor = def.tint ?? '#f3f2ee'

  return (
    <group>
      {/* labware body */}
      {def.shape !== 'trash' && (
        <mesh position={[0, bodyY, 0]} castShadow receiveShadow>
          <boxGeometry args={[SLOT_W * S * 0.9, bodyH, SLOT_H * S * 0.9]} />
          <meshStandardMaterial color={bodyColor} roughness={0.6} metalness={def.category === 'block' ? 0.5 : 0.05} />
        </mesh>
      )}

      {def.shape === 'reservoir' &&
        wells.map((w) => {
          const fill = fills[`${lab.id}:${w.key}`]
          const frac = fill ? fillFrac(def, fill.volume) : 0
          return (
            <group key={w.key}>
              <mesh position={[w.x, topY - 0.02, 0]}>
                <boxGeometry args={[w.r * 2.4, 0.04, SLOT_H * S * 0.7]} />
                <meshStandardMaterial color="#dfe9ef" />
              </mesh>
              {frac > 0 && fill && (
                <mesh position={[w.x, DECK_TOP + 0.04 + (bodyH * frac) / 2, 0]}>
                  <boxGeometry args={[w.r * 2.1, bodyH * frac, SLOT_H * S * 0.62]} />
                  <meshStandardMaterial color={fill.color} emissive={fill.color} emissiveIntensity={0.28} transparent opacity={0.9} />
                </mesh>
              )}
            </group>
          )
        })}

      {def.shape === 'trash' && (
        <mesh position={[0, DECK_TOP + 0.02 + bodyH / 2, 0]}>
          <boxGeometry args={[SLOT_W * S * 0.82, bodyH, SLOT_H * S * 0.82]} />
          <meshStandardMaterial color="#d9d7cf" transparent opacity={0.55} roughness={0.9} />
        </mesh>
      )}

      {(def.shape === 'wells' || def.shape === 'strips') &&
        wells.map((w) => {
          if (def.category === 'tips') {
            if (used[w.key]) return null
            return (
              <mesh key={w.key} position={[w.x, topY + 0.04, w.z]} castShadow>
                <cylinderGeometry args={[w.r * 0.55, w.r * 0.2, 0.16, 8]} />
                <meshStandardMaterial color="#cdd2c8" roughness={0.5} />
              </mesh>
            )
          }
          const fill = fills[`${lab.id}:${w.key}`]
          const frac = fill ? fillFrac(def, fill.volume) : 0
          const rimH = 0.03
          return (
            <group key={w.key} position={[w.x, 0, w.z]}>
              {/* well cavity rim */}
              <mesh position={[0, topY - rimH / 2, 0]}>
                <cylinderGeometry args={[w.r, w.r * (def.conical ? 0.7 : 0.95), rimH, 10]} />
                <meshStandardMaterial color="#ecebe4" />
              </mesh>
              {frac > 0 && fill && (
                <mesh position={[0, DECK_TOP + 0.05 + (bodyH * 0.8 * frac) / 2, 0]}>
                  <cylinderGeometry args={[w.r * 0.86, w.r * (def.conical ? 0.5 : 0.8), bodyH * 0.8 * frac, 10]} />
                  <meshStandardMaterial color={fill.color} emissive={fill.color} emissiveIntensity={0.3} transparent opacity={0.92} />
                </mesh>
              )}
              {magnet && frac > 0 && (
                <mesh position={[w.r * 0.5, DECK_TOP + 0.05, 0]}>
                  <sphereGeometry args={[w.r * 0.3, 8, 8]} />
                  <meshStandardMaterial color="#5a4a2e" />
                </mesh>
              )}
            </group>
          )
        })}

      {def.shape === 'tubes' &&
        wells.map((w) => {
          const fill = fills[`${lab.id}:${w.key}`]
          const frac = fill ? fillFrac(def, fill.volume) : 0
          const tubeH = bodyH * 1.1
          return (
            <group key={w.key} position={[w.x, 0, w.z]}>
              <mesh position={[0, DECK_TOP + 0.04 + tubeH / 2, 0]} castShadow>
                <cylinderGeometry args={[w.r * 0.9, w.r * 0.4, tubeH, 12]} />
                <meshStandardMaterial color="#e9e8e1" transparent opacity={0.55} roughness={0.3} />
              </mesh>
              {frac > 0 && fill && (
                <mesh position={[0, DECK_TOP + 0.05 + (tubeH * 0.7 * frac) / 2, 0]}>
                  <cylinderGeometry args={[w.r * 0.7, w.r * 0.32, tubeH * 0.7 * frac, 12]} />
                  <meshStandardMaterial color={fill.color} emissive={fill.color} emissiveIntensity={0.3} />
                </mesh>
              )}
            </group>
          )
        })}
    </group>
  )
}

/** A labware group that lerps toward its current slot centre (so gripper moves animate). ``lift``
 *  raises it onto the housing of any module under its current slot so it rests on top, not inside. */
function LabwarePlacement({ geom, lab, slot, fills, used, magnet, lift }: { geom: DeckGeom; lab: Labware; slot: string; fills: Record<string, Colored>; used: Record<string, boolean>; magnet: boolean; lift: number }) {
  const ref = useRef<THREE.Group>(null)
  const r = slotRect(geom, slot)
  const target = new THREE.Vector3(wx(geom, r.x + r.w / 2), lift, wz(geom, r.y + r.h / 2))
  useFrame(() => {
    if (ref.current) ref.current.position.lerp(target, 0.15)
  })
  return (
    <group ref={ref} position={[target.x, lift, target.z]}>
      <LabwareMesh lab={lab} fills={fills} used={used} magnet={magnet} />
    </group>
  )
}

/* ------------------------------------------------------------------- modules -- */

function ModuleMesh({ geom, mod, run }: { geom: DeckGeom; mod: DeckModule; run?: ModuleRun }) {
  const r = slotRect(geom, mod.slot)
  const def = moduleDef(mod.kind)
  const c = new THREE.Color(def.tint)
  const h = def.height
  const cx = wx(geom, r.x + r.w / 2)
  const cz = wz(geom, r.y + r.h / 2)
  const active = run?.active
  const emissive = active ? def.tint : '#000000'
  const shakeRef = useRef<THREE.Group>(null)
  useFrame((st) => {
    if (shakeRef.current && run?.shaking) shakeRef.current.position.x = Math.sin(st.clock.elapsedTime * 40) * 0.01
    else if (shakeRef.current) shakeRef.current.position.x = 0
  })
  return (
    <group position={[cx, 0, cz]}>
      <group ref={shakeRef}>
        <mesh position={[0, DECK_TOP + h / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[r.w * S * 0.94, h, r.h * S * 0.94]} />
          <meshStandardMaterial color={c} transparent opacity={0.92} emissive={emissive} emissiveIntensity={active ? 0.35 : 0.1} roughness={0.5} metalness={0.3} />
        </mesh>
        {/* status LED strip */}
        <mesh position={[0, DECK_TOP + h - 0.02, r.h * S * 0.4]}>
          <boxGeometry args={[r.w * S * 0.5, 0.02, 0.03]} />
          <meshStandardMaterial color={active ? def.tint : '#7c7f74'} emissive={active ? def.tint : '#000'} emissiveIntensity={active ? 0.9 : 0} />
        </mesh>
      </group>
      {/* hinged lid (thermocycler / reader) */}
      {def.behavior.lid && (
        <mesh position={[0, DECK_TOP + h + (run?.lidOpen ? 0.26 : 0.06), run?.lidOpen ? -r.h * S * 0.3 : 0]} castShadow>
          <boxGeometry args={[r.w * S * 0.9, 0.1, r.h * S * 0.9]} />
          <meshStandardMaterial color={c} transparent opacity={run?.lidOpen ? 0.5 : 0.85} emissive={emissive} emissiveIntensity={active ? 0.3 : 0} />
        </mesh>
      )}
    </group>
  )
}

/* -------------------------------------------------------------------- gantry -- */

function Gantry({ protocol, geom, state }: { protocol: Protocol; geom: DeckGeom; state: RunState }) {
  const bridge = useRef<THREE.Group>(null)
  const carriage = useRef<THREE.Group>(null)
  const channels = primaryPipette(protocol).channels
  const multi = channels === 8
  const big = channels === 96
  const tipColor = state.tipLiquid ? liquidColor(protocol, state.tipLiquid) : '#c9ccc3'

  const target = useRef({ x: 0, z: 0, dip: false })
  target.current = { x: wx(geom, state.pos.x), z: wz(geom, state.pos.y), dip: state.dipping }

  useFrame((_, dt) => {
    const k = Math.min(1, dt * 6)
    const t = target.current
    if (bridge.current) bridge.current.position.z += (t.z - bridge.current.position.z) * k
    if (carriage.current) {
      carriage.current.position.x += (t.x - carriage.current.position.x) * k
      carriage.current.position.z += (t.z - carriage.current.position.z) * k
      const targetY = t.dip ? 1.0 : 1.35
      carriage.current.position.y += (targetY - carriage.current.position.y) * k
    }
  })

  const halfX = (geom.width * S) / 2 + 0.15
  const headW = big ? 0.5 : multi ? 0.34 : 0.28

  return (
    <group>
      {/* side rails */}
      <mesh position={[-halfX, 1.75, 0]}>
        <boxGeometry args={[0.1, 0.1, geom.height * S + 0.4]} />
        <meshStandardMaterial color="#b9b6ac" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[halfX, 1.75, 0]}>
        <boxGeometry args={[0.1, 0.1, geom.height * S + 0.4]} />
        <meshStandardMaterial color="#b9b6ac" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* moving bridge */}
      <group ref={bridge}>
        <mesh position={[0, 1.75, 0]}>
          <boxGeometry args={[geom.width * S + 0.3, 0.12, 0.14]} />
          <meshStandardMaterial color="#cbc8be" metalness={0.3} roughness={0.5} />
        </mesh>
      </group>
      {/* carriage + pipette head */}
      <group ref={carriage} position={[wx(geom, state.pos.x), 1.35, wz(geom, state.pos.y)]}>
        <mesh castShadow>
          <boxGeometry args={[headW, 0.5, multi || big ? 0.62 : 0.34]} />
          <meshStandardMaterial color="#33352f" metalness={0.2} roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.28, 0]}>
          <boxGeometry args={[headW, 0.08, multi || big ? 0.62 : 0.34]} />
          <meshStandardMaterial color="#3f7d5c" />
        </mesh>
        {/* nozzles / tips */}
        {big ? (
          <mesh position={[0, -0.42, 0]}>
            <boxGeometry args={[headW * 0.8, 0.28, 0.5]} />
            <meshStandardMaterial color={state.hasTip ? tipColor : '#5a5c54'} />
          </mesh>
        ) : (
          Array.from({ length: multi ? 8 : 1 }).map((_, i) => {
            const z = multi ? -0.245 + i * 0.07 : 0
            return (
              <mesh key={i} position={[0, -0.42, z]}>
                <cylinderGeometry args={[0.018, 0.03, 0.28, 8]} />
                <meshStandardMaterial color={state.hasTip ? tipColor : '#5a5c54'} />
              </mesh>
            )
          })
        )}
      </group>
    </group>
  )
}

/* --------------------------------------------------------------------- scene -- */

function Scene({ protocol, state }: { protocol: Protocol; state?: RunState }) {
  const geom = deckGeom(protocol.deck.robot)
  // Keep the zoom clamp tied to the camera framing (which is geom.width-derived) so the initial
  // camera distance (|pos-target| ≈ dist·1.41) always sits inside [minDistance, maxDistance].
  const dist = geom.width * S * 1.5
  const s = state ?? deriveRun(protocol, -1)
  const colored: Record<string, Colored> = {}
  for (const [k, v] of Object.entries(s.fills as Record<string, WellFill>)) colored[k] = { color: liquidColor(protocol, v.liquid), volume: v.volume }

  return (
    <>
      <ambientLight intensity={0.7} />
      <hemisphereLight args={['#ffffff', '#d8d4c8', 0.55]} />
      <directionalLight position={[6, 11, 6]} intensity={1.15} castShadow shadow-mapSize={[1024, 1024]} />
      {/* deck base */}
      <mesh position={[0, 0, 0]} receiveShadow>
        <boxGeometry args={[geom.width * S, 0.4, geom.height * S]} />
        <meshStandardMaterial color="#dcd9cf" roughness={0.8} />
      </mesh>
      {/* slot insets */}
      {geom.slots.map((slot) => {
        const r = slotRect(geom, slot)
        return (
          <mesh key={slot} position={[wx(geom, r.x + r.w / 2), DECK_TOP + 0.005, wz(geom, r.y + r.h / 2)]}>
            <boxGeometry args={[r.w * S * 0.95, 0.02, r.h * S * 0.95]} />
            <meshStandardMaterial color={geom.staging.has(slot) ? '#e2e0d7' : '#edeae2'} />
          </mesh>
        )
      })}
      {protocol.deck.modules.map((m) => (
        <ModuleMesh key={m.id} geom={geom} mod={m} run={s.modules[m.id]} />
      ))}
      {protocol.deck.labware.map((lab) => {
        // Magnet + on-module lift key off the module under the labware's CURRENT slot (a plate can
        // be gripper-moved onto a module), so it rests on the housing and pellets when engaged.
        const slot = s.slotOf[lab.id] ?? lab.slot
        const modHere = protocol.deck.modules.find((m) => m.slot === slot)
        const magnet = modHere ? !!s.modules[modHere.id]?.magnet : false
        const lift = modHere ? moduleDef(modHere.kind).height : 0
        return (
          <LabwarePlacement key={lab.id} geom={geom} lab={lab} slot={slot} fills={colored} used={s.tipsUsed[lab.id] ?? {}} magnet={magnet} lift={lift} />
        )
      })}
      {state && <Gantry protocol={protocol} geom={geom} state={state} />}
      <OrbitControls enablePan={false} minDistance={dist * 0.42} maxDistance={dist * 1.7} maxPolarAngle={Math.PI / 2.15} target={[0, 0.3, 0]} />
    </>
  )
}

export function Deck3D({ protocol, state }: { protocol: Protocol; state?: RunState }) {
  const geom = deckGeom(protocol.deck.robot)
  const dist = geom.width * S * 1.5
  return (
    <Canvas shadows dpr={[1, 1.75]} camera={{ position: [dist * 0.6, dist * 0.8, dist], fov: 40 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#f2f1ec']} />
      <Scene protocol={protocol} state={state} />
    </Canvas>
  )
}

export default Deck3D

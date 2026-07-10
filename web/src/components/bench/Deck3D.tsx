/**
 * The 3D deck engine — a react-three-fiber realisation of any scene the agent authors.
 *
 * Everything sits in a real room now: a lab bench (with a cabinet base) on a soft floor, studio
 * lighting baked from inline Lightformers, and a contact-shadow pad that plants the rig so nothing
 * floats. Labware, modules and the gantry render off the catalog exactly as the 2D engine does; the
 * new piece is off-deck **instruments** — when a request leaves the Opentrons deck (a centrifuge),
 * the agent's scene carries the plate over to a bespoke, animated instrument model beside the deck.
 * Lazy-loaded — the three.js bundle only arrives when the 3D toggle is used.
 */
import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, RoundedBox, Edges } from '@react-three/drei'
import * as THREE from 'three'
import { moduleDef } from '@/lib/hardware'
import { deckGeom, slotRect, instrumentRect, type DeckGeom } from '@/lib/deck'
import {
  deriveRun,
  liquidColor,
  primaryPipette,
  type DeckModule,
  type Instrument,
  type Labware,
  type ModuleRun,
  type Protocol,
  type RunState,
  type WellFill,
} from '@/lib/protocol'
import { S, DECK_H, DECK_TOP, TABLE_Y, SURFACE, worldX, worldZ } from './three/scene'
import { LabwareMesh, type Colored } from './three/labware'
import { StudioLighting, LabBench, GroundShadow } from './three/environment'
import { Instrument3D, centrifugeSeat } from './three/centrifuge'

/* ------------------------------------------------------------------ placement -- */

/** A labware group that eases toward a world target + scale (so gantry moves and instrument
 *  hand-offs animate). `sink` shrinks it to nothing while it spins hidden inside an instrument. */
function LabwarePlacement({
  lab,
  target,
  fills,
  used,
  magnet,
  sink,
}: {
  lab: Labware
  target: THREE.Vector3
  fills: Record<string, Colored>
  used: Record<string, boolean>
  magnet: boolean
  sink: boolean
}) {
  const ref = useRef<THREE.Group>(null)
  useFrame(() => {
    const g = ref.current
    if (!g) return
    g.position.lerp(target, 0.16)
    const sc = sink ? 0.001 : 1
    g.scale.x += (sc - g.scale.x) * 0.2
    g.scale.y += (sc - g.scale.y) * 0.2
    g.scale.z += (sc - g.scale.z) * 0.2
  })
  return (
    <group ref={ref} position={[target.x, target.y, target.z]}>
      <LabwareMesh kind={lab.kind} labId={lab.id} fills={fills} used={used} magnet={magnet} />
    </group>
  )
}

/* ------------------------------------------------------------------- modules -- */

function ModuleMesh({ geom, mod, run }: { geom: DeckGeom; mod: DeckModule; run?: ModuleRun }) {
  const r = slotRect(geom, mod.slot)
  const def = moduleDef(mod.kind)
  const c = new THREE.Color(def.tint)
  const h = def.height
  const cx = worldX(geom.width, r.x + r.w / 2)
  const cz = worldZ(geom.height, r.y + r.h / 2)
  const active = run?.active
  const shakeRef = useRef<THREE.Group>(null)
  useFrame((st) => {
    if (shakeRef.current) shakeRef.current.position.x = run?.shaking ? Math.sin(st.clock.elapsedTime * 40) * 0.01 : 0
  })
  return (
    <group position={[cx, 0, cz]}>
      <group ref={shakeRef}>
        <RoundedBox args={[r.w * S * 0.94, h, r.h * S * 0.94]} radius={0.02} smoothness={3} position={[0, DECK_TOP + h / 2, 0]} castShadow receiveShadow>
          <meshPhysicalMaterial color={c} emissive={active ? def.tint : '#000'} emissiveIntensity={active ? 0.28 : 0} roughness={0.5} metalness={0.35} clearcoat={0.3} />
        </RoundedBox>
        {/* status LED strip */}
        <mesh position={[0, DECK_TOP + h - 0.015, r.h * S * 0.4]}>
          <boxGeometry args={[r.w * S * 0.5, 0.02, 0.03]} />
          <meshStandardMaterial color={active ? def.tint : '#7c7f74'} emissive={active ? def.tint : '#000'} emissiveIntensity={active ? 0.9 : 0} />
        </mesh>
      </group>
      {def.behavior.lid && (
        <mesh position={[0, DECK_TOP + h + (run?.lidOpen ? 0.26 : 0.05), run?.lidOpen ? -r.h * S * 0.3 : 0]} castShadow>
          <boxGeometry args={[r.w * S * 0.9, 0.1, r.h * S * 0.9]} />
          <meshStandardMaterial color={c} transparent opacity={run?.lidOpen ? 0.5 : 0.85} emissive={active ? def.tint : '#000'} emissiveIntensity={active ? 0.28 : 0} />
        </mesh>
      )}
    </group>
  )
}

/* --------------------------------------------------------------------- deck --- */

function Deck({ geom }: { geom: DeckGeom }) {
  const w = geom.width * S
  const d = geom.height * S
  return (
    <group>
      {/* deck chassis — sits on the benchtop */}
      <RoundedBox args={[w, DECK_H, d]} radius={0.04} smoothness={4} position={[0, TABLE_Y + DECK_H / 2, 0]} castShadow receiveShadow>
        <meshPhysicalMaterial color={SURFACE.deck} roughness={0.5} metalness={0.25} clearcoat={0.25} clearcoatRoughness={0.5} />
      </RoundedBox>
      {/* slot pockets */}
      {geom.slots.map((slot) => {
        const r = slotRect(geom, slot)
        const cx = worldX(geom.width, r.x + r.w / 2)
        const cz = worldZ(geom.height, r.y + r.h / 2)
        const staging = geom.staging.has(slot)
        return (
          <mesh key={slot} position={[cx, DECK_TOP - 0.008, cz]}>
            <boxGeometry args={[r.w * S * 0.9, 0.02, r.h * S * 0.9]} />
            <meshStandardMaterial color={staging ? SURFACE.deckRaised : SURFACE.slotFloor} roughness={0.7} metalness={0.1} />
            <Edges scale={1} threshold={15} color={SURFACE.slotWall} />
          </mesh>
        )
      })}
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
  target.current = { x: worldX(geom.width, state.pos.x), z: worldZ(geom.height, state.pos.y), dip: state.dipping }

  useFrame((_, dt) => {
    const k = Math.min(1, dt * 6)
    const t = target.current
    if (bridge.current) bridge.current.position.z += (t.z - bridge.current.position.z) * k
    if (carriage.current) {
      carriage.current.position.x += (t.x - carriage.current.position.x) * k
      carriage.current.position.z += (t.z - carriage.current.position.z) * k
      const targetY = DECK_TOP + (t.dip ? 0.9 : 1.25)
      carriage.current.position.y += (targetY - carriage.current.position.y) * k
    }
  })

  const halfX = (geom.width * S) / 2 + 0.12
  const railY = DECK_TOP + 1.6
  const headW = big ? 0.5 : multi ? 0.34 : 0.28

  return (
    <group>
      {/* side rails */}
      {[-halfX, halfX].map((x) => (
        <mesh key={x} position={[x, railY, 0]} castShadow>
          <boxGeometry args={[0.1, 0.1, geom.height * S + 0.4]} />
          <meshStandardMaterial color={SURFACE.rail} metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      {/* uprights */}
      {[-halfX, halfX].map((x) => (
        <mesh key={`u${x}`} position={[x, DECK_TOP + 0.8, -geom.height * S * 0.5 - 0.12]}>
          <boxGeometry args={[0.1, 1.7, 0.1]} />
          <meshStandardMaterial color={SURFACE.railDark} metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
      {/* moving bridge */}
      <group ref={bridge} position={[0, railY, 0]}>
        <mesh castShadow>
          <boxGeometry args={[geom.width * S + 0.3, 0.12, 0.14]} />
          <meshStandardMaterial color="#c2bfb5" metalness={0.35} roughness={0.45} />
        </mesh>
      </group>
      {/* carriage + pipette head */}
      <group ref={carriage} position={[worldX(geom.width, state.pos.x), DECK_TOP + 1.25, worldZ(geom.height, state.pos.y)]}>
        <mesh castShadow>
          <boxGeometry args={[headW, 0.5, multi || big ? 0.62 : 0.34]} />
          <meshStandardMaterial color="#33352f" metalness={0.2} roughness={0.55} />
        </mesh>
        <mesh position={[0, 0.28, 0]}>
          <boxGeometry args={[headW, 0.08, multi || big ? 0.62 : 0.34]} />
          <meshStandardMaterial color="#3f7d5c" metalness={0.2} roughness={0.5} />
        </mesh>
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
  const s = state ?? deriveRun(protocol, -1)
  const instruments = protocol.deck.instruments ?? []

  const colored: Record<string, Colored> = {}
  for (const [k, v] of Object.entries(s.fills as Record<string, WellFill>)) colored[k] = { color: liquidColor(protocol, v.liquid), volume: v.volume }
  const sampleColor = liquidColor(protocol, protocol.liquids[0]?.id)

  // World centre of each instrument (from its benchtop footprint). Cheap — a few instruments.
  const instCenters: Record<string, [number, number, number]> = {}
  for (const inst of instruments) {
    const r = instrumentRect(geom, inst.side)
    instCenters[inst.id] = [worldX(geom.width, r.x + r.w / 2), TABLE_Y, worldZ(geom.height, r.y + r.h / 2)]
  }

  // Content bounds → bench size + camera framing (must include off-deck instruments).
  const dw = geom.width * S
  const dd = geom.height * S
  let minX = -dw / 2
  let maxX = dw / 2
  let minZ = -dd / 2
  let maxZ = dd / 2
  for (const c of Object.values(instCenters)) {
    minX = Math.min(minX, c[0] - 1.4)
    maxX = Math.max(maxX, c[0] + 1.4)
    minZ = Math.min(minZ, c[2] - 1.3)
    maxZ = Math.max(maxZ, c[2] + 1.3)
  }
  const bounds = { minX, maxX, minZ, maxZ, centerX: (minX + maxX) / 2, spanX: maxX - minX, spanZ: maxZ - minZ }

  return (
    <>
      <StudioLighting />
      <LabBench spanX={bounds.spanX} spanZ={bounds.spanZ} centerX={bounds.centerX} />

      <Deck geom={geom} />

      {protocol.deck.modules.map((m) => (
        <ModuleMesh key={m.id} geom={geom} mod={m} run={s.modules[m.id]} />
      ))}

      {protocol.deck.labware.map((lab) => {
        const instId = s.inInstrument[lab.id]
        const slot = s.slotOf[lab.id] ?? lab.slot
        const modHere = protocol.deck.modules.find((m) => m.slot === slot)
        const magnet = modHere ? !!s.modules[modHere.id]?.magnet : false
        const lift = modHere ? moduleDef(modHere.kind).height : 0
        let target: THREE.Vector3
        let sink = false
        if (instId && instCenters[instId]) {
          const seat = centrifugeSeat(instCenters[instId])
          target = new THREE.Vector3(seat[0], seat[1], seat[2])
          sink = !!s.instruments[instId]?.running // hidden behind the lid while spinning
        } else {
          const r = slotRect(geom, slot)
          target = new THREE.Vector3(worldX(geom.width, r.x + r.w / 2), DECK_TOP + lift, worldZ(geom.height, r.y + r.h / 2))
        }
        return <LabwarePlacement key={lab.id} lab={lab} target={target} fills={colored} used={s.tipsUsed[lab.id] ?? {}} magnet={magnet} sink={sink} />
      })}

      {instruments.map((inst: Instrument) => (
        <Instrument3D key={inst.id} kind={inst.kind} center={instCenters[inst.id]} run={s.instruments[inst.id]} sampleColor={sampleColor} />
      ))}

      {state && <Gantry protocol={protocol} geom={geom} state={state} />}

      <GroundShadow spanX={bounds.spanX} spanZ={bounds.spanZ} centerX={bounds.centerX} />

      <CameraRig bounds={bounds} />
    </>
  )
}

/** Frames the whole content (deck + any instruments) and constrains the orbit to a tabletop view. */
function CameraRig({ bounds }: { bounds: { centerX: number; spanX: number; spanZ: number } }) {
  const dist = Math.max(bounds.spanX, bounds.spanZ) * 0.66 + 3.1
  return (
    <OrbitControls
      makeDefault
      enablePan={false}
      minDistance={dist * 0.55}
      maxDistance={dist * 1.8}
      maxPolarAngle={Math.PI / 2.12}
      target={[bounds.centerX, 0.5, 0]}
    />
  )
}

export function Deck3D({ protocol, state }: { protocol: Protocol; state?: RunState }) {
  const geom = deckGeom(protocol.deck.robot)
  const instruments = protocol.deck.instruments ?? []
  // Initial camera: derive the same framing the CameraRig targets so the first frame is composed.
  const dw = geom.width * S
  let minX = -dw / 2
  let maxX = dw / 2
  for (const inst of instruments) {
    const r = instrumentRect(geom, inst.side)
    const cx = worldX(geom.width, r.x + r.w / 2)
    minX = Math.min(minX, cx - 1.4)
    maxX = Math.max(maxX, cx + 1.4)
  }
  const centerX = (minX + maxX) / 2
  const spanX = maxX - minX
  const dist = Math.max(spanX, geom.height * S) * 0.66 + 3.1

  return (
    <Canvas
      shadows
      dpr={[1, 1.9]}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      camera={{ position: [centerX + dist * 0.5, dist * 0.74, dist * 1.04], fov: 38 }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#eeece6']} />
      <fog attach="fog" args={['#eeece6', dist * 2.2, dist * 4.4]} />
      <Scene protocol={protocol} state={state} />
    </Canvas>
  )
}

export default Deck3D

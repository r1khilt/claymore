import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import {
  DECK_W,
  DECK_H,
  slotRect,
  wellCenter,
  gridFor,
  type Labware,
  type Protocol,
  type RunState,
} from '@/lib/protocol'

const S = 0.026
const LETTERS = 'ABCDEFGH'
const LIQUID = '#57a07b'
const DECK_TOP = 0.2

const wx = (x: number) => (x - DECK_W / 2) * S
const wz = (y: number) => (y - DECK_H / 2) * S

function LabwareMesh({ lab, fills }: { lab: Labware; fills: Record<string, number> }) {
  const r = slotRect(lab.slot)
  const base: [number, number, number] = [wx(r.x + r.w / 2), DECK_TOP + 0.06, wz(r.y + r.h / 2)]

  if (lab.kind === 'reservoir_12') {
    return (
      <group>
        <mesh position={base} castShadow>
          <boxGeometry args={[r.w * S * 0.94, 0.12, r.h * S * 0.94]} />
          <meshStandardMaterial color="#cfe0ee" />
        </mesh>
        {Array.from({ length: 12 }).map((_, c) => {
          const g = wellCenter(lab.slot, lab.kind, 0, c)
          return (
            <mesh key={c} position={[wx(g.x), DECK_TOP + 0.14, wz(g.y)]}>
              <boxGeometry args={[g.rx * S * 1.5, 0.06, r.h * S * 0.8]} />
              <meshStandardMaterial color="#bcd3e2" />
            </mesh>
          )
        })}
      </group>
    )
  }

  const { rows, cols } = gridFor(lab.kind)
  const tiprack = lab.kind === 'tiprack_96'
  return (
    <group>
      <mesh position={base} receiveShadow>
        <boxGeometry args={[r.w * S * 0.94, 0.1, r.h * S * 0.94]} />
        <meshStandardMaterial color={tiprack ? '#e4e7df' : '#f3f2ee'} />
      </mesh>
      {Array.from({ length: rows }).map((_, row) =>
        Array.from({ length: cols }).map((_, col) => {
          const g = wellCenter(lab.slot, lab.kind, row, col)
          const key = `${lab.id}:${LETTERS[row]}${col + 1}`
          const vol = fills[key] ?? 0
          const filled = !tiprack && vol > 0
          const rad = g.rx * S * 0.92
          return (
            <mesh key={key} position={[wx(g.x), DECK_TOP + 0.13, wz(g.y)]}>
              <cylinderGeometry args={[rad, rad, tiprack ? 0.16 : 0.1, 12]} />
              <meshStandardMaterial
                color={tiprack ? '#cdd2c8' : filled ? LIQUID : '#e9e9e1'}
                emissive={filled ? LIQUID : '#000000'}
                emissiveIntensity={filled ? 0.25 : 0}
              />
            </mesh>
          )
        }),
      )}
    </group>
  )
}

function Gantry({ protocol, state }: { protocol: Protocol; state: RunState }) {
  const bridge = useRef<THREE.Group>(null)
  const carriage = useRef<THREE.Group>(null)
  const multi = protocol.deck.pipette.channels === 8

  const target = useRef({ x: wx(state.pos.x), z: wz(state.pos.y), dip: state.dipping })
  target.current = { x: wx(state.pos.x), z: wz(state.pos.y), dip: state.dipping }

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

  const half = (DECK_W * S) / 2 + 0.15
  return (
    <group>
      {/* side rails */}
      <mesh position={[-half, 1.75, 0]}>
        <boxGeometry args={[0.12, 0.12, DECK_H * S + 0.4]} />
        <meshStandardMaterial color="#b9b6ac" />
      </mesh>
      <mesh position={[half, 1.75, 0]}>
        <boxGeometry args={[0.12, 0.12, DECK_H * S + 0.4]} />
        <meshStandardMaterial color="#b9b6ac" />
      </mesh>
      {/* moving bridge */}
      <group ref={bridge}>
        <mesh position={[0, 1.75, 0]}>
          <boxGeometry args={[DECK_W * S + 0.3, 0.14, 0.16]} />
          <meshStandardMaterial color="#cbc8be" />
        </mesh>
      </group>
      {/* carriage */}
      <group ref={carriage} position={[wx(state.pos.x), 1.35, wz(state.pos.y)]}>
        <mesh castShadow>
          <boxGeometry args={[0.34, 0.5, multi ? 0.62 : 0.34]} />
          <meshStandardMaterial color="#33352f" />
        </mesh>
        <mesh position={[0, 0.28, 0]}>
          <boxGeometry args={[0.34, 0.08, multi ? 0.62 : 0.34]} />
          <meshStandardMaterial color="#3f7d5c" />
        </mesh>
        {/* nozzles / tips */}
        {Array.from({ length: multi ? 8 : 1 }).map((_, i) => {
          const z = multi ? -0.245 + i * 0.07 : 0
          return (
            <mesh key={i} position={[0, -0.42, z]}>
              <cylinderGeometry args={[0.02, 0.03, 0.28, 8]} />
              <meshStandardMaterial color={state.hasTip ? '#c9ccc3' : '#5a5c54'} />
            </mesh>
          )
        })}
      </group>
    </group>
  )
}

function Scene({ protocol, state }: { protocol: Protocol; state?: RunState }) {
  return (
    <>
      <ambientLight intensity={0.75} />
      <hemisphereLight args={['#ffffff', '#d8d4c8', 0.5]} />
      <directionalLight position={[6, 10, 6]} intensity={1.1} castShadow />
      {/* deck plate */}
      <mesh position={[0, 0, 0]} receiveShadow>
        <boxGeometry args={[DECK_W * S, 0.4, DECK_H * S]} />
        <meshStandardMaterial color="#dcd9cf" />
      </mesh>
      {/* slot outlines */}
      {Array.from({ length: 11 }).map((_, i) => {
        const r = slotRect(i + 1)
        return (
          <mesh key={i} position={[wx(r.x + r.w / 2), DECK_TOP + 0.005, wz(r.y + r.h / 2)]}>
            <boxGeometry args={[r.w * S * 0.96, 0.02, r.h * S * 0.96]} />
            <meshStandardMaterial color="#eceae2" />
          </mesh>
        )
      })}
      {protocol.deck.labware.map((lab) => (
        <LabwareMesh key={lab.id} lab={lab} fills={state?.fills ?? {}} />
      ))}
      {state && <Gantry protocol={protocol} state={state} />}
      <OrbitControls
        enablePan={false}
        minDistance={7}
        maxDistance={18}
        maxPolarAngle={Math.PI / 2.15}
        target={[0, 0.3, 0]}
      />
    </>
  )
}

export function Deck3D({ protocol, state }: { protocol: Protocol; state?: RunState }) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [6.5, 8, 11], fov: 42 }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#f2f1ec']} />
      <Scene protocol={protocol} state={state} />
    </Canvas>
  )
}

export default Deck3D

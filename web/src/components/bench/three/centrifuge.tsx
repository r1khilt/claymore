/**
 * Off-deck instruments the agent composes when a request leaves the Opentrons deck — a bespoke,
 * animated 3D model per kind. The centrifuge is the hero: a benchtop bowl centrifuge with rubber
 * feet, a raked control panel + live digital display, a smoked hinged lid, and a swing-bucket rotor
 * that seats the plate, spins up, holds, and spins down (buckets swing out under load, subtle hum).
 *
 * The run state drives everything: `lidOpen` swings the lid, `running` ramps the rotor, `rpm`/
 * `seconds` render on the display. The plate is carried in by the Scene and parked on the front
 * bucket seat (`centrifugeSeat`) while the lid is open; once spinning it disappears behind the
 * smoked lid and the rotor's own bucket-plate represents it (you can't see a plate at 3000 rpm).
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import type { InstrumentKind } from '@/lib/hardware'
import { instrumentDef } from '@/lib/hardware'
import type { InstrumentRun } from '@/lib/protocol'
import { TABLE_Y } from './scene'

/* ---- centrifuge dimensions (world units) ---- */
const BODY_R = 1.12
const BODY_H = 0.92
const BOWL_R = 0.86
const RIM_Y = TABLE_Y + BODY_H
const ROTOR_Y = TABLE_Y + 0.58
const BUCKET_R = 0.5
const N_BUCKETS = 4
const PLATE_SEAT_Y = 0.14

/** World position the plate rests at when parked on the front bucket (rotor at 0, lid open). */
export function centrifugeSeat(center: [number, number, number]): [number, number, number] {
  return [center[0], ROTOR_Y + PLATE_SEAT_Y, center[2] + BUCKET_R]
}

/* ---- live digital display (canvas texture, no font fetch) ---- */

function useDisplayTexture(run?: InstrumentRun): THREE.CanvasTexture {
  const rpm = run?.rpm ?? 3000
  const seconds = run?.seconds ?? 10
  const running = !!run?.running
  return useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 132
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#0c130f'
    ctx.fillRect(0, 0, 256, 132)
    ctx.fillStyle = running ? '#7fe3a4' : '#3f6f56'
    ctx.font = "bold 62px 'Courier New', monospace"
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    const mm = Math.floor(seconds / 60)
    const ss = seconds % 60
    ctx.fillText(`${mm}:${String(ss).padStart(2, '0')}`, 128, 46)
    ctx.font = "bold 30px 'Courier New', monospace"
    ctx.fillStyle = running ? '#bfe8cf' : '#4f7d63'
    ctx.fillText(`${rpm.toLocaleString()} RPM`, 128, 98)
    // status dot
    ctx.beginPath()
    ctx.arc(22, 22, 8, 0, Math.PI * 2)
    ctx.fillStyle = running ? '#7fe3a4' : '#c46a4f'
    ctx.fill()
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    return tex
  }, [rpm, seconds, running])
}

/* ---- rotor + buckets ---- */

function Rotor({ run, sampleColor, speedRef }: { run?: InstrumentRun; sampleColor: string; speedRef: React.MutableRefObject<number> }) {
  const buckets = useRef<THREE.Group[]>([])
  const loaded = !!run?.loaded

  useFrame(() => {
    const s = speedRef.current // 0..1
    // buckets swing from hanging (rest) toward horizontal as speed rises
    const swing = -0.28 + s * (Math.PI / 2 + 0.28)
    for (const b of buckets.current) if (b) b.rotation.x = swing
  })

  return (
    <group>
      {/* hub */}
      <mesh position={[0, ROTOR_Y, 0]} castShadow>
        <cylinderGeometry args={[0.2, 0.26, 0.16, 24]} />
        <meshStandardMaterial color="#8a8f96" metalness={0.85} roughness={0.28} />
      </mesh>
      <mesh position={[0, ROTOR_Y + 0.1, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 0.06, 16]} />
        <meshStandardMaterial color="#454a50" metalness={0.7} roughness={0.4} />
      </mesh>
      {Array.from({ length: N_BUCKETS }).map((_, i) => {
        const a = (i / N_BUCKETS) * Math.PI * 2
        return (
          <group key={i} position={[0, ROTOR_Y, 0]} rotation={[0, a, 0]}>
            {/* arm */}
            <mesh position={[0, 0, BUCKET_R * 0.6]} castShadow>
              <boxGeometry args={[0.06, 0.05, BUCKET_R * 1.2]} />
              <meshStandardMaterial color="#9a9ea4" metalness={0.8} roughness={0.3} />
            </mesh>
            {/* swing bucket pivots at the arm end */}
            <group ref={(el) => { if (el) buckets.current[i] = el }} position={[0, 0, BUCKET_R]}>
              <mesh position={[0, -0.14, 0]} castShadow>
                <boxGeometry args={[0.42, 0.3, 0.32]} />
                <meshStandardMaterial color="#b8bcc0" metalness={0.55} roughness={0.4} />
              </mesh>
              {/* the plate rides in bucket 0 when loaded */}
              {loaded && i === 0 && (
                <mesh position={[0, -0.05, 0]} castShadow>
                  <boxGeometry args={[0.34, 0.12, 0.24]} />
                  <meshPhysicalMaterial color="#f2f1ec" roughness={0.4} clearcoat={0.5} />
                  <mesh position={[0, 0.07, 0]}>
                    <boxGeometry args={[0.28, 0.03, 0.2]} />
                    <meshStandardMaterial color={sampleColor} emissive={sampleColor} emissiveIntensity={0.25} />
                  </mesh>
                </mesh>
              )}
            </group>
            {/* faint spoke to suggest the spinning disc */}
            <mesh position={[0, -0.02, BUCKET_R * 0.5]}>
              <boxGeometry args={[0.012, 0.01, BUCKET_R]} />
              <meshStandardMaterial color="#6d7278" metalness={0.6} roughness={0.5} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

function Centrifuge({ center, run, sampleColor }: { center: [number, number, number]; run?: InstrumentRun; sampleColor: string }) {
  const bodyRef = useRef<THREE.Group>(null)
  const rotorSpin = useRef<THREE.Group>(null)
  const lidRef = useRef<THREE.Group>(null)
  const speedRef = useRef(0)
  const angleRef = useRef(0)
  const display = useDisplayTexture(run)

  const running = !!run?.running
  const lidOpen = !!run?.lidOpen

  useFrame((_, dt) => {
    const d = Math.min(1, dt * 4)
    // ease rotor speed toward target (0 idle, 1 full) → smooth spin-up / spin-down
    speedRef.current += ((running ? 1 : 0) - speedRef.current) * d
    const s = speedRef.current
    if (rotorSpin.current) {
      angleRef.current += s * 0.9 // rad per frame at full speed → reads as a fast blur
      rotorSpin.current.rotation.y = angleRef.current
    }
    // lid swings open/closed
    if (lidRef.current) {
      const target = lidOpen ? -1.45 : 0
      lidRef.current.rotation.x += (target - lidRef.current.rotation.x) * Math.min(1, dt * 6)
    }
    // hum / vibration while spinning
    if (bodyRef.current) {
      const j = s * 0.004
      bodyRef.current.position.x = center[0] + (s > 0.02 ? Math.sin(angleRef.current * 3.1) * j : 0)
      bodyRef.current.position.z = center[2] + (s > 0.02 ? Math.cos(angleRef.current * 2.7) * j : 0)
    }
  })

  return (
    <group ref={bodyRef} position={center}>
      {/* rubber feet */}
      {[[-0.8, -0.6], [0.8, -0.6], [-0.8, 0.6], [0.8, 0.6]].map(([x, z], i) => (
        <mesh key={i} position={[x, TABLE_Y + 0.03, z]}>
          <cylinderGeometry args={[0.09, 0.11, 0.06, 16]} />
          <meshStandardMaterial color="#2c2e2b" roughness={0.9} />
        </mesh>
      ))}

      {/* main body — a rounded bowl housing */}
      <mesh position={[0, TABLE_Y + BODY_H / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[BODY_R, BODY_R * 1.06, BODY_H, 48]} />
        <meshPhysicalMaterial color="#eceae3" roughness={0.42} clearcoat={0.6} clearcoatRoughness={0.35} />
      </mesh>
      {/* body shoulder / bezel */}
      <mesh position={[0, RIM_Y - 0.02, 0]}>
        <cylinderGeometry args={[BODY_R * 1.02, BODY_R, 0.1, 48]} />
        <meshPhysicalMaterial color="#d9d7cf" roughness={0.5} clearcoat={0.4} />
      </mesh>
      {/* recessed bowl (dark interior) */}
      <mesh position={[0, RIM_Y - 0.16, 0]}>
        <cylinderGeometry args={[BOWL_R, BOWL_R * 0.9, 0.32, 48, 1, true]} />
        <meshStandardMaterial color="#2a2c28" roughness={0.8} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, ROTOR_Y - 0.02, 0]}>
        <cylinderGeometry args={[BOWL_R * 0.92, BOWL_R * 0.7, 0.04, 48]} />
        <meshStandardMaterial color="#202220" roughness={0.85} />
      </mesh>

      {/* rotor (spins as a group) */}
      <group ref={rotorSpin}>
        <Rotor run={run} sampleColor={sampleColor} speedRef={speedRef} />
      </group>

      {/* hinged smoked lid — pivots at the back rim */}
      <group ref={lidRef} position={[0, RIM_Y, -BOWL_R]}>
        <group position={[0, 0, BOWL_R]}>
          {/* lid dome — smoked acrylic, see the rotor through it */}
          <mesh position={[0, 0.16, 0]} castShadow>
            <sphereGeometry args={[BOWL_R * 1.04, 44, 28, 0, Math.PI * 2, 0, Math.PI / 2.05]} />
            <meshPhysicalMaterial color="#7c93a3" transparent opacity={0.22} roughness={0.06} metalness={0.05} clearcoat={1} clearcoatRoughness={0.04} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          {/* thin tint band near the base of the dome */}
          <mesh position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[BOWL_R * 0.99, 0.02, 8, 44]} />
            <meshStandardMaterial color="#6f8798" transparent opacity={0.5} />
          </mesh>
          {/* lid rim ring */}
          <mesh position={[0, 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[BOWL_R * 1.02, 0.05, 10, 44]} />
            <meshStandardMaterial color="#c9c7bf" metalness={0.3} roughness={0.5} />
          </mesh>
          {/* latch handle at the front */}
          <mesh position={[0, 0.1, BOWL_R * 0.98]} castShadow>
            <boxGeometry args={[0.28, 0.09, 0.12]} />
            <meshStandardMaterial color="#c4c2ba" metalness={0.35} roughness={0.5} />
          </mesh>
        </group>
      </group>

      {/* raked front control panel */}
      <group position={[0, TABLE_Y + 0.34, BODY_R * 0.92]} rotation={[-0.42, 0, 0]}>
        <RoundedBox args={[1.05, 0.5, 0.1]} radius={0.03} smoothness={3} castShadow>
          <meshPhysicalMaterial color="#e4e2da" roughness={0.5} clearcoat={0.3} />
        </RoundedBox>
        {/* display */}
        <mesh position={[-0.18, 0.06, 0.055]}>
          <planeGeometry args={[0.56, 0.28]} />
          <meshBasicMaterial map={display} toneMapped={false} />
        </mesh>
        {/* buttons */}
        {[0, 1].map((i) => (
          <mesh key={i} position={[0.3, 0.12 - i * 0.18, 0.06]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.045, 0.045, 0.03, 20]} />
            <meshStandardMaterial color={i === 0 ? '#5f8257' : '#b4623f'} roughness={0.5} />
          </mesh>
        ))}
        <mesh position={[0.3, -0.15, 0.055]}>
          <boxGeometry args={[0.22, 0.04, 0.02]} />
          <meshStandardMaterial color="#b8b6ae" roughness={0.6} />
        </mesh>
      </group>

      {/* status light on the shoulder */}
      <mesh position={[BODY_R * 0.62, RIM_Y + 0.01, BODY_R * 0.5]}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshStandardMaterial color={running ? '#7fe3a4' : '#8b8f86'} emissive={running ? '#4fbf7f' : '#000'} emissiveIntensity={running ? 0.9 : 0} />
      </mesh>
    </group>
  )
}

/* ---- generic off-deck instrument (imager, sequencer, …): a boxed unit with a door + display ---- */

function GenericInstrument({ kind, center, run }: { kind: InstrumentKind; center: [number, number, number]; run?: InstrumentRun }) {
  const def = instrumentDef(kind)
  const display = useDisplayTexture(run)
  const running = !!run?.running
  const doorRef = useRef<THREE.Group>(null)
  const lidOpen = !!run?.lidOpen
  useFrame((_, dt) => {
    if (doorRef.current) {
      const target = lidOpen ? -1.2 : 0
      doorRef.current.rotation.x += (target - doorRef.current.rotation.x) * Math.min(1, dt * 6)
    }
  })
  const W = 1.9
  const H = 1.5
  const D = 1.6
  return (
    <group position={center}>
      {/* housing */}
      <RoundedBox args={[W, H, D]} radius={0.06} smoothness={4} position={[0, TABLE_Y + H / 2, 0]} castShadow receiveShadow>
        <meshPhysicalMaterial color="#e7e5de" roughness={0.45} clearcoat={0.5} clearcoatRoughness={0.35} />
      </RoundedBox>
      {/* front bezel */}
      <mesh position={[0, TABLE_Y + H / 2, D / 2 + 0.005]}>
        <boxGeometry args={[W * 0.9, H * 0.86, 0.02]} />
        <meshStandardMaterial color="#dcdad2" roughness={0.6} />
      </mesh>
      {/* drawer/door that opens for the plate */}
      <group ref={doorRef} position={[0, TABLE_Y + 0.34, D / 2]}>
        <mesh position={[0, 0, 0.02]} castShadow>
          <boxGeometry args={[W * 0.6, 0.3, 0.06]} />
          <meshStandardMaterial color="#cfcdc4" roughness={0.55} />
        </mesh>
      </group>
      {/* display */}
      <mesh position={[0, TABLE_Y + H * 0.74, D / 2 + 0.02]}>
        <planeGeometry args={[0.66, 0.34]} />
        <meshBasicMaterial map={display} toneMapped={false} />
      </mesh>
      {/* accent stripe + status */}
      <mesh position={[0, TABLE_Y + H * 0.5, D / 2 + 0.015]}>
        <boxGeometry args={[W * 0.9, 0.03, 0.01]} />
        <meshStandardMaterial color={def.tint} />
      </mesh>
      <mesh position={[W * 0.38, TABLE_Y + H * 0.86, D / 2 + 0.02]}>
        <sphereGeometry args={[0.045, 16, 16]} />
        <meshStandardMaterial color={running ? '#7fe3a4' : '#8b8f86'} emissive={running ? '#4fbf7f' : '#000'} emissiveIntensity={running ? 0.9 : 0} />
      </mesh>
    </group>
  )
}

export function Instrument3D({ kind, center, run, sampleColor }: { kind: InstrumentKind; center: [number, number, number]; run?: InstrumentRun; sampleColor: string }) {
  if (kind === 'centrifuge') return <Centrifuge center={center} run={run} sampleColor={sampleColor} />
  return <GenericInstrument kind={kind} center={center} run={run} />
}

/**
 * The room the robot lives in — a real environment so nothing reads as floating.
 *
 * A pale lab benchtop (with a cabinet base) sits on a soft floor; an inline `Environment` built
 * from `Lightformer` panels (no network / HDR asset) gives plastic + metal their reflections; a
 * `ContactShadows` pad under the whole rig plants it on the bench. Sized to the scene's content so
 * it always spans the deck *and* any off-deck instruments to the side.
 */
import { ContactShadows, Environment, Lightformer, RoundedBox } from '@react-three/drei'
import { BENCH_H, FLOOR_Y, SURFACE, TABLE_Y } from './scene'

/** Studio softbox rig baked into an env map — keeps reflections warm + directional, fully offline. */
export function StudioLighting() {
  return (
    <>
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#fbfaf6', '#cfc8ba', 0.55]} />
      {/* key light — casts the form shadows */}
      <directionalLight
        position={[5, 9, 4]}
        intensity={1.35}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
      >
        <orthographicCamera attach="shadow-camera" args={[-6, 6, 6, -6, 0.1, 30]} />
      </directionalLight>
      {/* cool fill from the opposite side keeps shadows from going muddy */}
      <directionalLight position={[-5, 4, -3]} intensity={0.35} color="#e8eef4" />

      <Environment resolution={256} frames={1}>
        <group rotation={[0, 0, 0]}>
          {/* big soft key overhead */}
          <Lightformer form="rect" intensity={1.4} color="#ffffff" position={[0, 6, 1]} scale={[10, 6, 1]} rotation={[-Math.PI / 2, 0, 0]} />
          {/* warm front fill */}
          <Lightformer form="rect" intensity={0.7} color="#fff2e0" position={[0, 2, 6]} scale={[8, 4, 1]} />
          {/* cool rim lights left + right for edge definition on plastic */}
          <Lightformer form="rect" intensity={1.1} color="#eaf1f7" position={[-6, 3, -2]} scale={[3, 5, 1]} rotation={[0, Math.PI / 2, 0]} />
          <Lightformer form="rect" intensity={1.1} color="#eaf1f7" position={[6, 3, -2]} scale={[3, 5, 1]} rotation={[0, -Math.PI / 2, 0]} />
          {/* subtle ceiling gradient */}
          <Lightformer form="ring" intensity={0.5} color="#ffffff" position={[0, 8, 0]} scale={[6, 6, 1]} rotation={[-Math.PI / 2, 0, 0]} />
        </group>
      </Environment>
    </>
  )
}

/**
 * The lab bench + floor. `spanX`/`spanZ` are the world footprint to cover, `centerX` shifts the
 * bench so it stays under content that extends to one side (the off-deck instruments).
 */
export function LabBench({ spanX, spanZ, centerX }: { spanX: number; spanZ: number; centerX: number }) {
  const topW = spanX + 2.4
  const topD = spanZ + 2.0
  const cabInset = 0.5
  const cabH = 2.2

  return (
    <group position={[centerX, 0, 0]}>
      {/* floor */}
      <mesh position={[0, FLOOR_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[topW + 26, topD + 26]} />
        <meshStandardMaterial color={SURFACE.floor} roughness={0.95} />
      </mesh>

      {/* benchtop slab — top face sits exactly at TABLE_Y */}
      <RoundedBox
        args={[topW, BENCH_H, topD]}
        radius={0.05}
        smoothness={4}
        position={[0, TABLE_Y - BENCH_H / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshPhysicalMaterial color={SURFACE.benchTop} roughness={0.55} clearcoat={0.25} clearcoatRoughness={0.6} />
      </RoundedBox>
      {/* a slightly darker edge band reads as the benchtop's laminate lip */}
      <mesh position={[0, TABLE_Y - BENCH_H - 0.015, 0]}>
        <boxGeometry args={[topW - 0.06, 0.06, topD - 0.06]} />
        <meshStandardMaterial color={SURFACE.benchTopEdge} roughness={0.7} />
      </mesh>

      {/* cabinet base, inset under the top so the bench reads as furniture, grounded */}
      <mesh position={[0, TABLE_Y - BENCH_H - cabH / 2 - 0.05, cabInset * 0.4]} castShadow receiveShadow>
        <boxGeometry args={[topW - cabInset * 2, cabH, topD - cabInset * 2]} />
        <meshStandardMaterial color={SURFACE.cabinet} roughness={0.8} />
      </mesh>
      {/* a seam line hinting at cabinet doors */}
      <mesh position={[0, TABLE_Y - BENCH_H - cabH / 2 - 0.05, topD / 2 - cabInset - 0.005]}>
        <boxGeometry args={[0.015, cabH * 0.82, 0.02]} />
        <meshStandardMaterial color={SURFACE.cabinetShadow} roughness={0.9} />
      </mesh>
    </group>
  )
}

/** Soft contact shadow that plants the whole rig on the benchtop (kills the floating look). */
export function GroundShadow({ spanX, spanZ, centerX }: { spanX: number; spanZ: number; centerX: number }) {
  return (
    <ContactShadows
      position={[centerX, TABLE_Y + 0.002, 0]}
      scale={Math.max(spanX, spanZ) + 3}
      resolution={1024}
      blur={2.6}
      opacity={0.42}
      far={2}
      color="#3a352c"
    />
  )
}

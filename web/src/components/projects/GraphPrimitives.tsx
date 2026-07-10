/**
 * Graph primitives — hand-rolled r3f nodes + edges for the knowledge graph.
 *
 * Nodes: an emissive core sphere + an additive-blend halo sprite (the glow —
 * the doc's postprocessing-free fallback, so the demo never depends on a Bloom
 * pass resolving against three 0.185). Edges: a single LineSegments geometry for
 * solid edges (per-edge vertex color) + one dashed LineSegments for predicted
 * (gold, dashed) — both updated in place each frame from the live sim positions.
 */
import { useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { GraphEdge, GraphNode, GraphNodeKind, EdgeState } from '@/lib/projectTypes'
import type { PosMap } from '@/lib/graphLayout'

export const KIND_COLOR: Record<GraphNodeKind, string> = {
  Gene: '#3f7d5c',
  Protein: '#b4623f',
  Hypothesis: '#c67f3d',
  Method: '#6f7268',
  Result: '#2a543d',
  Assay: '#6ba079',
  Compound: '#dca059',
  Phenotype: '#1c1d18',
}

export const EDGE_COLOR: Record<EdgeState, string> = {
  asserted: '#4a4b44',
  predicted: '#dca059',
  contradiction: '#d05a4a',
  confirmed: '#3f7d5c',
  refuted: '#d05a4a',
}

const EDGE_ALPHA: Record<EdgeState, number> = {
  asserted: 0.34,
  predicted: 0.95,
  contradiction: 0.85,
  confirmed: 1,
  refuted: 0.8,
}

const CANVAS_BG = new THREE.Color('#f4f2ec')

/** A soft radial-gradient sprite texture — the node halo. Built once. */
export function makeHaloTexture(): THREE.Texture {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** node id → degree, for radius scaling. */
export function degreeMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const d = new Map<string, number>()
  for (const n of nodes) d.set(n.id, 0)
  for (const e of edges) {
    if (e.source === e.target) continue
    d.set(e.source, (d.get(e.source) ?? 0) + 1)
    d.set(e.target, (d.get(e.target) ?? 0) + 1)
  }
  return d
}

export function NodeMesh({
  node,
  radius,
  color,
  halo,
  posRef,
  dim,
  selected,
  onOver,
  onOut,
  onSelect,
}: {
  node: GraphNode
  radius: number
  color: string
  halo: THREE.Texture
  posRef: MutableRefObject<PosMap>
  dim: boolean
  selected: boolean
  onOver: (n: GraphNode) => void
  onOut: () => void
  onSelect: (n: GraphNode) => void
}) {
  const ref = useRef<THREE.Group>(null)
  useFrame(() => {
    const p = posRef.current.get(node.id)
    if (!p || !ref.current) return
    // Snap to the live sim position (the sim itself moves smoothly frame-to-frame),
    // so node centers stay locked to their edge endpoints — no lerp lag = no detach.
    ref.current.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0)
    // scale still eases (the bloom-in pop from 0.01 → 1, and the select bump).
    const target = selected ? 1.25 : 1
    const s = ref.current.scale.x + (target - ref.current.scale.x) * 0.15
    ref.current.scale.setScalar(s)
  })
  const coreOpacity = dim ? 0.22 : 1
  const haloOpacity = dim ? 0.04 : selected ? 0.6 : 0.3
  return (
    <group
      ref={ref}
      scale={0.01}
      onPointerOver={(e) => {
        e.stopPropagation()
        onOver(node)
      }}
      onPointerOut={onOut}
      onPointerDown={(e) => {
        e.stopPropagation()
        onSelect(node)
      }}
    >
      <sprite scale={radius * 6}>
        <spriteMaterial
          map={halo}
          color={color}
          transparent
          opacity={haloOpacity}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </sprite>
      <mesh>
        <sphereGeometry args={[radius, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.95 : 0.4}
          roughness={0.34}
          metalness={0.1}
          transparent
          opacity={coreOpacity}
        />
      </mesh>
    </group>
  )
}

/** Dim a color toward the canvas background (used to fade non-selected edges). */
function dimColor(hex: string, alpha: number): THREE.Color {
  return new THREE.Color(hex).lerp(CANVAS_BG, 1 - alpha)
}

/** All edges of a given "class" (solid vs dashed) rendered as one LineSegments,
 *  positions refreshed each frame from the live layout. */
export function EdgesLayer({
  edges,
  posRef,
  activeEdges,
  variant,
}: {
  edges: GraphEdge[]
  posRef: MutableRefObject<PosMap>
  activeEdges: Set<string> | null
  variant: 'solid' | 'dashed'
}) {
  const list = useMemo(
    () => edges.filter((e) => (variant === 'dashed' ? e.state === 'predicted' : e.state !== 'predicted')),
    [edges, variant],
  )
  const segRef = useRef<THREE.LineSegments>(null)

  // Positions only resize when the edge COUNT changes (stable ref otherwise), so a
  // hover/selection never reallocates or re-uploads the position buffer as zeros.
  const positions = useMemo(() => new Float32Array(list.length * 6), [list.length])

  // Colors rebuild when edge states or the selection change (this IS what hover touches).
  const colors = useMemo(() => {
    const col = new Float32Array(list.length * 6)
    list.forEach((e, i) => {
      const active = !activeEdges || activeEdges.has(e.id)
      const c = dimColor(EDGE_COLOR[e.state], (active ? 1 : 0.12) * EDGE_ALPHA[e.state])
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6)
    })
    return col
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.map((e) => `${e.id}:${e.state}`).join(','), activeEdges])

  useFrame(() => {
    const seg = segRef.current
    if (!seg) return
    const arr = (seg.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    let moved = false
    list.forEach((e, i) => {
      const s = posRef.current.get(e.source)
      const t = posRef.current.get(e.target)
      if (!s || !t) return
      const v = [s.x ?? 0, s.y ?? 0, s.z ?? 0, t.x ?? 0, t.y ?? 0, t.z ?? 0]
      for (let k = 0; k < 6; k++) {
        const idx = i * 6 + k
        if (arr[idx] !== v[k]) {
          arr[idx] = v[k]
          moved = true
        }
      }
    })
    // Only re-upload when something actually moved — once the sim settles, this is a no-op.
    if (moved) {
      ;(seg.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
      if (variant === 'dashed') seg.computeLineDistances()
    }
  })

  // Re-key so the buffers are recreated when the edge count changes (append during build).
  const key = `${variant}-${list.length}`

  if (list.length === 0) return null
  return (
    <lineSegments ref={segRef} key={key}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      {variant === 'dashed' ? (
        <lineDashedMaterial vertexColors transparent dashSize={0.28} gapSize={0.2} linewidth={1} />
      ) : (
        <lineBasicMaterial vertexColors transparent linewidth={1} />
      )}
    </lineSegments>
  )
}

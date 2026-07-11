/**
 * Graph primitives — hand-rolled r3f nodes, in-scene labels, and edges.
 *
 * Nodes: an emissive core sphere + a restrained additive halo (a glow, not a
 * blow-out). Labels: crisp canvas-texture sprites that live in the scene, so they
 * billboard, depth-sort, and fog into the distance for free — no DOM overlays,
 * no font fetch (the demo runs offline). Edges: one LineSegments for solid edges
 * (per-edge vertex color) + one dashed LineSegments for predicted (gold), both
 * refreshed in place each frame from the live sim positions.
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
  Method: '#7d8a80',
  Result: '#2a543d',
  Assay: '#6ba079',
  Compound: '#dca059',
  Phenotype: '#4a4b44',
}

export const EDGE_COLOR: Record<EdgeState, string> = {
  asserted: '#5a5b52',
  predicted: '#c98a3c',
  contradiction: '#c65744',
  confirmed: '#3f7d5c',
  refuted: '#c65744',
}

const EDGE_ALPHA: Record<EdgeState, number> = {
  asserted: 0.26,
  predicted: 0.92,
  contradiction: 0.78,
  confirmed: 1,
  refuted: 0.72,
}

const CANVAS_BG = new THREE.Color('#f4f2ec')

/* ------------------------------------------------------------------- labels -- */

/** A cached canvas-texture label. Text is drawn with a soft light halo so it stays
 *  legible over edges, and supersampled (×DPR) so it's crisp at the fitted zoom. */
export interface LabelTex {
  texture: THREE.Texture
  aspect: number
}
const LABEL_CACHE = new Map<string, LabelTex>()
const LABEL_FONT = "600 32px 'Inter Variable', Inter, system-ui, sans-serif"

function truncate(s: string, max = 20): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

export function makeLabelTexture(raw: string): LabelTex {
  const text = truncate(raw)
  const cached = LABEL_CACHE.get(text)
  if (cached) return cached

  const dpr = Math.min(3, Math.max(2, Math.round(globalThis.devicePixelRatio || 2)))
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = LABEL_FONT
  const padX = 10
  const padY = 8
  const textW = Math.ceil(measure.measureText(text).width)
  const w = textW + padX * 2
  const h = 32 + padY * 2

  const c = document.createElement('canvas')
  c.width = Math.ceil(w * dpr)
  c.height = Math.ceil(h * dpr)
  const ctx = c.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.font = LABEL_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const cx = w / 2
  const cy = h / 2
  // Soft light halo (stroke in the canvas background) so text reads over any edge.
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(244,242,236,0.92)'
  ctx.lineWidth = 6
  ctx.strokeText(text, cx, cy)
  ctx.fillStyle = '#26271f'
  ctx.fillText(text, cx, cy)

  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 4
  texture.needsUpdate = true
  const out = { texture, aspect: w / h }
  LABEL_CACHE.set(text, out)
  return out
}

/** A billboarded label sprite that follows its node and eases opacity. */
export function NodeLabel({
  node,
  radius,
  posRef,
  show,
}: {
  node: GraphNode
  radius: number
  posRef: MutableRefObject<PosMap>
  show: boolean
}) {
  const ref = useRef<THREE.Sprite>(null)
  const mat = useRef<THREE.SpriteMaterial>(null)
  const label = useMemo(() => makeLabelTexture(node.label), [node.label])
  const height = 0.5
  useFrame(() => {
    const p = posRef.current.get(node.id)
    const s = ref.current
    if (!p || !s) return
    s.position.set(p.x ?? 0, (p.y ?? 0) + radius + 0.46, p.z ?? 0)
    if (mat.current) {
      const target = show ? 1 : 0
      mat.current.opacity += (target - mat.current.opacity) * 0.18
      s.visible = mat.current.opacity > 0.02
    }
  })
  return (
    <sprite ref={ref} scale={[height * label.aspect, height, 1]}>
      <spriteMaterial
        ref={mat}
        map={label.texture}
        transparent
        opacity={0}
        depthWrite={false}
        depthTest
        toneMapped={false}
      />
    </sprite>
  )
}

/** node id → degree, for radius + label-importance scaling. */
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
  posRef: MutableRefObject<PosMap>
  dim: boolean
  selected: boolean
  onOver: (n: GraphNode) => void
  onOut: () => void
  onSelect: (n: GraphNode) => void
}) {
  const ref = useRef<THREE.Group>(null)
  const core = useRef<THREE.MeshStandardMaterial>(null)
  useFrame(() => {
    const p = posRef.current.get(node.id)
    if (!p || !ref.current) return
    // Snap to the live sim position (the sim moves smoothly frame-to-frame) so node
    // centers stay locked to their edge endpoints — no lerp lag, no detach.
    ref.current.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0)
    // Scale eases: the bloom-in pop from ~0 → 1, plus the select bump.
    const target = selected ? 1.32 : 1
    const s = ref.current.scale.x + (target - ref.current.scale.x) * 0.15
    ref.current.scale.setScalar(s)
    // Ease opacity/emissive so dim/undim is smooth. Solid, well-lit spheres (no
    // additive halo — that washes to white on the light canvas); the directional
    // light gives them form, a touch of self-emissive keeps the colour saturated.
    if (core.current) {
      const oTarget = dim ? 0.24 : 1
      core.current.opacity += (oTarget - core.current.opacity) * 0.18
      const eTarget = selected ? 0.6 : dim ? 0.06 : 0.2
      core.current.emissiveIntensity += (eTarget - core.current.emissiveIntensity) * 0.18
    }
  })
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
      <mesh>
        <sphereGeometry args={[radius, 32, 32]} />
        <meshStandardMaterial
          ref={core}
          color={color}
          emissive={color}
          emissiveIntensity={0.2}
          roughness={0.42}
          metalness={0.05}
          transparent
          opacity={1}
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
      const c = dimColor(EDGE_COLOR[e.state], (active ? 1 : 0.1) * EDGE_ALPHA[e.state])
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
        <lineDashedMaterial vertexColors transparent dashSize={0.26} gapSize={0.18} linewidth={1} />
      ) : (
        <lineBasicMaterial vertexColors transparent linewidth={1} />
      )}
    </lineSegments>
  )
}

/**
 * KnowledgeGraph3D — one <Canvas> rendering the live causal graph.
 *
 * The camera *fits itself to the graph*: a CameraRig reads the live node spread
 * each frame and eases the orbit target + distance to frame everything — as nodes
 * stream in (the frame grows to keep them all in view) and when a gap is selected
 * (it zooms to that subgraph). This is what makes the graph always on-screen and
 * readable, instead of nodes drifting off into the corners. Gentle idle rotation
 * runs until you touch it, then yields; "Recenter" re-engages the fit.
 *
 * d3-force-3d lays the nodes out in 3D (useForceLayout, bounded so it can't
 * explode); hand-rolled meshes + sprite labels render them; edges stream in and
 * resolve by color. Falls back to a 2D SVG render when WebGL is unavailable.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { GraphEdge, GraphNode } from '@/lib/projectTypes'
import { useForceLayout, type PosMap } from '@/lib/graphLayout'
import { EdgesLayer, KIND_COLOR, NodeLabel, NodeMesh, degreeMap } from './GraphPrimitives'
import { GraphFallback2D } from './GraphFallback2D'

function nodeRadius(deg: number): number {
  return Math.min(0.62, 0.32 + deg * 0.03)
}

/** True if the browser can create a WebGL context (else we fall back to 2D SVG).
 *  Releases the probe context immediately so we don't orphan a GL context per mount. */
function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------- camera -- */

interface OrbitLike {
  target: THREE.Vector3
  update: () => void
  autoRotate: boolean
  addEventListener: (t: string, cb: () => void) => void
  removeEventListener: (t: string, cb: () => void) => void
}

interface Bounds {
  center: THREE.Vector3
  radius: number
}

/** Bounding sphere of the given node ids from live positions (null if none placed). */
function computeBounds(pos: PosMap, ids: Iterable<string>, out: THREE.Vector3): Bounds | null {
  let n = 0
  out.set(0, 0, 0)
  for (const id of ids) {
    const p = pos.get(id)
    if (!p) continue
    out.x += p.x ?? 0
    out.y += p.y ?? 0
    out.z += p.z ?? 0
    n++
  }
  if (n === 0) return null
  out.multiplyScalar(1 / n)
  let r = 0
  for (const id of ids) {
    const p = pos.get(id)
    if (!p) continue
    const dx = (p.x ?? 0) - out.x
    const dy = (p.y ?? 0) - out.y
    const dz = (p.z ?? 0) - out.z
    r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz))
  }
  return { center: out.clone(), radius: Math.max(r, 1.6) }
}

/** Distance at which a sphere of `radius` fits the (perspective) camera's frustum. */
function fitDistance(camera: THREE.PerspectiveCamera, radius: number): number {
  const halfV = ((camera.fov * Math.PI) / 180) / 2
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect)
  const half = Math.min(halfV, halfH)
  const d = (radius * 1.12 + 0.7) / Math.sin(half)
  return Math.max(6, Math.min(46, d))
}

/** Eases the orbit target + distance to frame the graph (or a focused subgraph).
 *  Disengages when the user grabs the view; re-engages on focus change / recenter. */
function CameraRig({
  posRef,
  allIds,
  focusIds,
  focusSig,
  recenterSignal,
}: {
  posRef: MutableRefObject<PosMap>
  allIds: string[]
  focusIds: Set<string> | null
  focusSig: string
  recenterSignal: number
}) {
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const autoFit = useRef(true)
  const idle = useRef(true)
  const tmpCenter = useRef(new THREE.Vector3())
  const tmpOffset = useRef(new THREE.Vector3())

  // User grabs the view → stop fitting + rotating and let them drive.
  useEffect(() => {
    if (!controls) return
    const onStart = () => {
      autoFit.current = false
      idle.current = false
    }
    controls.addEventListener('start', onStart)
    return () => controls.removeEventListener('start', onStart)
  }, [controls])

  // Selecting/clearing a gap re-frames to that subgraph (or back to the whole graph).
  useEffect(() => {
    autoFit.current = true
    idle.current = true
  }, [focusSig, recenterSignal])

  useFrame(() => {
    if (!controls) return
    const ids = focusIds && focusIds.size ? focusIds : allIds
    const b = computeBounds(posRef.current, ids, tmpCenter.current)
    if (b && autoFit.current) {
      controls.target.lerp(b.center, 0.07)
      const want = fitDistance(camera, b.radius)
      const offset = tmpOffset.current.copy(camera.position).sub(controls.target)
      const cur = offset.length() || want
      offset.setLength(cur + (want - cur) * 0.07)
      camera.position.copy(controls.target).add(offset)
    }
    controls.autoRotate = autoFit.current && idle.current
    controls.update()
  })
  return null
}

/* -------------------------------------------------------------------- scene -- */

/** A group that follows a node's live position so an Html tooltip can hang off it. */
function Follower({ id, posRef, children }: { id: string; posRef: MutableRefObject<PosMap>; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  useFrame(() => {
    const p = posRef.current.get(id)
    if (p && ref.current) ref.current.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0)
  })
  return <group ref={ref}>{children}</group>
}

function Scene({
  nodes,
  edges,
  activeNodes,
  activeEdges,
  focusSig,
  recenterSignal,
  onSelectNode,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  activeNodes: Set<string> | null
  activeEdges: Set<string> | null
  focusSig: string
  recenterSignal: number
  onSelectNode: (n: GraphNode | null) => void
}) {
  const { posRef } = useForceLayout(nodes, edges)
  const deg = useMemo(() => degreeMap(nodes, edges), [nodes, edges])
  const [hover, setHover] = useState<GraphNode | null>(null)
  const allIds = useMemo(() => nodes.map((n) => n.id), [nodes])

  // Which labels to show: hubs by default; when a gap is focused, only its subgraph
  // (plus whatever is hovered) — so the graph never turns into a wall of text.
  function labelShown(n: GraphNode): boolean {
    if (hover?.id === n.id) return true
    if (activeNodes) return activeNodes.has(n.id)
    return (deg.get(n.id) ?? 0) >= 3
  }

  return (
    <>
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#ffffff', '#d8d4c8', 0.55]} />
      <directionalLight position={[6, 10, 8]} intensity={0.7} />
      <fog attach="fog" args={['#f4f2ec', 26, 58]} />

      <EdgesLayer edges={edges} posRef={posRef} activeEdges={activeEdges} variant="solid" />
      <EdgesLayer edges={edges} posRef={posRef} activeEdges={activeEdges} variant="dashed" />

      {nodes.map((n) => {
        const r = nodeRadius(deg.get(n.id) ?? 0)
        return (
          <NodeMesh
            key={n.id}
            node={n}
            radius={r}
            color={KIND_COLOR[n.kind]}
            posRef={posRef}
            dim={!!activeNodes && !activeNodes.has(n.id)}
            selected={!!activeNodes && activeNodes.has(n.id)}
            onOver={setHover}
            onOut={() => setHover(null)}
            onSelect={(node) => onSelectNode(node)}
          />
        )
      })}

      {nodes.map((n) => (
        <NodeLabel
          key={`l-${n.id}`}
          node={n}
          radius={nodeRadius(deg.get(n.id) ?? 0)}
          posRef={posRef}
          show={labelShown(n)}
        />
      ))}

      {hover && (
        <Follower id={hover.id} posRef={posRef}>
          <Html position={[0, 0.55, 0]} center distanceFactor={12} pointerEvents="none" zIndexRange={[40, 0]}>
            <div className="pointer-events-none w-max max-w-[230px] rounded-xl border border-black/[0.06] bg-white/92 px-3 py-2 text-left shadow-lg backdrop-blur">
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: KIND_COLOR[hover.kind] }} />
                <span className="text-[13px] font-medium text-ink">{hover.label}</span>
                <span className="ml-auto text-[10.5px] uppercase tracking-wide text-faint">{hover.kind}</span>
              </div>
              {hover.note && <div className="mt-1 text-[11.5px] leading-snug text-muted">{hover.note}</div>}
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-faint">
                <span>
                  {hover.sources.length} source{hover.sources.length === 1 ? '' : 's'}
                </span>
                {hover.contributors.includes('exa') && <span className="text-amber-500">· exa-sourced</span>}
              </div>
            </div>
          </Html>
        </Follower>
      )}

      <OrbitControls
        makeDefault
        enablePan={false}
        autoRotate
        autoRotateSpeed={0.42}
        minDistance={5}
        maxDistance={46}
        enableDamping
        dampingFactor={0.09}
      />
      <CameraRig
        posRef={posRef}
        allIds={allIds}
        focusIds={activeNodes}
        focusSig={focusSig}
        recenterSignal={recenterSignal}
      />
    </>
  )
}

export function KnowledgeGraph3D({
  nodes,
  edges,
  activeNodes = null,
  activeEdges = null,
  recenterSignal = 0,
  onSelectNode = () => {},
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  activeNodes?: Set<string> | null
  activeEdges?: Set<string> | null
  recenterSignal?: number
  onSelectNode?: (n: GraphNode | null) => void
}) {
  const webgl = useMemo(webglAvailable, [])
  // A stable signature of the focused subgraph, so the camera re-frames only when
  // the *selection* changes (not every render).
  const focusSig = useMemo(() => (activeNodes ? [...activeNodes].sort().join(',') : ''), [activeNodes])

  if (!webgl) {
    return (
      <GraphFallback2D
        nodes={nodes}
        edges={edges}
        activeNodes={activeNodes}
        activeEdges={activeEdges}
        onSelectNode={onSelectNode}
      />
    )
  }
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true }}
      camera={{ position: [0, 2, 18], fov: 42 }}
      style={{ width: '100%', height: '100%' }}
      onPointerMissed={() => onSelectNode(null)}
    >
      <color attach="background" args={['#f4f2ec']} />
      <Scene
        nodes={nodes}
        edges={edges}
        activeNodes={activeNodes}
        activeEdges={activeEdges}
        focusSig={focusSig}
        recenterSignal={recenterSignal}
        onSelectNode={onSelectNode}
      />
    </Canvas>
  )
}

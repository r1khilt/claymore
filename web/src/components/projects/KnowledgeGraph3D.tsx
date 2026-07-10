/**
 * KnowledgeGraph3D — one <Canvas> rendering the live causal graph.
 *
 * Reuses the proven r3f stack (Canvas + OrbitControls + useFrame, per Deck3D):
 * d3-force-3d lays the nodes out in 3D (useForceLayout), hand-rolled meshes glow
 * via additive halo sprites, edges stream in and resolve by color. Streaming just
 * appends to the nodes/edges arrays → the sim reheats → nodes bloom into place.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { GraphEdge, GraphNode } from '@/lib/projectTypes'
import { useForceLayout, type PosMap } from '@/lib/graphLayout'
import { EdgesLayer, KIND_COLOR, NodeMesh, degreeMap, makeHaloTexture } from './GraphPrimitives'
import { GraphFallback2D } from './GraphFallback2D'

function nodeRadius(deg: number): number {
  return Math.min(0.62, 0.26 + deg * 0.035)
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
  onSelectNode,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  activeNodes: Set<string> | null
  activeEdges: Set<string> | null
  onSelectNode: (n: GraphNode | null) => void
}) {
  const { posRef } = useForceLayout(nodes, edges)
  const halo = useMemo(() => makeHaloTexture(), [])
  useEffect(() => () => halo.dispose(), [halo])
  const deg = useMemo(() => degreeMap(nodes, edges), [nodes, edges])
  const [hover, setHover] = useState<GraphNode | null>(null)

  return (
    <>
      <ambientLight intensity={0.85} />
      <hemisphereLight args={['#ffffff', '#d8d4c8', 0.5]} />
      <directionalLight position={[6, 10, 8]} intensity={0.7} />

      <EdgesLayer edges={edges} posRef={posRef} activeEdges={activeEdges} variant="solid" />
      <EdgesLayer edges={edges} posRef={posRef} activeEdges={activeEdges} variant="dashed" />

      {nodes.map((n) => (
        <NodeMesh
          key={n.id}
          node={n}
          radius={nodeRadius(deg.get(n.id) ?? 0)}
          color={KIND_COLOR[n.kind]}
          halo={halo}
          posRef={posRef}
          dim={!!activeNodes && !activeNodes.has(n.id)}
          selected={!!activeNodes && activeNodes.has(n.id)}
          onOver={setHover}
          onOut={() => setHover(null)}
          onSelect={(node) => onSelectNode(node)}
        />
      ))}

      {hover && (
        <Follower id={hover.id} posRef={posRef}>
          <Html position={[0, 0.5, 0]} center distanceFactor={11} pointerEvents="none" zIndexRange={[40, 0]}>
            <div className="pointer-events-none w-max max-w-[220px] rounded-xl border border-black/[0.06] bg-white/90 px-3 py-2 text-left shadow-lg backdrop-blur">
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: KIND_COLOR[hover.kind] }} />
                <span className="text-[13px] font-medium text-ink">{hover.label}</span>
                <span className="ml-auto text-[10.5px] uppercase tracking-wide text-faint">{hover.kind}</span>
              </div>
              {hover.note && <div className="mt-1 text-[11.5px] leading-snug text-muted">{hover.note}</div>}
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-faint">
                <span>{hover.sources.length} source{hover.sources.length === 1 ? '' : 's'}</span>
                {hover.contributors.includes('exa') && <span className="text-amber-500">· exa-sourced</span>}
              </div>
            </div>
          </Html>
        </Follower>
      )}

      <OrbitControls
        enablePan={false}
        autoRotate
        autoRotateSpeed={0.5}
        minDistance={9}
        maxDistance={34}
        enableDamping
        dampingFactor={0.08}
      />
    </>
  )
}

export function KnowledgeGraph3D({
  nodes,
  edges,
  activeNodes = null,
  activeEdges = null,
  onSelectNode = () => {},
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  activeNodes?: Set<string> | null
  activeEdges?: Set<string> | null
  onSelectNode?: (n: GraphNode | null) => void
}) {
  const webgl = useMemo(webglAvailable, [])
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
      dpr={[1, 1.75]}
      camera={{ position: [0, 3, 21], fov: 40 }}
      style={{ width: '100%', height: '100%' }}
      onPointerMissed={() => onSelectNode(null)}
    >
      <color attach="background" args={['#f4f2ec']} />
      <Scene
        nodes={nodes}
        edges={edges}
        activeNodes={activeNodes}
        activeEdges={activeEdges}
        onSelectNode={onSelectNode}
      />
    </Canvas>
  )
}

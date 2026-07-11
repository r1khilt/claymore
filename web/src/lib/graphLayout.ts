/**
 * useForceLayout — a bounded, stable d3-force-3d layout for the streaming graph.
 *
 * The layout is a compact ball centered on the origin: a soft *containment*
 * force pulls any node past a radius back toward center, so the graph can never
 * explode off-screen (the failure the old layout had — disconnected method nodes
 * drifting away with only a weak centering force to hold them). New nodes seed
 * near the centroid and reheat the sim, so appends "bloom" into the cluster.
 *
 * Node objects are mutated in place by the sim; the meshes read the live
 * positions each frame from `posRef`. Seeding is deterministic (no Math.random)
 * so a rebuild lays out identically.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type LinkForce,
  type ManyBodyForce,
  type SimNode,
  type Simulation,
} from 'd3-force-3d'
import type { GraphEdge, GraphNode } from './projectTypes'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export type PosMap = Map<string, SimNode>

/** The soft radius the graph is held within (world units). The camera fits to the
 *  actual node spread, so this only bounds the worst case — it isn't the frame. */
const CONTAIN_RADIUS = 7.5

/** Deterministic seed position on a sphere of radius `r` for the i-th of n nodes. */
function seedPos(i: number, n: number, r: number): Vec3 {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const t = i + 1
  const y = 1 - (t / (n + 1)) * 2
  const rad = Math.sqrt(Math.max(0, 1 - y * y))
  return { x: Math.cos(golden * t) * rad * r, y: y * r, z: Math.sin(golden * t) * rad * r }
}

/** A soft spherical wall: nodes beyond `radius` get an inward pull that grows with
 *  how far they've strayed. This is what keeps the graph compact and on-screen. */
function forceContain(radius: number, strength: number) {
  let nodes: SimNode[] = []
  function force(alpha: number) {
    for (const n of nodes) {
      const x = n.x ?? 0
      const y = n.y ?? 0
      const z = n.z ?? 0
      const d = Math.sqrt(x * x + y * y + z * z)
      if (d > radius && d > 1e-6) {
        const k = ((d - radius) / d) * strength * alpha
        n.vx = (n.vx ?? 0) - x * k
        n.vy = (n.vy ?? 0) - y * k
        n.vz = (n.vz ?? 0) - z * k
      }
    }
  }
  force.initialize = (n: SimNode[]) => {
    nodes = n
  }
  return force
}

export function useForceLayout(nodes: GraphNode[], edges: GraphEdge[]): { posRef: MutableRefObject<PosMap> } {
  const simRef = useRef<Simulation | null>(null)
  const posRef = useRef<PosMap>(new Map())

  // Create the simulation once.
  useEffect(() => {
    const sim = forceSimulation<SimNode>([], 3)
      .force('charge', (forceManyBody() as ManyBodyForce).strength(-32).distanceMax(11))
      .force(
        'link',
        forceLink([])
          .id((d: SimNode) => d.id as string)
          .distance(2.3)
          .strength(0.5),
      )
      .force('center', forceCenter(0, 0, 0).strength(0.04))
      .force('contain', forceContain(CONTAIN_RADIUS, 0.9))
      .force('collide', forceCollide(0.95))
      .velocityDecay(0.4)
      .alphaDecay(0.045)
    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [])

  // Reconcile nodes/edges → reheat (the bloom). Runs whenever either array changes.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    const map = posRef.current

    const seen = new Set<string>()
    nodes.forEach((node, i) => {
      seen.add(node.id)
      if (!map.has(node.id)) {
        // Seed near the centroid (small radius) so appended nodes bloom outward
        // from the cluster instead of arriving from a wide shell.
        const p = seedPos(i, Math.max(nodes.length, 8), 2.6)
        map.set(node.id, { id: node.id, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 })
      }
    })
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id)

    const simNodes = nodes.map((n) => map.get(n.id)!).filter(Boolean)
    const ids = new Set(nodes.map((n) => n.id))
    const links = edges
      .filter((e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }))

    sim.nodes(simNodes)
    ;(sim.force('link') as LinkForce).links(links)
    // Warm, not maxed — a gentle bloom on each append, a firmer one on first build.
    sim.alpha(Math.max(sim.alpha(), simNodes.length <= 1 ? 0.9 : 0.62)).restart()
  }, [nodes, edges])

  return { posRef }
}

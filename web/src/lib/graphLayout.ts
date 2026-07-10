/**
 * useForceLayout — d3-force-3d layout for the streaming knowledge graph.
 *
 * Holds one 3D force simulation whose node objects are mutated in place. New
 * nodes seed onto a Fibonacci sphere (deterministic — no Math.random, which the
 * bloom-in relies on being repeatable) and reheat the sim, so appended nodes
 * settle into the cluster: the "bloom into place" motion. Meshes read the live
 * positions each frame in useFrame and lerp toward them (same trick as Deck3D).
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

/** Deterministic seed position on a sphere of radius `r` for the i-th of n nodes. */
function seedPos(i: number, n: number, r: number): Vec3 {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const t = i + 1
  const y = 1 - (t / (n + 1)) * 2
  const rad = Math.sqrt(Math.max(0, 1 - y * y))
  return { x: Math.cos(golden * t) * rad * r, y: y * r, z: Math.sin(golden * t) * rad * r }
}

export function useForceLayout(nodes: GraphNode[], edges: GraphEdge[]): { posRef: MutableRefObject<PosMap> } {
  const simRef = useRef<Simulation | null>(null)
  const posRef = useRef<PosMap>(new Map())

  // Create the simulation once.
  useEffect(() => {
    const sim = forceSimulation<SimNode>([], 3)
      .force('charge', (forceManyBody() as ManyBodyForce).strength(-26).distanceMax(9))
      .force('link', forceLink([]).id((d: SimNode) => d.id as string).distance(2).strength(0.35))
      .force('center', forceCenter(0, 0, 0).strength(0.06))
      .force('collide', forceCollide(0.9))
      .velocityDecay(0.32)
      .alphaDecay(0.03)
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
        const p = seedPos(i, Math.max(nodes.length, 8), 5)
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
    sim.alpha(0.9).restart()
  }, [nodes, edges])

  return { posRef }
}

/**
 * GraphFallback2D — a three-free 2D rendering of the same graph, shown only when
 * WebGL is unavailable (headless QA browsers, locked-down machines) so the graph
 * area is never a blank box. Runs the same d3-force layout in 2 dimensions,
 * ticked synchronously to a settled layout, and draws it as SVG. Static (no
 * bloom), but the causal structure, colors, and gap highlighting all read.
 */
import { useMemo } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimNode } from 'd3-force-3d'
import type { GraphEdge, GraphNode, GraphNodeKind, EdgeState } from '@/lib/projectTypes'

const KIND_COLOR: Record<GraphNodeKind, string> = {
  Gene: '#3f7d5c',
  Protein: '#b4623f',
  Hypothesis: '#c67f3d',
  Method: '#6f7268',
  Result: '#2a543d',
  Assay: '#6ba079',
  Compound: '#dca059',
  Phenotype: '#1c1d18',
}
const EDGE_COLOR: Record<EdgeState, string> = {
  asserted: 'rgba(28,29,24,0.26)',
  predicted: '#dca059',
  contradiction: '#d05a4a',
  confirmed: '#3f7d5c',
  refuted: '#d05a4a',
}

const W = 720
const H = 560

interface Placed {
  id: string
  x: number
  y: number
}

export function GraphFallback2D({
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
  // Settle a 2D layout synchronously (deterministic seed positions → no Math.random).
  const pos = useMemo(() => {
    const sim = forceSimulation<SimNode>(
      nodes.map((n, i) => ({ id: n.id, x: Math.cos(i) * 80, y: Math.sin(i * 1.7) * 80 })),
      2,
    )
      .force('charge', forceManyBody().strength(-120))
      .force('link', forceLink(edges.filter((e) => e.source !== e.target).map((e) => ({ source: e.source, target: e.target }))).id((d: SimNode) => d.id as string).distance(60).strength(0.5))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide(20))
      .stop()
    sim.tick(320)
    const map = new Map<string, Placed>()
    for (const n of sim.nodes()) map.set(n.id as string, { id: n.id as string, x: n.x ?? 0, y: n.y ?? 0 })
    // normalize to viewport
    const xs = [...map.values()].map((p) => p.x)
    const ys = [...map.values()].map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const pad = 48
    const sx = (W - pad * 2) / (maxX - minX || 1)
    const sy = (H - pad * 2) / (maxY - minY || 1)
    const s = Math.min(sx, sy)
    for (const p of map.values()) {
      p.x = pad + (p.x - minX) * s
      p.y = pad + (p.y - minY) * s
    }
    return map
  }, [nodes, edges])

  const deg = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of edges) {
      if (e.source === e.target) continue
      d.set(e.source, (d.get(e.source) ?? 0) + 1)
      d.set(e.target, (d.get(e.target) ?? 0) + 1)
    }
    return d
  }, [edges])

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-full"
      onClick={() => onSelectNode(null)}
      style={{ background: '#f4f2ec' }}
    >
      {edges.map((e) => {
        const a = pos.get(e.source)
        const b = pos.get(e.target)
        if (!a || !b) return null
        const active = !activeEdges || activeEdges.has(e.id)
        return (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={EDGE_COLOR[e.state]}
            strokeWidth={e.state === 'predicted' || e.state === 'confirmed' ? 2 : 1.3}
            strokeDasharray={e.state === 'predicted' ? '5 4' : undefined}
            opacity={active ? 1 : 0.12}
          />
        )
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id)
        if (!p) return null
        const active = !activeNodes || activeNodes.has(n.id)
        const r = Math.min(13, 6 + (deg.get(n.id) ?? 0) * 0.9)
        return (
          <g
            key={n.id}
            transform={`translate(${p.x},${p.y})`}
            opacity={active ? 1 : 0.22}
            style={{ cursor: 'pointer' }}
            onClick={(ev) => {
              ev.stopPropagation()
              onSelectNode(n)
            }}
          >
            <title>{`${n.label} · ${n.kind}`}</title>
            <circle r={r} fill={KIND_COLOR[n.kind]} stroke="#f4f2ec" strokeWidth={1.5} />
            {(deg.get(n.id) ?? 0) >= 3 && (
              <text x={r + 3} y={4} fontSize={10.5} fill="#4a4b44" style={{ pointerEvents: 'none' }}>
                {n.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

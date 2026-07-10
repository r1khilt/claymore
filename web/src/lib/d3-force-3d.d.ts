/**
 * Minimal ambient types for `d3-force-3d` (no @types package is published).
 * Covers only the surface `graphLayout.ts` uses: a 3D force simulation with
 * link / many-body / centering forces. Positions are mutated in place on the
 * node objects (x/y/z, vx/vy/vz), read each frame in useFrame.
 */
declare module 'd3-force-3d' {
  export interface SimNode {
    x?: number
    y?: number
    z?: number
    vx?: number
    vy?: number
    vz?: number
    fx?: number | null
    fy?: number | null
    fz?: number | null
    index?: number
    [key: string]: unknown
  }

  export interface SimLink<N = SimNode> {
    source: string | number | N
    target: string | number | N
    index?: number
    [key: string]: unknown
  }

  export interface Force<N = SimNode> {
    (alpha: number): void
    initialize?(nodes: N[], random?: () => number, dims?: number): void
  }

  export interface LinkForce<N = SimNode, L = SimLink<N>> extends Force<N> {
    links(): L[]
    links(links: L[]): this
    id(fn: (node: N, i: number, nodes: N[]) => string | number): this
    distance(d: number | ((link: L, i: number, links: L[]) => number)): this
    strength(s: number | ((link: L, i: number, links: L[]) => number)): this
  }

  export interface ManyBodyForce<N = SimNode> extends Force<N> {
    strength(s: number | ((node: N, i: number, nodes: N[]) => number)): this
    distanceMax(d: number): this
    distanceMin(d: number): this
    theta(t: number): this
  }

  export interface CenterForce<N = SimNode> extends Force<N> {
    x(x: number): this
    y(y: number): this
    z(z: number): this
    strength(s: number): this
  }

  export interface PositioningForce<N = SimNode> extends Force<N> {
    strength(s: number | ((node: N, i: number, nodes: N[]) => number)): this
    x?(x: number | ((node: N, i: number, nodes: N[]) => number)): this
    y?(y: number | ((node: N, i: number, nodes: N[]) => number)): this
    z?(z: number | ((node: N, i: number, nodes: N[]) => number)): this
  }

  export interface Simulation<N = SimNode, L = SimLink<N>> {
    nodes(): N[]
    nodes(nodes: N[]): this
    alpha(): number
    alpha(a: number): this
    alphaMin(a: number): this
    alphaDecay(a: number): this
    alphaTarget(a: number): this
    velocityDecay(v: number): this
    force(name: string): Force<N> | undefined
    force(name: string, force: Force<N> | null): this
    restart(): this
    stop(): this
    tick(iterations?: number): this
    on(event: string, listener: ((this: Simulation<N, L>) => void) | null): this
    numDimensions(n: number): this
  }

  export function forceSimulation<N = SimNode>(nodes?: N[], numDimensions?: number): Simulation<N>
  export function forceLink<N = SimNode, L = SimLink<N>>(links?: L[]): LinkForce<N, L>
  export function forceManyBody<N = SimNode>(): ManyBodyForce<N>
  export function forceCenter<N = SimNode>(x?: number, y?: number, z?: number): CenterForce<N>
  export function forceX<N = SimNode>(x?: number): PositioningForce<N>
  export function forceY<N = SimNode>(y?: number): PositioningForce<N>
  export function forceZ<N = SimNode>(z?: number): PositioningForce<N>
  export function forceCollide<N = SimNode>(radius?: number | ((node: N) => number)): Force<N>
}

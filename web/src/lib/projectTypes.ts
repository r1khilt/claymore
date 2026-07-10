/**
 * Projects domain types — the "research question + paper corpus → live causal
 * knowledge graph → ranked, cited gaps → run → resolve" feature.
 *
 * Composed on top of the real UI domain types (`Citation`, `Person`,
 * `SourcePlatform`) so a Projects answer is interchangeable with an Ask answer
 * and honest attribution is enforced by the same shapes. See PROJECTS_BUILD.md §5.
 */
import type { Citation, Person } from './types'

/** A paper in a project's corpus. `addedBy` is the honest-attribution seam:
 *  a human contributor OR Exa's sufficiency-gate augmentation — never faked. */
export interface PaperSource {
  id: string
  title: string
  /** the PAPER's authors, e.g. "Frost et al." — distinct from the lab person who added it. */
  paperAuthors: string
  venue?: string
  year?: number
  doi?: string
  url?: string
  addedBy: { kind: 'human'; person: Person } | { kind: 'exa' }
  /** passed the Exa quality filter (peer-reviewed / high-citation). */
  validated?: boolean
}

export type GraphNodeKind =
  | 'Gene'
  | 'Protein'
  | 'Hypothesis'
  | 'Method'
  | 'Result'
  | 'Assay'
  | 'Compound'
  | 'Phenotype'

export interface GraphNode {
  id: string
  label: string
  kind: GraphNodeKind
  /** PaperSource ids this node was extracted from. */
  sources: string[]
  /** Person ids ('exa' allowed) — for honest attribution of who surfaced it. */
  contributors: string[]
  /** 0..1 extraction confidence. */
  confidence: number
  /** precomputed in mock (prod: Voyage) — powers the real link-prediction cosine. */
  embedding?: number[]
  /** a one-line gloss shown in the hover tooltip. */
  note?: string
  /** filled by d3-force-3d at layout time. */
  x?: number
  y?: number
  z?: number
}

export type Relation =
  | 'activates'
  | 'inhibits'
  | 'binds'
  | 'regulates'
  | 'associated'
  | 'method_for'
  | 'measures'

/**
 * asserted     — a solid, cited claim from the corpus.
 * predicted    — a hypothesized (untested) link a gap proposes: dashed gold.
 * contradiction— part of a conflicting pair (activates vs inhibits).
 * confirmed    — a predicted/fragile link a run supported: turns green.
 * refuted      — a predicted/fragile link a run knocked down: cracks red.
 */
export type EdgeState = 'asserted' | 'predicted' | 'contradiction' | 'confirmed' | 'refuted'

export interface GraphEdge {
  id: string
  source: string
  target: string
  relation: Relation
  state: EdgeState
  sources: string[]
  confidence: number
  /** short provenance label for the tooltip, e.g. "von Schimmelmann 2016". */
  note?: string
}

export type GapKind = 'open_triad' | 'link_prediction' | 'contradiction' | 'fragile'

export interface Gap {
  id: string
  kind: GapKind
  /** e.g. "CBX2 → tau aggregation is untested". */
  title: string
  rationale: string
  /** the method line, said out loud: "open A–B–C triad · link-pred 0.81 · via co-IP". */
  method: string
  /** novelty × plausibility × testability, 0..1. */
  score: number
  scoreParts: { novelty: number; plausibility: number; testability: number }
  /** node + edge ids to raise when the gap is selected (dim the rest). */
  subgraph: { nodes: string[]; edges: string[] }
  /** the bridging papers — every gap MUST be cited. */
  citations: Citation[]
  /** the edge whose state a run flips (predicted→confirmed/refuted). For
   *  open_triad / link_prediction this is a NEW predicted edge added to the
   *  graph; for contradiction / fragile it references an existing edge. */
  edge: GraphEdge
  proposedRun: { mode: 'compute' | 'wetlab'; label: string; detail: string }
}

export interface Project {
  id: string
  title: string
  question: string
  createdBy: Person
  sources: PaperSource[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  gaps: Gap[]
}

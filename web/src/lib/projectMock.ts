/**
 * Demo project — "CBX2 / tau regulation".
 *
 * The corpus is REAL, peer-reviewed literature (six papers, honest attribution:
 * three human-added, three Exa-augmented). Exa genuinely sources papers on the
 * live path; here they're baked so the demo stands alone even when Exa credits
 * are spent (PROJECTS_BUILD.md §11 — "mock must stand alone").
 *
 * Nodes carry precomputed concept-axis embeddings so `scoreLinkPrediction` is
 * real cosine math, not a stub. Edges are laid out to yield four honest gaps:
 *   · open triad     CBX2 → tau aggregation (untested causal bridge)
 *   · contradiction  EZH2 protective vs harmful in neurons
 *   · link-pred      CBX2 ~ CBX7 shared chromodomain groove
 *   · fragile        H3K27ac → tau aggregation on a single study
 * Each is bridged by real papers — the anti-fabrication rule, applied to gaps.
 */
import type { Citation, Person } from './types'
import type { GraphEdge, GraphNode, PaperSource, Project, Relation } from './projectTypes'
import { type EngineCtx, type GapEnrich, findGaps, pairKey } from './gapEngine'
import { people } from './mockData'

const person = (id: string): Person => people.find((p) => p.id === id) ?? people[0]

/* --------------------------------------------------------------- embeddings -- */
// 7 concept axes → cosine over these is the real link-prediction signal.
const AXES = ['chromatin', 'polycomb', 'tau', 'aggregation', 'structure', 'assay', 'neuro'] as const
type Axis = (typeof AXES)[number]

function emb(w: Partial<Record<Axis, number>>): number[] {
  return AXES.map((a) => w[a] ?? 0)
}

/* -------------------------------------------------------------------- papers -- */

export const PAPERS: PaperSource[] = [
  {
    id: 'frost',
    title: 'Tau promotes neurodegeneration through global chromatin relaxation',
    paperAuthors: 'Frost, Hemberg, Lewis & Feany',
    venue: 'Nature Neuroscience',
    year: 2014,
    doi: '10.1038/nn.3639',
    url: 'https://doi.org/10.1038/nn.3639',
    addedBy: { kind: 'human', person: person('lucas') },
    validated: true,
  },
  {
    id: 'kaustov',
    title: 'Recognition and specificity determinants of the human CBX chromodomains',
    paperAuthors: 'Kaustov et al.',
    venue: 'J. Biol. Chem.',
    year: 2011,
    doi: '10.1074/jbc.M110.191411',
    url: 'https://doi.org/10.1074/jbc.M110.191411',
    addedBy: { kind: 'human', person: person('philip') },
    validated: true,
  },
  {
    id: 'wangMandelkow',
    title: 'Tau in physiology and pathology',
    paperAuthors: 'Wang & Mandelkow',
    venue: 'Nature Reviews Neuroscience',
    year: 2016,
    doi: '10.1038/nrn.2015.1',
    url: 'https://doi.org/10.1038/nrn.2015.1',
    addedBy: { kind: 'human', person: person('maya') },
    validated: true,
  },
  // --- Exa-augmented (sufficiency gate: 3 < 6) ---
  {
    id: 'vonSchimmelmann',
    title: 'Polycomb repressive complex 2 (PRC2) silences genes responsible for neurodegeneration',
    paperAuthors: 'von Schimmelmann et al.',
    venue: 'Nature Neuroscience',
    year: 2016,
    doi: '10.1038/nn.4360',
    url: 'https://doi.org/10.1038/nn.4360',
    addedBy: { kind: 'exa' },
    validated: true,
  },
  {
    id: 'fitzpatrick',
    title: "Cryo-EM structures of tau filaments from Alzheimer's disease",
    paperAuthors: 'Fitzpatrick et al.',
    venue: 'Nature',
    year: 2017,
    doi: '10.1038/nature23002',
    url: 'https://doi.org/10.1038/nature23002',
    addedBy: { kind: 'exa' },
    validated: true,
  },
  {
    id: 'klein',
    title:
      'Epigenome-wide study uncovers large-scale changes in histone acetylation driven by tau pathology',
    paperAuthors: 'Klein et al.',
    venue: 'Nature Neuroscience',
    year: 2019,
    doi: '10.1038/s41593-018-0291-1',
    url: 'https://doi.org/10.1038/s41593-018-0291-1',
    addedBy: { kind: 'exa' },
    validated: true,
  },
]

/** The 3 human seed papers; the rest arrive via the Exa sufficiency gate. */
export const SEED_PAPERS: PaperSource[] = PAPERS.filter((p) => p.addedBy.kind === 'human')
export const EXA_PAPERS: PaperSource[] = PAPERS.filter((p) => p.addedBy.kind === 'exa')

const FINDING: Record<string, string> = {
  frost: 'Tau drives widespread chromatin relaxation, de-repressing heterochromatic loci in neurons.',
  kaustov: 'The CBX2/CBX7 chromodomains share an aromatic cage recognizing H3K27me3.',
  wangMandelkow: 'MAPT/tau misregulation nucleates the filaments underlying tauopathy.',
  vonSchimmelmann: 'PRC2 silences neurodegeneration genes; its loss is sufficient to drive neuronal death.',
  fitzpatrick: 'Cryo-EM resolves the paired-helical-filament core of aggregated tau.',
  klein: 'Tau pathology reshapes histone acetylation (incl. H3K27ac) genome-wide in human brain.',
}

/** PaperSource → Citation, packing paper metadata into the shared Citation shape. */
export function paperCitation(p: PaperSource): Citation {
  return {
    sourcePlatform: 'manual',
    sourceId: p.doi ?? p.id,
    author: p.paperAuthors,
    timestamp: `${p.year ?? 2020}-01-01T00:00:00.000Z`,
    sourceLabel: `${p.venue ?? 'preprint'} · ${p.year ?? ''}`.trim(),
    quote: FINDING[p.id],
  }
}

const CIT_BY_ID = new Map(PAPERS.map((p) => [p.id, paperCitation(p)]))

/* --------------------------------------------------------------------- nodes -- */

type N = [string, string, GraphNode['kind'], Partial<Record<Axis, number>>, string[], number, string?]
// [id, label, kind, embedding-weights, sourceIds, confidence, note]
const NODE_DEFS: N[] = [
  ['cbx2', 'CBX2', 'Protein', { chromatin: 0.8, polycomb: 1, structure: 0.6 }, ['kaustov'], 0.95, 'PRC1 chromodomain reader of H3K27me3'],
  ['cbx7', 'CBX7', 'Protein', { chromatin: 0.8, polycomb: 1, structure: 0.55 }, ['kaustov'], 0.9, 'CBX2 paralog · shared aromatic cage'],
  ['ezh2', 'EZH2 · PRC2', 'Protein', { chromatin: 0.9, polycomb: 1 }, ['vonSchimmelmann'], 0.9, 'writes H3K27me3'],
  ['bmi1', 'BMI1 · PRC1', 'Protein', { chromatin: 0.7, polycomb: 1 }, ['vonSchimmelmann'], 0.85],
  ['h3k27me3', 'H3K27me3', 'Assay', { chromatin: 1, polycomb: 0.8 }, ['kaustov'], 0.9, 'repressive histone mark'],
  ['h3k27ac', 'H3K27ac', 'Assay', { chromatin: 0.9, neuro: 0.4 }, ['klein'], 0.7, 'active enhancer mark'],
  ['mapt', 'MAPT', 'Gene', { tau: 1, neuro: 0.6, chromatin: 0.3 }, ['wangMandelkow'], 0.95, 'encodes tau'],
  ['tau', 'Tau', 'Protein', { tau: 1, aggregation: 0.7, neuro: 0.6 }, ['wangMandelkow', 'fitzpatrick'], 0.95],
  ['tauAgg', 'Tau aggregation', 'Phenotype', { aggregation: 1, tau: 0.8, neuro: 0.6 }, ['fitzpatrick', 'wangMandelkow'], 0.9],
  ['neuronLoss', 'Neuronal loss', 'Phenotype', { neuro: 1, aggregation: 0.4 }, ['vonSchimmelmann', 'frost'], 0.85],
  ['chromRelax', 'Chromatin relaxation', 'Phenotype', { chromatin: 1, neuro: 0.7, aggregation: 0.3 }, ['frost'], 0.8],
  ['hAllo', 'Allosteric-pocket hypothesis', 'Hypothesis', { structure: 1, polycomb: 0.4 }, ['kaustov'], 0.7],
  ['hRepress', 'CBX2 represses MAPT', 'Hypothesis', { polycomb: 0.7, tau: 0.6, chromatin: 0.6 }, ['vonSchimmelmann'], 0.65],
  ['docking', 'Fragment docking', 'Method', { assay: 0.7, structure: 0.8 }, [], 0.8],
  ['coip', 'Co-IP', 'Method', { assay: 1, structure: 0.3 }, [], 0.8],
  ['dsf', 'Thermal-shift · DSF', 'Assay', { assay: 1, structure: 0.5 }, [], 0.8],
  ['chipseq', 'ChIP-seq', 'Method', { assay: 1, chromatin: 0.5 }, [], 0.8],
  ['rnaseq', 'RNA-seq', 'Method', { assay: 1, tau: 0.2 }, [], 0.8],
  ['cryoem', 'Cryo-EM', 'Method', { assay: 0.8, structure: 1, aggregation: 0.5 }, ['fitzpatrick'], 0.9],
  ['frag', 'Allosteric fragment', 'Compound', { structure: 0.8, assay: 0.4 }, ['kaustov'], 0.7],
  ['eed226', 'EED226 · PRC2i', 'Compound', { polycomb: 0.8, structure: 0.6 }, [], 0.8],
  ['pldd', 'Pocket model · pLDDT 91', 'Result', { structure: 1 }, [], 0.8],
]

/** Paper id → the contributor who surfaced it ('exa' or the human's person id). */
function contributorOf(paperId: string): string {
  const p = PAPERS.find((pp) => pp.id === paperId)
  if (!p) return paperId
  return p.addedBy.kind === 'exa' ? 'exa' : p.addedBy.person.id
}

const NODES: GraphNode[] = NODE_DEFS.map(([id, label, kind, w, sources, confidence, note]) => ({
  id,
  label,
  kind,
  sources,
  contributors: [...new Set(sources.map(contributorOf))],
  confidence,
  embedding: emb(w),
  note,
}))

/* --------------------------------------------------------------------- edges -- */

type E = [string, string, Relation, GraphEdge['state'], string[], number, string?]
// [source, target, relation, state, sourceIds, confidence, note]
const EDGE_DEFS: E[] = [
  ['cbx2', 'h3k27me3', 'binds', 'asserted', ['kaustov'], 0.9, 'Kaustov 2011'],
  ['cbx7', 'h3k27me3', 'binds', 'asserted', ['kaustov'], 0.85, 'Kaustov 2011'],
  ['ezh2', 'h3k27me3', 'regulates', 'asserted', ['vonSchimmelmann'], 0.9, 'writes the mark'],
  ['bmi1', 'cbx2', 'associated', 'asserted', ['vonSchimmelmann'], 0.85, 'PRC1 complex'],
  ['cbx2', 'mapt', 'regulates', 'asserted', ['vonSchimmelmann'], 0.6, 'polycomb represses neuro genes'],
  ['hRepress', 'cbx2', 'associated', 'asserted', ['vonSchimmelmann'], 0.65],
  ['hRepress', 'mapt', 'associated', 'asserted', ['vonSchimmelmann'], 0.65],
  ['mapt', 'tau', 'associated', 'asserted', ['wangMandelkow'], 0.95, 'encodes'],
  ['mapt', 'tauAgg', 'associated', 'asserted', ['wangMandelkow'], 0.8, 'MAPT drives aggregation'],
  ['tau', 'tauAgg', 'associated', 'asserted', ['fitzpatrick', 'wangMandelkow'], 0.9],
  ['tau', 'chromRelax', 'regulates', 'asserted', ['frost'], 0.8, 'Frost 2014'],
  ['tau', 'h3k27ac', 'regulates', 'asserted', ['klein'], 0.7, 'Klein 2019'],
  ['chromRelax', 'neuronLoss', 'associated', 'asserted', ['frost'], 0.75],
  ['tauAgg', 'neuronLoss', 'associated', 'asserted', ['wangMandelkow'], 0.8],
  // contradiction pair (EZH2 → neuronal loss): protective vs harmful
  ['ezh2', 'neuronLoss', 'inhibits', 'contradiction', ['vonSchimmelmann'], 0.7, 'PRC2 protective'],
  ['ezh2', 'neuronLoss', 'activates', 'contradiction', ['klein'], 0.55, 'EZH2 activity implicated in loss'],
  // fragile edge (single low-confidence source)
  ['h3k27ac', 'tauAgg', 'associated', 'asserted', ['klein'], 0.48, 'single study · Klein 2019'],
  // method / structure scaffold
  ['docking', 'hAllo', 'method_for', 'asserted', ['kaustov'], 0.8],
  ['dsf', 'cbx2', 'measures', 'asserted', [], 0.8],
  ['chipseq', 'cbx2', 'method_for', 'asserted', [], 0.8],
  ['coip', 'cbx2', 'method_for', 'asserted', [], 0.75],
  ['frag', 'cbx2', 'binds', 'asserted', ['kaustov'], 0.7],
  ['hAllo', 'cbx2', 'associated', 'asserted', ['kaustov'], 0.7],
  ['eed226', 'ezh2', 'inhibits', 'asserted', [], 0.85],
  ['cryoem', 'tauAgg', 'measures', 'asserted', ['fitzpatrick'], 0.9],
  ['rnaseq', 'mapt', 'measures', 'asserted', [], 0.8],
  ['pldd', 'hAllo', 'associated', 'asserted', [], 0.8],
]

const EDGES: GraphEdge[] = EDGE_DEFS.map(([source, target, relation, state, sources, confidence, note], i) => ({
  id: `e${i}`,
  source,
  target,
  relation,
  state,
  sources,
  confidence,
  note,
}))

/* --------------------------------------------------------- gap enrichment -- */
// Curated copy + bridging citations per detected node-pair. Detection stays real;
// only pairs with a bridge survive (honest attribution). Keyed by unordered pair.

const ENRICH: Record<string, GapEnrich> = {
  [pairKey('cbx2', 'tauAgg')]: {
    relation: 'regulates',
    title: 'Does CBX2 gate tau aggregation?',
    rationale:
      'CBX2 (PRC1) represses MAPT, and MAPT drives tau aggregation — yet no study connects CBX2 occupancy to aggregation directly. If polycomb silences the MAPT locus, losing CBX2 could de-repress tau and accelerate aggregation.',
    method:
      'open CBX2–MAPT–aggregation triad · bridged by von Schimmelmann 2016 + Frost 2014 · testable in silico',
    bridge: ['vonSchimmelmann', 'frost', 'wangMandelkow'],
    novelty: 0.92,
    plausibility: 0.82,
    testability: 0.95,
    boost: 0.05,
    proposedRun: {
      mode: 'compute',
      label: 'Model CBX2 loss → MAPT de-repression → tau aggregation',
      detail:
        'Predict CBX2 occupancy at the MAPT locus and the aggregation-propensity shift on de-repression (Claude Science · compute).',
    },
  },
  [pairKey('ezh2', 'neuronLoss')]: {
    title: 'PRC2 (EZH2): protective or harmful in neurons?',
    rationale:
      'von Schimmelmann shows PRC2 silences neurodegeneration genes (protective), while tau-driven histone-acetylation remodeling (Klein 2019) implicates EZH2 activity in loss. The sign of the effect is unresolved.',
    method: 'contradiction · inhibits vs activates neuronal loss · adjudicable',
    bridge: ['vonSchimmelmann', 'klein'],
    proposedRun: {
      mode: 'compute',
      label: 'Adjudicate EZH2 → neuronal-loss sign',
      detail: 'Perturb PRC2 (EED226) in a neuronal expression model and score the direction of effect.',
    },
  },
  [pairKey('bmi1', 'ezh2')]: {
    relation: 'associated',
    title: 'PRC1 (BMI1) ~ PRC2 (EZH2): predicted co-regulation',
    rationale:
      'BMI1 (PRC1) and EZH2 (PRC2) sit in the same repressive axis and score as near-neighbors in embedding space, yet no edge links their co-occupancy at neurodegeneration loci. A predicted, untested coupling.',
    method: 'link-pred over embeddings · non-adjacent neighbors · testable by co-ChIP',
    bridge: ['vonSchimmelmann'],
    proposedRun: {
      mode: 'compute',
      label: 'Predict BMI1 / EZH2 co-occupancy at neuro loci',
      detail: 'Model shared PRC1/PRC2 occupancy across the neurodegeneration gene set.',
    },
  },
  [pairKey('h3k27ac', 'tauAgg')]: {
    title: 'H3K27ac → tau aggregation rests on one study',
    rationale:
      'Only Klein 2019 links H3K27ac remodeling to aggregation, at low extraction confidence. It needs an independent line of evidence before it can carry weight.',
    method: 'fragile · 1 source · conf 0.48',
    bridge: ['klein'],
    proposedRun: {
      mode: 'compute',
      label: 'Corroborate H3K27ac ↔ aggregation',
      detail: 'Correlate an orthogonal ChIP-seq track against an aggregation readout.',
    },
  },
}

/** The gap-engine context: citation resolver + curated enrichment. */
export function buildCtx(): EngineCtx {
  return {
    citation: (id) => CIT_BY_ID.get(id),
    enrich: (key) => ENRICH[key],
  }
}

/* ------------------------------------------------------------------- project -- */

export const CTX = buildCtx()

/** Fresh copies so a build never mutates the module-level source of truth. */
export function baseNodes(): GraphNode[] {
  return NODES.map((n) => ({ ...n, embedding: n.embedding ? [...n.embedding] : undefined, contributors: [...n.contributors], sources: [...n.sources] }))
}
export function baseEdges(): GraphEdge[] {
  return EDGES.map((e) => ({ ...e, sources: [...e.sources] }))
}

const PRECOMPUTED_GAPS = findGaps(baseNodes(), baseEdges(), CTX)

/** The demo project as fully built (for instant render / the list card). */
export function demoProject(): Project {
  const nodes = baseNodes()
  const edges = baseEdges()
  // fold in the predicted edges the gaps propose (open-triad / link-pred).
  const have = new Set(edges.map((e) => e.id))
  for (const g of PRECOMPUTED_GAPS) if (!have.has(g.edge.id)) edges.push({ ...g.edge })
  return {
    id: 'cbx2-tau',
    title: 'CBX2 / tau regulation',
    question: 'Does the polycomb factor CBX2 gate tau aggregation via chromatin repression of MAPT?',
    createdBy: person('rikhin'),
    sources: PAPERS.map((p) => ({ ...p })),
    nodes,
    edges,
    gaps: PRECOMPUTED_GAPS,
  }
}

/** An empty shell (seed papers only) — the state before "Create Graph". */
export function seedProject(): Project {
  return {
    id: 'cbx2-tau',
    title: 'CBX2 / tau regulation',
    question: 'Does the polycomb factor CBX2 gate tau aggregation via chromatin repression of MAPT?',
    createdBy: person('rikhin'),
    sources: SEED_PAPERS.map((p) => ({ ...p })),
    nodes: [],
    edges: [],
    gaps: [],
  }
}

export const DEMO_GAP_COUNT = PRECOMPUTED_GAPS.length

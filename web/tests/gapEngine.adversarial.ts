/**
 * Adversarial stress test for the gap engine + project mock (per CLAUDE.md §8:
 * "adversarial stress-testing is mandatory, per component, as it's built").
 *
 * Actively tries to break the moat: empty/huge graphs, self-loops, parallel and
 * dangling edges, NaN / zero / mismatched embeddings, uncited gaps (must drop —
 * honest attribution), determinism, and score-bound invariants. Pure-function
 * only (no DOM / three), so it runs headless via esbuild + node.
 *
 *   npx esbuild tests/gapEngine.adversarial.ts --bundle --format=esm --platform=node \
 *     --define:import.meta.env='{"VITE_CLAYMORE_LIVE":"0"}' --outfile=<tmp>/adv.mjs && node <tmp>/adv.mjs
 */
import {
  cosine,
  detectContradictions,
  detectFragile,
  detectOpenTriads,
  findGaps,
  pairKey,
  rankGaps,
  scoreLinkPrediction,
  type EngineCtx,
} from '../src/lib/gapEngine'
import type { GraphEdge, GraphNode, Relation } from '../src/lib/projectTypes'
import { CTX, baseEdges, baseNodes, DEMO_GAP_COUNT } from '../src/lib/projectMock'
import { seedEntities, sufficiencyGate } from '../src/lib/exaAugment'
import { SEED_PAPERS, PAPERS } from '../src/lib/projectMock'

let passed = 0
let failed = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) passed++
  else {
    failed++
    fails.push(msg)
  }
}
function noThrow(fn: () => void, msg: string) {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    fails.push(`${msg} — threw: ${(e as Error).message}`)
  }
}

const EMPTY_CTX: EngineCtx = { citation: () => undefined, enrich: () => undefined }

const node = (id: string, embedding?: number[]): GraphNode => ({
  id,
  label: id,
  kind: 'Protein',
  sources: [],
  contributors: [],
  confidence: 0.8,
  embedding,
})
const edge = (source: string, target: string, relation: Relation, over: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `${source}-${target}-${relation}-${Math.round((over.confidence ?? 0.8) * 100)}`,
  source,
  target,
  relation,
  state: 'asserted',
  sources: [],
  confidence: 0.8,
  ...over,
})

/* 1. empty / degenerate graphs never throw and return [] */
noThrow(() => findGaps([], []), 'findGaps([],[])')
ok(findGaps([], []).length === 0, 'empty graph → no gaps')
ok(findGaps([node('a')], []).length === 0, 'single node → no gaps')
noThrow(() => findGaps([node('a')], [edge('a', 'a', 'binds')]), 'self-loop only')
ok(findGaps([node('a')], [edge('a', 'a', 'binds')]).length === 0, 'self-loop → no gaps')

/* 2. dangling edges (endpoints missing) are ignored, not crashed on */
noThrow(
  () => findGaps([node('a'), node('b')], [edge('a', 'ghost', 'binds'), edge('x', 'y', 'binds')]),
  'dangling endpoints',
)

/* 3. parallel / duplicate edges don't explode or double-count */
noThrow(() => {
  const ns = [node('a'), node('b'), node('c')]
  const es = [
    edge('a', 'b', 'binds'),
    edge('a', 'b', 'binds'),
    edge('b', 'c', 'binds'),
    edge('b', 'c', 'binds'),
  ]
  findGaps(ns, es)
}, 'parallel edges')

/* 4. cosine hardening: NaN / Infinity / zero / mismatched / empty → 0, in [-1,1] */
ok(cosine(undefined, undefined) === 0, 'cosine(undef,undef)=0')
ok(cosine([], []) === 0, 'cosine([],[])=0')
ok(cosine([1, 2], [1]) === 0, 'cosine mismatched len = 0')
ok(cosine([0, 0, 0], [0, 0, 0]) === 0, 'cosine zero-vec = 0 (no div0)')
ok(cosine([NaN, 1], [1, 1]) === 0, 'cosine NaN = 0')
ok(cosine([Infinity, 1], [1, 1]) === 0, 'cosine Inf = 0')
ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9, 'cosine identical = 1')
{
  const c = cosine([1, 0], [0, 1])
  ok(c >= -1 && c <= 1, 'cosine bounded')
}

/* 5. link-pred with garbage embeddings never yields NaN scores */
noThrow(() => {
  const ns = [node('a', [NaN, 1]), node('b', [1, NaN]), node('c', [0, 0]), node('d', undefined)]
  const gaps = scoreLinkPrediction(ns, [], EMPTY_CTX)
  for (const g of gaps) ok(Number.isFinite(g.score), 'link-pred score finite')
}, 'link-pred garbage embeddings')

/* 6. honest attribution: an uncited open triad / contradiction / fragile is DROPPED */
{
  // open triad a-b-c with no enrich → no bridge → dropped
  const ns = [node('a'), node('b'), node('c')]
  const triad = detectOpenTriads(ns, [edge('a', 'b', 'binds'), edge('b', 'c', 'binds')], EMPTY_CTX)
  ok(triad.length === 0, 'uncited open triad dropped (honest attribution)')

  // contradiction with no sources & no enrich → dropped
  const contra = detectContradictions(
    [edge('a', 'b', 'activates'), edge('a', 'b', 'inhibits')],
    EMPTY_CTX,
  )
  ok(contra.length === 0, 'uncited contradiction dropped')

  // fragile with no sources & no enrich → dropped
  const frag = detectFragile([edge('a', 'b', 'binds', { confidence: 0.3, sources: [] })], EMPTY_CTX)
  ok(frag.length === 0, 'uncited fragile dropped')
}

/* 7. contradiction requires genuinely conflicting relations */
ok(
  detectContradictions([edge('a', 'b', 'binds'), edge('a', 'b', 'regulates')], EMPTY_CTX).length === 0,
  'non-conflicting relations → no contradiction',
)

/* 8. huge graph completes, bounded, all scores in [0,1] */
noThrow(() => {
  const N = 500
  const ns: GraphNode[] = []
  const es: GraphEdge[] = []
  for (let i = 0; i < N; i++) ns.push(node(`n${i}`, [Math.sin(i), Math.cos(i), (i % 7) / 7]))
  for (let i = 0; i < N; i++) es.push(edge(`n${i}`, `n${(i + 1) % N}`, 'binds'))
  const gaps = findGaps(ns, es, EMPTY_CTX)
  for (const g of gaps) ok(g.score >= 0 && g.score <= 1, 'huge-graph score bounded')
}, 'huge graph (500 nodes ring)')

/* 9. rankGaps dedupes by node-pair, keeps the strongest, sorts desc */
{
  const mk = (id: string, score: number, s: string, t: string) =>
    ({
      id,
      kind: 'open_triad' as const,
      title: id,
      rationale: '',
      method: '',
      score,
      scoreParts: { novelty: 1, plausibility: 1, testability: 1 },
      subgraph: { nodes: [s, t], edges: [] },
      citations: [],
      edge: edge(s, t, 'binds'),
      proposedRun: { mode: 'compute' as const, label: '', detail: '' },
    })
  const ranked = rankGaps([mk('lo', 0.2, 'a', 'b'), mk('hi', 0.9, 'a', 'b'), mk('mid', 0.5, 'c', 'd')])
  ok(ranked.length === 2, 'rankGaps dedupes by pair')
  ok(ranked[0].score >= ranked[1].score, 'rankGaps sorts desc')
  ok(ranked.find((g) => pairKey('a', 'b') === pairKey(g.edge.source, g.edge.target))?.id === 'hi', 'kept strongest of pair')
}

/* 10. the real demo: exactly the 4 curated gaps, one per kind, all cited, ranked, bounded */
{
  const nodes = baseNodes()
  const edges = baseEdges()
  const gaps = findGaps(nodes, edges, CTX)
  ok(gaps.length === DEMO_GAP_COUNT, `demo gap count matches export (${gaps.length} vs ${DEMO_GAP_COUNT})`)
  ok(gaps.length === 4, `demo has 4 gaps (got ${gaps.length})`)
  const kinds = new Set(gaps.map((g) => g.kind))
  ok(kinds.size === 4, `demo has one gap per kind (got ${[...kinds].join(',')})`)
  ok(gaps[0].kind === 'open_triad', 'headline is the open triad')
  ok(gaps[0].id === 'gap-' + pairKey('cbx2', 'tauAgg'), 'headline is CBX2→tauAgg')
  ok(gaps[0].score === Math.max(...gaps.map((g) => g.score)), 'headline ranks #1')
  for (const g of gaps) {
    ok(g.citations.length > 0, `gap ${g.id} is cited`)
    ok(g.score >= 0 && g.score <= 1, `gap ${g.id} score bounded`)
    ok(Number.isFinite(g.scoreParts.plausibility), `gap ${g.id} plausibility finite`)
    ok(!!g.edge && g.edge.source !== g.edge.target, `gap ${g.id} edge valid`)
    ok(g.subgraph.nodes.length > 0, `gap ${g.id} has subgraph nodes`)
  }
  // link-pred badge/copy consistency: the surviving cbx2|cbx7-style dup is gone;
  // the one link_prediction gap is bmi1~ezh2.
  const lp = gaps.find((g) => g.kind === 'link_prediction')
  ok(!!lp && pairKey('bmi1', 'ezh2') === pairKey(lp!.edge.source, lp!.edge.target), 'link-pred gap is BMI1~EZH2')
}

/* 11. determinism: two runs → identical ids/kinds/scores */
{
  const g1 = findGaps(baseNodes(), baseEdges(), CTX)
  const g2 = findGaps(baseNodes(), baseEdges(), CTX)
  ok(g1.length === g2.length, 'deterministic length')
  ok(
    g1.every((g, i) => g.id === g2[i].id && g.kind === g2[i].kind && Math.abs(g.score - g2[i].score) < 1e-9),
    'deterministic ids/kinds/scores',
  )
  // edge ids must also be stable across calls (pure, no module counter) — idempotency.
  ok(g1.every((g, i) => g.edge.id === g2[i].edge.id), 'deterministic edge ids (no SEQ counter)')
  ok(new Set(g1.map((g) => g.edge.id)).size === g1.length, 'edge ids unique across gaps')
}

/* 12. sufficiency gate + Exa mock augmentation */
{
  const gate = sufficiencyGate(SEED_PAPERS)
  ok(gate.have === 3 && gate.need === 3 && !gate.ok, 'seed corpus is 3/6, needs 3')
  ok(sufficiencyGate(PAPERS).ok, 'full corpus (6) is sufficient')
  ok(seedEntities(SEED_PAPERS).length > 0, 'seed entities extracted for Exa')
}

/* --------------------------------------------------------------------------- */
console.log(`\nADVERSARIAL: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('FAILURES:')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('✓ gap engine survived the adversarial suite')
